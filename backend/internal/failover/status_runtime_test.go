package failover

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/timeflysoon/Open-Box/backend/internal/singbox"
)

type fakeRT struct {
	running bool
	groups  []GroupRuntime
}

func (f fakeRT) Running() bool            { return f.running }
func (f fakeRT) Snapshot() []GroupRuntime { return f.groups }
func (f fakeRT) Probes() (int, int)       { return 3, 4 }

func kernelAt(now string) KernelFunc {
	return func(context.Context) ([]singbox.KernelProxy, error) {
		return []singbox.KernelProxy{
			{Name: "故障转移", Type: "Selector", Now: now},
			{Name: "__fo:g1:l2", Type: "URLTest", Now: "JP-02"},
		}, nil
	}
}

func kernelDown(context.Context) ([]singbox.KernelProxy, error) {
	return nil, errors.New("没有在运行")
}

func i64(v int64) *int64 { return &v }
func bp(v bool) *bool    { return &v }
func ip(v int) *int      { return &v }

func rtGroup() GroupRuntime {
	k := "上一轮记的"
	return GroupRuntime{
		ID: "g1", Status: "failing", LastError: "出错了", CurrentLaneID: sp("l1"), CurrentSince: i64(111), KernelNow: &k,
		LastSwitch:  &Switch{At: 5, From: SwitchEnd{LaneID: sp("l1"), Ref: "HK-01"}, To: SwitchEnd{LaneID: sp("l2"), Ref: "__fo:g1:l2"}, Reason: "failure"},
		LastRoundAt: i64(200), NextRoundAt: i64(500), InFlight: true, Round: &Round{StartedAt: 190, Done: 1, Total: 3},
		ManualRecheck: true, RecheckPending: true,
		Lanes: map[string]LaneRuntime{
			"l1": {Health: "down", FailStreak: 2, Nodes: map[string]NodeResult{"HK-01": {OK: bp(false), At: 10, Reason: sp("timeout"), Kind: sp("timeout"), Error: sp("控制接口返回 504")}}},
			"l2": {Health: "up", UpSince: i64(300), KernelNow: sp("JP-01"), Confirmed: bp(true),
				Nodes: map[string]NodeResult{"JP-01": {OK: bp(true), Delay: ip(88), At: 20}}},
		},
	}
}

func TestBuildStatusWithOverlaysRuntime(t *testing.T) {
	st := BuildStatusWith(context.Background(), planOf(t), kernelAt("HK-01"), fakeRT{running: true, groups: []GroupRuntime{rtGroup()}})
	if !st.Running {
		t.Fatal("running")
	}
	ps, ok := st.Probes.(ProbeStats)
	if !ok || ps.Background != 3 || ps.Limit != 4 || ps.Interactive != 0 || ps.ThroughputPerS != nil || ps.DemandPerSec == nil {
		t.Fatalf("%+v", st.Probes)
	}
	// 需求 = 有效节点数 / 间隔秒数:HK-01、JP-01、JP-02 三个 / 300 秒
	if got := *ps.DemandPerSec; got < 0.0099 || got > 0.0101 {
		t.Fatalf("demandPerSec=%v", got)
	}
	g := st.Groups[0]
	if g.Status != "failing" || g.LastError != "出错了" || !g.InFlight || !g.ManualRecheck || !g.RecheckPending {
		t.Fatalf("%+v", g)
	}
	if g.CurrentSince == nil || *g.CurrentSince != 111 || g.LastRoundAt == nil || *g.LastRoundAt != 200 || g.NextRoundAt == nil || *g.NextRoundAt != 500 {
		t.Fatalf("%+v", g)
	}
	if g.LastSwitch == nil || g.Round == nil {
		t.Fatalf("lastSwitch / round 要带上: %+v", g)
	}
	// 「当前用的是哪个页签」以这次读到的内核为准:内核此刻选 HK-01 → l1,kernelNow 是内核的不是管理器上一轮记的
	if g.CurrentLaneID == nil || *g.CurrentLaneID != "l1" || g.KernelNow == nil || *g.KernelNow != "HK-01" {
		t.Fatalf("%+v %v", g.CurrentLaneID, g.KernelNow)
	}
	l1, l2 := g.Lanes[0], g.Lanes[1]
	if l1.Health != "down" || l1.FailStreak != 2 || l2.Health != "up" || l2.UpSince == nil || *l2.UpSince != 300 || l2.Confirmed == nil || !*l2.Confirmed {
		t.Fatalf("%+v %+v", l1, l2)
	}
	// 多节点页签的 kernelNow 以内核此刻的子组选择为准(JP-02),不是管理器上一轮记的(JP-01)
	if l2.KernelNow == nil || *l2.KernelNow != "JP-02" {
		t.Fatalf("%v", l2.KernelNow)
	}
	// 节点检测结果:测过的是对象(带 kind / error),没测过的有效节点是 null
	var n1 map[string]any
	if err := json.Unmarshal(l1.Nodes["HK-01"], &n1); err != nil || n1["ok"] != false || n1["kind"] != "timeout" || n1["error"] != "控制接口返回 504" {
		t.Fatalf("%s %v", l1.Nodes["HK-01"], err)
	}
	if string(l2.Nodes["JP-02"]) != "null" || !strings.Contains(string(l2.Nodes["JP-01"]), `"delay":88`) {
		t.Fatalf("%s %s", l2.Nodes["JP-02"], l2.Nodes["JP-01"])
	}
}

