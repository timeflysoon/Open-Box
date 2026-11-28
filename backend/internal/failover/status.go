package failover

import (
	"context"
	"encoding/json"

	"github.com/timeflysoon/Open-Box/backend/internal/singbox"
)

// 下面几个类型的字段名和取值对应前端 OpenboxFailoverStatus / OpenboxFailoverGroupStatus / OpenboxFailoverLaneStatus。

// LaneStatus 是一个页签的运行状态。
type LaneStatus struct {
	ID         string                     `json:"id"`
	Name       string                     `json:"name"`
	Index      int                        `json:"index"`
	Role       string                     `json:"role"` // primary / backup
	Mode       string                     `json:"mode"`
	Manual     bool                       `json:"manual,omitempty"`
	Ref        *string                    `json:"ref"`
	SubTag     *string                    `json:"subTag"`
	Members    []string                   `json:"members"`
	Valid      []string                   `json:"valid"`
	Health     string                     `json:"health"` // up / down / unknown
	FailStreak int                        `json:"failStreak"`
	UpSince    *int64                     `json:"upSince"`
	KernelNow  *string                    `json:"kernelNow"`
	Confirmed  *bool                      `json:"confirmed"`
	Nodes      map[string]json.RawMessage `json:"nodes"`
}

// GroupStatus 是一个故障转移组的运行状态。
type GroupStatus struct {
	ID            string   `json:"id"`
	Tag           string   `json:"tag"`
	Status        string   `json:"status"` // pending / ok / backup / failing / reject / unknown
	Paused        string   `json:"paused"`
	LastError     string   `json:"lastError"`
	RejectTag     string   `json:"rejectTag"`
	CurrentLaneID *string  `json:"currentLaneId"`
	CurrentSince  *int64   `json:"currentSince"`
	KernelNow     *string  `json:"kernelNow"`
	LastSwitch    any      `json:"lastSwitch"`
	LastRoundAt   *int64   `json:"lastRoundAt"`
	NextRoundAt   *int64   `json:"nextRoundAt"`
	LaneOrder     []string `json:"laneOrder"`
	Reorder       any      `json:"reorder"`
	InFlight      bool     `json:"inFlight"`
	Round         any      `json:"round"`
	// ManualRecheck:点了「重新检测」还没做完;RecheckPending:已受理、还没轮到测
	ManualRecheck  bool         `json:"manualRecheck"`
	RecheckPending bool         `json:"recheckPending"`
	Settings       Settings     `json:"settings"`
	Lanes          []LaneStatus `json:"lanes"`
}

// ProbeStats 对应前端 OpenboxProbeStats:面板全局测速名额此刻的情况。
// Interactive 是用户点出来的测速(与后台排队分开);Background 是后台在测的节点数;
// ThroughputPerS / BacklogMs 是最近窗口内真实完成的吞吐与此刻的排队积压,上游 v0.1.500 的
// 「探测压力过高」判据就用这两个值(而不是名额占用率)。
type ProbeStats struct {
	Interactive    int      `json:"interactive"`
	Background     int      `json:"background"` // 此刻在测的节点数
	Limit          int      `json:"limit"`
	ThroughputPerS *float64 `json:"throughputPerSec"`
	DemandPerSec   *float64 `json:"demandPerSec"` // 按各组间隔,每秒要测几个(上限:每个页签的有效节点都测)
	BacklogMs      *float64 `json:"backlogMs"`    // 此刻探测排队积压(毫秒);没有积压或样本过期时省略
}

// Runtime 是检测管理器给状态接口的数据(*Manager 满足)。
type Runtime interface {
	Running() bool
	Snapshot() []GroupRuntime
	Probes() (inUse, limit int)
}

// ProbeSampler 是可选能力:管理器能给出真实吞吐与积压时由 BuildStatusWith 填进 ProbeStats。
type ProbeSampler interface {
	ProbeThroughput() *float64
	ProbeBacklog() *float64
}

// Status 是 GET /api/openbox/failover/status 的响应。
type Status struct {
	Version *string       `json:"version"`
	Paused  string        `json:"paused"`
	Running bool          `json:"running"`
	Probes  any           `json:"probes"`
	Groups  []GroupStatus `json:"groups"`
}

// KernelFunc 读内核当前的代理列表(*singbox.KernelProxy 的名字、类型、当前选择)。读不到返回 error。
type KernelFunc func(ctx context.Context) ([]singbox.KernelProxy, error)

// BuildStatus 是没有检测管理器的状态:running 为 false、页签 health 恒为 unknown、没有节点检测结果。
func BuildStatus(ctx context.Context, plan Plan, kernel KernelFunc) Status {
	return BuildStatusWith(ctx, plan, kernel, nil)
}