func TestBuildStatusWithStatusRules(t *testing.T) {
	plan := planOf(t)
	// 管理器说 pending(还没测过第一轮):照说,不被内核选择冲掉
	g := rtGroup()
	g.Status = "pending"
	if st := BuildStatusWith(context.Background(), plan, kernelAt("HK-01"), fakeRT{groups: []GroupRuntime{g}}); st.Groups[0].Status != "pending" {
		t.Fatalf("%s", st.Groups[0].Status)
	}
	// 管理器说 unknown(它没读到内核)、这次读到了:用按内核算出的(主用在用 → ok)
	g.Status = "unknown"
	if st := BuildStatusWith(context.Background(), plan, kernelAt("HK-01"), fakeRT{groups: []GroupRuntime{g}}); st.Groups[0].Status != "ok" {
		t.Fatalf("%s", st.Groups[0].Status)
	}
	// 内核选了拒绝出站 → reject(管理器没说别的时);管理器说 reject 也一样
	g.Status = "reject"
	if st := BuildStatusWith(context.Background(), plan, kernelAt("__fo:reject"), fakeRT{groups: []GroupRuntime{g}}); st.Groups[0].Status != "reject" {
		t.Fatalf("%s", st.Groups[0].Status)
	}
}

func TestBuildStatusWithKernelUnreadableFallsBackToRuntime(t *testing.T) {
	g := rtGroup()
	g.Status = "backup"
	st := BuildStatusWith(context.Background(), planOf(t), kernelDown, fakeRT{groups: []GroupRuntime{g}})
	got := st.Groups[0]
	if got.Status != "backup" || got.CurrentLaneID == nil || *got.CurrentLaneID != "l1" || got.KernelNow == nil || *got.KernelNow != "上一轮记的" {
		t.Fatalf("读不到内核时用管理器上一轮记的: %+v", got)
	}
	// 管理器也没有这个组的数据:unknown,其余照计划
	st = BuildStatusWith(context.Background(), planOf(t), kernelDown, fakeRT{running: true})
	if st.Groups[0].Status != "unknown" || st.Groups[0].KernelNow != nil || !st.Running {
		t.Fatalf("%+v", st.Groups[0])
	}
}

func TestBuildStatusWithoutRuntimeIsUnchanged(t *testing.T) {
	a := BuildStatus(context.Background(), planOf(t), kernelAt("HK-01"))
	b := BuildStatusWith(context.Background(), planOf(t), kernelAt("HK-01"), nil)
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) || a.Running || a.Probes != nil {
		t.Fatalf("没有管理器时两种调用要一致、probes 为 null:\n%s\n%s", ja, jb)
	}
}

func TestStatusJSONShapeWithRuntime(t *testing.T) {
	st := BuildStatusWith(context.Background(), planOf(t), kernelAt("HK-01"), fakeRT{running: true, groups: []GroupRuntime{{ID: "g1", Status: "ok"}}})
	b, _ := json.Marshal(st)
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	g := raw["groups"].([]any)[0].(map[string]any)
	for _, k := range []string{"manualRecheck", "recheckPending", "inFlight", "lastSwitch", "round", "lastRoundAt", "nextRoundAt", "lastError"} {
		if _, ok := g[k]; !ok {
			t.Errorf("缺少 %s", k)
		}
	}
	if g["lastSwitch"] != nil || g["round"] != nil {
		t.Errorf("没有切换 / 没在测时是 null: %v %v", g["lastSwitch"], g["round"])
	}
	probes := raw["probes"].(map[string]any)
	for _, k := range []string{"interactive", "background", "limit", "throughputPerSec", "demandPerSec"} {
		if _, ok := probes[k]; !ok {
			t.Errorf("probes 缺少 %s", k)
		}
	}
	if probes["throughputPerSec"] != nil {
		t.Errorf("吞吐没统计,应为 null")
	}
}

// fakeSamplerRT 在 fakeRT 之上再实现 ProbeSampler,验证吞吐与积压会被填进 ProbeStats。
type fakeSamplerRT struct{ fakeRT }

func (fakeSamplerRT) ProbeThroughput() *float64 { v := 1.5; return &v }
func (fakeSamplerRT) ProbeBacklog() *float64    { v := 4200.0; return &v }

// 上游 v0.1.500 的「探测压力过高」判据读的是真实吞吐与积压;管理器能给出时状态里必须有,
// 给不出时保持省略(null),前端按「未知」处理。
func TestStatusProbesThroughputAndBacklog(t *testing.T) {
	plan := Plan{{ID: "g1", Tag: "故障转移", Settings: Settings{Interval: "300s"},
		Lanes: []Lane{{ID: "l1", Index: 0, Valid: []string{"A"}}}}}

	got := BuildStatusWith(context.Background(), plan, kernelAt("A"), fakeSamplerRT{fakeRT{running: true}})
	ps, ok := got.Probes.(ProbeStats)
	if !ok {
		t.Fatalf("Probes 类型不对: %T", got.Probes)
	}
	if ps.ThroughputPerS == nil || *ps.ThroughputPerS != 1.5 {
		t.Fatalf("throughputPerSec 没填: %+v", ps.ThroughputPerS)
	}
	if ps.BacklogMs == nil || *ps.BacklogMs != 4200 {
		t.Fatalf("backlogMs 没填: %+v", ps.BacklogMs)
	}

	// 不支持采样的管理器:两个字段都应为空(JSON 里省略),不能凭空给 0
	plain := BuildStatusWith(context.Background(), plan, kernelAt("A"), fakeRT{running: true})
	ps2 := plain.Probes.(ProbeStats)
	if ps2.ThroughputPerS != nil || ps2.BacklogMs != nil {
		t.Fatalf("不支持采样时不应有值: %+v %+v", ps2.ThroughputPerS, ps2.BacklogMs)
	}
}

// 吞吐按最近窗口内的完成次数折算;没有样本时返回 nil 而不是 0。
func TestManagerProbeSampling(t *testing.T) {
	now := time.Date(2026, 11, 29, 10, 0, 0, 0, time.UTC)
	m := NewManager(Options{Kernel: &noopKernel{}, Now: func() time.Time { return now }})
	if m.ProbeThroughput() != nil || m.ProbeBacklog() != nil {
		t.Fatal("没有样本时不该有值")
	}
	for i := 0; i < 10; i++ {
		m.recordProbeDone()
		now = now.Add(100 * time.Millisecond)
	}
	tp := m.ProbeThroughput()
	if tp == nil || *tp <= 0 {
		t.Fatalf("吞吐应为正: %v", tp)
	}
	m.recordBacklog(2500 * time.Millisecond)
	if b := m.ProbeBacklog(); b == nil || *b != 2500 {
		t.Fatalf("积压应为 2500ms: %v", b)
	}
	// 积压样本超过 1 分钟自动作废
	now = now.Add(2 * time.Minute)
	if m.ProbeBacklog() != nil {
		t.Fatal("过期积压应返回 nil")
	}
}

// noopKernel 是测试用的空内核。
type noopKernel struct{}

func (noopKernel) Selected(context.Context) (map[string]string, error) { return nil, nil }
func (noopKernel) Delay(context.Context, string, string, time.Duration) (time.Duration, error) {
	return 0, nil
}
func (noopKernel) Select(context.Context, string, string) error { return nil }