// BuildStatusWith 用计划加内核此刻的选择,再叠上检测管理器的运行数据算出状态(rt 为空 = 没有管理器)。
// kernel 为空或读不到时,各组 status 是 unknown(管理器有数据时用管理器的)、kernelNow 为 null,其余照计划如实给。
// 「当前用的是哪个页签」以这次读到的内核选择为准(比管理器上一轮记的新);读不到内核时才退回管理器记的。
// 状态以管理器的为准(它多了 pending / failing 两种),管理器说 unknown 而这次读到了内核时用按内核选择算出的那个。
func BuildStatusWith(ctx context.Context, plan Plan, kernel KernelFunc, rt Runtime) Status {
	now := map[string]string{} // 代理名 → 它当前选中的
	haveKernel := false
	if kernel != nil {
		if ps, err := kernel(ctx); err == nil {
			haveKernel = true
			for _, p := range ps {
				now[p.Name] = p.Now
			}
		}
	}
	out := Status{Groups: make([]GroupStatus, 0, len(plan)), Paused: ""}
	runtime := map[string]GroupRuntime{}
	if rt != nil {
		out.Running = rt.Running()
		for _, r := range rt.Snapshot() {
			runtime[r.ID] = r
		}
		inUse, limit := rt.Probes()
		ps := ProbeStats{Background: inUse, Limit: limit}
		demand := 0.0
		for _, g := range plan {
			nodes := 0
			for _, l := range g.Lanes {
				nodes += len(l.Valid)
			}
			demand += float64(nodes) / intervalOf(g.Settings).Seconds()
		}
		ps.DemandPerSec = &demand
		if s, ok := rt.(ProbeSampler); ok {
			ps.ThroughputPerS = s.ProbeThroughput()
			ps.BacklogMs = s.ProbeBacklog()
		}
		out.Probes = ps
	}
	for _, g := range plan {
		gs := GroupStatus{
			ID: g.ID, Tag: g.Tag, Status: "unknown", RejectTag: g.RejectTag, Settings: g.Settings,
			LaneOrder: make([]string, 0, len(g.Lanes)), Lanes: make([]LaneStatus, 0, len(g.Lanes)),
		}
		cur := ""
		if haveKernel {
			if n, ok := now[g.Tag]; ok && n != "" {
				cur = n
				gs.KernelNow = &cur
			}
		}
		for _, l := range g.Lanes {
			gs.LaneOrder = append(gs.LaneOrder, l.ID)
			ls := LaneStatus{
				ID: l.ID, Name: l.Name, Index: l.Index, Role: "backup", Mode: l.Mode, Manual: l.Mode == "selector",
				Ref: l.Ref, SubTag: l.SubTag, Members: l.Members, Valid: l.Valid, Health: "unknown",
				Nodes: map[string]json.RawMessage{},
			}
			if l.Index == 0 {
				ls.Role = "primary"
			}
			for _, m := range l.Valid {
				ls.Nodes[m] = json.RawMessage("null")
			}
			if l.SubTag != nil && haveKernel {
				if n, ok := now[*l.SubTag]; ok && n != "" {
					v := n
					ls.KernelNow = &v
				}
			}
			if cur != "" && l.Ref != nil && *l.Ref == cur {
				id := l.ID
				gs.CurrentLaneID = &id
				if l.Index == 0 {
					gs.Status = "ok"
				} else {
					gs.Status = "backup"
				}
			}
			gs.Lanes = append(gs.Lanes, ls)
		}
		if cur != "" && cur == g.RejectTag {
			gs.Status = "reject"
		}
		if r, ok := runtime[g.ID]; ok {
			overlay(&gs, r, haveKernel)
		}
		out.Groups = append(out.Groups, gs)
	}
	return out
}

// overlay 把管理器的一个组的运行数据叠到按计划和内核算出的状态上。
func overlay(gs *GroupStatus, r GroupRuntime, haveKernel bool) {
	if r.Status != "" && r.Status != "unknown" {
		gs.Status = r.Status
	}
	gs.LastError = r.LastError
	gs.CurrentSince = r.CurrentSince
	if r.LastSwitch != nil {
		gs.LastSwitch = r.LastSwitch
	}
	gs.LastRoundAt, gs.NextRoundAt = r.LastRoundAt, r.NextRoundAt
	gs.InFlight, gs.ManualRecheck, gs.RecheckPending = r.InFlight, r.ManualRecheck, r.RecheckPending
	if r.Round != nil {
		gs.Round = r.Round
	}
	if !haveKernel { // 这次读不到内核:用管理器上一轮记下的
		gs.CurrentLaneID, gs.KernelNow = r.CurrentLaneID, r.KernelNow
	}
	for i := range gs.Lanes {
		ls := &gs.Lanes[i]
		lr, ok := r.Lanes[ls.ID]
		if !ok {
			continue
		}
		ls.Health, ls.FailStreak, ls.UpSince, ls.Confirmed = lr.Health, lr.FailStreak, lr.UpSince, lr.Confirmed
		if ls.KernelNow == nil {
			ls.KernelNow = lr.KernelNow
		}
		for _, m := range ls.Valid {
			if nr, ok := lr.Nodes[m]; ok {
				if b, err := json.Marshal(nr); err == nil {
					ls.Nodes[m] = b
				}
			}
		}
	}
}
