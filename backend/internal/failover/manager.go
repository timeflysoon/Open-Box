package failover

import (
	"context"
	"errors"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/timeflysoon/Open-Box/backend/internal/singbox"
)

// 故障转移管理器:按每个组的检测间隔去测各页签的节点,按结果改父 selector 的当前选择(主备切换)。
// 自己的设计,依据前端 OpenboxFailoverStatus / OpenboxFailoverSettings 的类型和注释、core 的 FailoverState、
// sing-box 官方 Clash API 文档,没有参照上游。
//
// 这里只有「状态机」:对内核的三个动作(读选择、测延迟、改选择)和时钟都是注入的,单元测试用假的。
// 后台循环、接口和状态里的真实数据是下一步(STATUS.md 的「故障转移管理器第三步」)。
//
// 规则(都是保守的:不确定就不动):
//   - 每一轮:每个页签各测一次。单节点页签测那个节点;多节点页签先测内核子组此刻选中的节点,不行再依次测别的,
//     有一个通过就算这个页签可用(urltest 子组会自己挑最优,不用我们管)。「重新检测」把所有节点都测一遍。
//   - 页签可用 → 连续失败轮数清零、记下开始可用的时间;一轮里一个可用节点都没有 → 连续失败轮数加一、health 记为 down。
//   - 只在「确认」后才转移:当前页签连续失败达到 failureThreshold 轮,才切到优先级最高的可用页签;
//     没有可用页签,且已经连续 failureThreshold 轮都没有任何页签可用,才切到拒绝出站。
//   - 切回主用(restorePrimary):比当前页签优先级高的页签,持续可用满 recoveryHoldMs 后切过去。
//   - 当前选择不在计划里(例如重启内核或重新部署后),按优先级选一个可用页签;都不可用就先不动。
//   - 当前在拒绝出站,有页签可用就切回优先级最高的那个。
//   - 不抖动:恢复类的切换(切回主用 / 从拒绝恢复 / 对齐)在上一次切换后的一段时间(检测间隔的一半,至少 5 秒)内不做;
//     因失败确认而做的切换不受这个限制(失败了就该走)。
//   - 内核读不到(没在运行)就不测、不切,等下一轮。
//
// 检测用的地址:core 默认的 http://www.gstatic.com/generate_204 内核不认 http(会悄悄改测别的地址),
// 所以 http:// 一律升成 https://(默认的 gstatic 等价;自定义的 http 地址升级后连不上就如实显示失败)。

// Kernel 是管理器对运行中内核的三个动作。
type Kernel interface {
	// Selected 返回各代理当前选中的出站(代理名 → 它此刻选的);读不到(内核没在运行等)返回 error。
	Selected(ctx context.Context) (map[string]string, error)
	// Delay 让内核经出站 name 访问 testURL(https),返回端到端延迟。
	Delay(ctx context.Context, name, testURL string, timeout time.Duration) (time.Duration, error)
	// Select 把 selector group 的当前选择改成 choice。
	Select(ctx context.Context, group, choice string) error
}

// 取值与前端 latencyReasonText 认得的 kind 一致。
const (
	KindTimeout  = "timeout"
	KindNotFound = "not-found"
	KindError    = "error"
)

// DefaultTestURL 在组没有设检测地址时用。
const DefaultTestURL = "https://www.gstatic.com/generate_204"

const (
	defaultIntervalMs  = 300000 // 与 core 的默认 300s 一致
	minIntervalMs      = 10000  // 再短就是在轰炸节点了
	defaultTimeoutMs   = 5000
	minTimeoutMs       = 500
	maxTimeoutMs       = 30000
	defaultConcurrency = 4
	minCooldown        = 5 * time.Second
	maxErrLen          = 200
)

// NodeResult 对应前端 OpenboxFailoverLaneStatus.nodes 里的一项。
type NodeResult struct {
	OK     *bool   `json:"ok"`
	Delay  *int    `json:"delay"` // 毫秒
	At     int64   `json:"at"`    // 测的时间(毫秒时间戳)
	Reason *string `json:"reason"`
	Kind   *string `json:"kind,omitempty"`
	Error  *string `json:"error,omitempty"`
}

// Round 是正在跑的一轮的进度(前端「检测中 x / y」)。
type Round struct {
	StartedAt int64 `json:"startedAt"`
	Done      int   `json:"done"`
	Total     int   `json:"total"`
}

// SwitchEnd 是一次切换的一端。
type SwitchEnd struct {
	LaneID *string `json:"laneId"` // 拒绝出站或不在计划里的是 null
	Ref    string  `json:"ref"`
}

// Switch 是最近一次主备切换。
type Switch struct {
	At     int64     `json:"at"`
	From   SwitchEnd `json:"from"`
	To     SwitchEnd `json:"to"`
	Reason string    `json:"reason"`
}

// LaneRuntime 是一个页签的运行数据。
type LaneRuntime struct {
	Health     string // up / down / unknown
	FailStreak int
	UpSince    *int64
	KernelNow  *string // 多节点页签:内核子组此刻选中的节点
	Confirmed  *bool   // 多节点页签:那个节点这一轮是否通过
	Nodes      map[string]NodeResult
}

// GroupRuntime 是一个组的运行数据(只读快照)。
type GroupRuntime struct {
	ID             string
	Status         string // pending / ok / backup / failing / reject / unknown
	LastError      string
	CurrentLaneID  *string
	CurrentSince   *int64
	KernelNow      *string
	LastSwitch     *Switch
	LastRoundAt    *int64
	NextRoundAt    *int64
	InFlight       bool
	Round          *Round
	ManualRecheck  bool
	RecheckPending bool
	Lanes          map[string]LaneRuntime // 页签 id → 运行数据
}

// Options 是管理器的依赖和参数。
type Options struct {
	Kernel Kernel
	// Now 是时钟,空 = time.Now。
	Now func() time.Time
	// Concurrency 是同时进行的节点检测数的上限(所有组共用),0 = 4。
	Concurrency int
}

type laneRT struct {
	health     string
	failStreak int
	upSince    time.Time // 零值 = 没有
	kernelNow  string
	confirmed  *bool
	nodes      map[string]NodeResult
}

type groupRT struct {
	g     Group
	lanes map[string]*laneRT

	status        string
	lastError     string
	curLane       string // 当前页签 id;"" = 不是任何页签
	curKnown      bool   // 读到过内核当前选择
	curRef        string
	curSince      time.Time
	lastSwitch    *Switch
	lastSwitchAt  time.Time
	lastRoundAt   time.Time
	nextAt        time.Time
	inFlight      bool
	round         *Round
	manualRecheck bool
	recheckWait   bool
	force         bool // 下一轮把所有节点都测一遍
	noneStreak    int  // 连续几轮没有任何页签可用
	seq           int  // 每次作废进行中的一轮就加一
	cancel        context.CancelFunc
}

// Manager 是故障转移管理器。方法都可以并发调用。
type Manager struct {
	k   Kernel
	now func() time.Time
	sem chan struct{}

	mu     sync.Mutex
	order  []string
	groups map[string]*groupRT
	wg     sync.WaitGroup

	// 探测吞吐采样(对应前端 OpenboxProbeStats.throughputPerSec / backlogMs,上游 v0.1.500 的
	// 「探测压力过高」判据用真实完成速率而不是名额占用):只统计 probeNode 真正测完的次数,
	// 按最近 probeWindow 内的完成数折算每秒;积压 = 此刻想测却排不上队的等待时长(取最近一次的最大值)。
	probeMu       sync.Mutex
	probeDone     []time.Time // 最近 probeWindow 内每个节点的完成时刻
	probeBacklog  time.Duration
	probeBacklogA time.Time
}

// probeWindow 是吞吐统计的滑动窗口。上游按「最近 3 分钟真实探测处理能力」统计,这里取同一个口径。
const probeWindow = 3 * time.Minute

// recordProbeDone 记一次探测完成(带时间戳,自动裁掉窗口外的旧样本)。
func (m *Manager) recordProbeDone() {
	t := m.now()
	m.probeMu.Lock()
	defer m.probeMu.Unlock()
	m.probeDone = append(m.probeDone, t)
	cut := t.Add(-probeWindow)
	i := 0
	for i < len(m.probeDone) && !m.probeDone[i].After(cut) {
		i++
	}
	if i > 0 {
		m.probeDone = append(m.probeDone[:0], m.probeDone[i:]...)
	}
}

// recordBacklog 记一次「等名额」的时长;保留最近 1 分钟内的最大值,过期自动归零。
func (m *Manager) recordBacklog(d time.Duration) {
	t := m.now()
	m.probeMu.Lock()
	defer m.probeMu.Unlock()
	if t.Sub(m.probeBacklogA) > time.Minute {
		m.probeBacklog = 0
	}
	if d > m.probeBacklog {
		m.probeBacklog = d
		m.probeBacklogA = t
	}
}

// ProbeThroughput 返回最近窗口内每秒实际完成的探测数(样本不足时返回 nil,让前端按「未知」处理)。
func (m *Manager) ProbeThroughput() *float64 {
	m.probeMu.Lock()
	defer m.probeMu.Unlock()
	if len(m.probeDone) == 0 {
		return nil
	}
	first := m.probeDone[0]
	span := m.now().Sub(first).Seconds()
	if span < 1 {
		span = 1
	}
	v := float64(len(m.probeDone)) / span
	return &v
}

// ProbeBacklog 返回此刻的探测积压毫秒(最近 1 分钟内的最大等待)。
func (m *Manager) ProbeBacklog() *float64 {
	m.probeMu.Lock()
	defer m.probeMu.Unlock()
	if m.now().Sub(m.probeBacklogA) > time.Minute {
		return nil
	}
	v := float64(m.probeBacklog / time.Millisecond)
	return &v
}

// NewManager 创建管理器(还没有计划,SetPlan 之后才有组)。
func NewManager(o Options) *Manager {
	n := o.Concurrency
	if n <= 0 {
		n = defaultConcurrency
	}
	now := o.Now
	if now == nil {
		now = time.Now
	}
	return &Manager{k: o.Kernel, now: now, sem: make(chan struct{}, n), groups: map[string]*groupRT{}}
}

// SetPlan 换上新的计划(部署成功后调用)。和旧计划完全一样的组保留它的运行数据;
// 新增的、变了的组从头来过,并且马上安排一轮(按新计划对齐内核当前的选择);没有了的组连同进行中的一轮一起丢掉。
func (m *Manager) SetPlan(p Plan) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	old := m.groups
	m.groups = map[string]*groupRT{}
	m.order = m.order[:0]
	for _, g := range p {
		if prev, ok := old[g.ID]; ok && sameGroup(prev.g, g) {
			m.groups[g.ID] = prev
			delete(old, g.ID)
		} else {
			m.groups[g.ID] = newGroupRT(g, now)
		}
		m.order = append(m.order, g.ID)
	}
	for _, gone := range old { // 没有了的组:作废进行中的一轮
		gone.seq++
		if gone.cancel != nil {
			gone.cancel()
		}
	}
}

func newGroupRT(g Group, now time.Time) *groupRT {
	sort.SliceStable(g.Lanes, func(i, j int) bool { return g.Lanes[i].Index < g.Lanes[j].Index })
	gr := &groupRT{g: g, lanes: map[string]*laneRT{}, status: "pending", nextAt: now}
	for _, l := range g.Lanes {
		gr.lanes[l.ID] = &laneRT{health: "unknown", nodes: map[string]NodeResult{}}
	}
	return gr
}

func sameGroup(a, b Group) bool {
	ab, _ := jsonKey(a)
	bb, _ := jsonKey(b)
	return ab == bb
}

// Refresh 让所有组马上重新检测一轮(进行中的一轮作废重来)。POST /failover/refresh 用。
func (m *Manager) Refresh() {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, gr := range m.groups {
		m.invalidate(gr)
		gr.nextAt = now
	}
}

// Recheck 把一个组的所有节点强制全测一遍(进行中的一轮作废)。组不存在返回 false。POST /failover/recheck 用。
func (m *Manager) Recheck(id string) bool {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	gr, ok := m.groups[id]
	if !ok {
		return false
	}
	m.invalidate(gr)
	gr.force, gr.manualRecheck, gr.recheckWait = true, true, true
	gr.nextAt = now
	return true
}

// invalidate 作废进行中的一轮(调用方持锁)。那一轮的 goroutine 结束时发现序号变了就什么也不改。
func (m *Manager) invalidate(gr *groupRT) {
	gr.seq++
	if gr.cancel != nil {
		gr.cancel()
		gr.cancel = nil
	}
	gr.inFlight = false
	gr.round = nil
}

// Wait 等所有已经开始的检测轮结束(测试和优雅退出用)。
func (m *Manager) Wait() { m.wg.Wait() }

// Probes 返回全局测速名额此刻在用几个、一共几个(所有组共用)。
func (m *Manager) Probes() (inUse, limit int) { return len(m.sem), cap(m.sem) }

// Running 说明管理器此刻有没有组在管(有计划)。
func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.groups) > 0
}

// Step 看一遍所有组,到时间的、没在检测的就各开一个 goroutine 去检测一轮,然后立刻返回。后台循环每秒调一次。
func (m *Manager) Step(ctx context.Context) {
	now := m.now()
	type job struct {
		gr    *groupRT
		seq   int
		force bool
	}
	var jobs []job
	m.mu.Lock()
	for _, id := range m.order {
		gr := m.groups[id]
		if gr.inFlight || gr.nextAt.After(now) {
			continue
		}
		gr.inFlight = true
		gr.round = &Round{StartedAt: now.UnixMilli()}
		jobs = append(jobs, job{gr, gr.seq, gr.force})
	}
	m.mu.Unlock()
	for _, j := range jobs {
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			m.runRound(ctx, j.gr, j.seq, j.force)
		}()
	}
}

// Snapshot 返回所有组此刻的运行数据(深拷贝)。
func (m *Manager) Snapshot() []GroupRuntime {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]GroupRuntime, 0, len(m.order))
	for _, id := range m.order {
		gr := m.groups[id]
		rt := GroupRuntime{
			ID: gr.g.ID, Status: gr.status, LastError: gr.lastError, InFlight: gr.inFlight,
			ManualRecheck: gr.manualRecheck, RecheckPending: gr.recheckWait,
			LastRoundAt: ms(gr.lastRoundAt), NextRoundAt: ms(gr.nextAt), CurrentSince: ms(gr.curSince),
			Lanes: map[string]LaneRuntime{},
		}
		if gr.curLane != "" {
			id := gr.curLane
			rt.CurrentLaneID = &id
		}
		if gr.curKnown {
			r := gr.curRef
			rt.KernelNow = &r
		}
		if gr.lastSwitch != nil {
			s := *gr.lastSwitch
			rt.LastSwitch = &s
		}
		if gr.round != nil {
			r := *gr.round
			rt.Round = &r
		}
		for id, l := range gr.lanes {
			lr := LaneRuntime{Health: l.health, FailStreak: l.failStreak, UpSince: ms(l.upSince), Nodes: map[string]NodeResult{}}
			if l.kernelNow != "" {
				v := l.kernelNow
				lr.KernelNow = &v
			}
			if l.confirmed != nil {
				v := *l.confirmed
				lr.Confirmed = &v
			}
			for k, v := range l.nodes {
				lr.Nodes[k] = v
			}
			rt.Lanes[id] = lr
		}
		out = append(out, rt)
	}
	return out
}

func ms(t time.Time) *int64 {
	if t.IsZero() {
		return nil
	}
	v := t.UnixMilli()
	return &v
}

// ---- 一轮检测 ----

type laneProbe struct {
	lane      Lane
	skipped   bool // 没有可测的节点
	passed    bool
	confirmed *bool
	results   map[string]NodeResult
}

func (m *Manager) runRound(parent context.Context, gr *groupRT, seq int, force bool) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	m.mu.Lock()
	if gr.seq != seq {
		m.mu.Unlock()
		return
	}
	gr.cancel = cancel
	g := gr.g
	m.mu.Unlock()

	interval := intervalOf(g.Settings)

	finish := func(apply func()) bool { // 持锁收尾;这一轮已经被作废就什么也不改
		m.mu.Lock()
		defer m.mu.Unlock()
		if gr.seq != seq {
			return false
		}
		if apply != nil {
			apply()
		}
		return true
	}

	sel, err := m.k.Selected(ctx)
	if err != nil {
		finish(func() {
			gr.lastError = "读不到内核的当前状态(内核没在运行?): " + clip(err.Error())
			gr.status = "unknown"
			gr.curKnown = false
			gr.endRound(m.now(), interval, false)
		})
		return
	}

	// 1. 测
	var done, total atomic.Int64
	probes := make([]*laneProbe, len(g.Lanes))
	var wg sync.WaitGroup
	testURL := httpsURL(g.Settings.TestURL)
	timeout := nodeTimeout(g.Settings.TimeoutMs)
	for i, l := range g.Lanes {
		lp := &laneProbe{lane: l, results: map[string]NodeResult{}}
		probes[i] = lp
		nodes := probeOrder(l, sel, force)
		if len(nodes) == 0 {
			lp.skipped = true
			continue
		}
		if force {
			total.Add(int64(len(nodes)))
		} else {
			total.Add(1)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.probeLane(ctx, lp, nodes, sel, force, testURL, timeout, &done, &total, func() {
				finish(func() {
					if gr.round != nil {
						gr.round.Done, gr.round.Total = int(done.Load()), int(total.Load())
					}
				})
			})
		}()
	}
	wg.Wait()
	if ctx.Err() != nil { // 被作废或整体退出:不用半截的结果
		finish(func() {
			if parent.Err() != nil { // 整体退出:只把「在检测」标记去掉
				gr.inFlight, gr.round = false, nil
			}
		})
		return
	}

	// 2. 记结果、定要不要切
	now := m.now()
	var dec *decision
	ok := finish(func() {
		gr.lastError = ""
		gr.applyProbes(probes, sel, now)
		dec = gr.decide(sel, now, interval)
	})
	if !ok {
		return
	}

	// 3. 切(不持锁)
	var selErr error
	if dec != nil {
		selErr = m.k.Select(ctx, g.Tag, dec.toRef)
	}
	finish(func() {
		if dec != nil {
			if selErr != nil {
				gr.lastError = "切换失败: " + clip(selErr.Error())
			} else {
				gr.recordSwitch(dec, now)
			}
		}
		gr.endRound(now, interval, true)
	})
}

// endRound 收尾(持锁):记时间、排下一轮、算组状态。
func (gr *groupRT) endRound(now time.Time, interval time.Duration, kernelOK bool) {
	gr.inFlight, gr.round = false, nil
	gr.lastRoundAt = now
	gr.nextAt = now.Add(interval)
	if !kernelOK {
		// 内核读不到:别等满一个间隔(可能是五分钟)才重试,最多等 30 秒
		gr.nextAt = now.Add(min(interval, 30*time.Second))
	} else {
		gr.force, gr.manualRecheck, gr.recheckWait = false, false, false
	}
	if kernelOK {
		gr.status = gr.computeStatus()
	}
}

func (m *Manager) probeLane(ctx context.Context, lp *laneProbe, nodes []string, sel map[string]string, force bool, testURL string, timeout time.Duration, done, total *atomic.Int64, progress func()) {
	kn := ""
	if lp.lane.SubTag != nil {
		kn = sel[*lp.lane.SubTag]
	}
	one := func(node string) NodeResult {
		r := m.probeNode(ctx, node, testURL, timeout)
		done.Add(1)
		progress()
		return r
	}
	if force { // 全测,并发
		var mu sync.Mutex
		var wg sync.WaitGroup
		for _, n := range nodes {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r := one(n)
				mu.Lock()
				lp.results[n] = r
				if r.OK != nil && *r.OK {
					lp.passed = true
				}
				mu.Unlock()
			}()
		}
		wg.Wait()
	} else { // 先测第一个,不通再依次测别的,有一个通过就停
		for i, n := range nodes {
			if i > 0 {
				total.Add(1)
			}
			r := one(n)
			lp.results[n] = r
			if r.OK != nil && *r.OK {
				lp.passed = true
				break
			}
			if ctx.Err() != nil {
				return
			}
		}
	}
	if lp.lane.SubTag != nil && kn != "" {
		if r, ok := lp.results[kn]; ok && r.OK != nil {
			v := *r.OK
			lp.confirmed = &v
		}
	}
}

// probeNode 占一个并发名额测一个节点。
func (m *Manager) probeNode(ctx context.Context, node, testURL string, timeout time.Duration) NodeResult {
	waitStart := m.now()
	select {
	case m.sem <- struct{}{}:
		m.recordBacklog(m.now().Sub(waitStart))
		defer func() { <-m.sem }()
	case <-ctx.Done():
		return NodeResult{At: m.now().UnixMilli()}
	}
	d, err := m.k.Delay(ctx, node, testURL, timeout)
	m.recordProbeDone()
	r := NodeResult{At: m.now().UnixMilli()}
	if err == nil {
		ok, v := true, int(d/time.Millisecond)
		r.OK, r.Delay = &ok, &v
		return r
	}
	ok := false
	kind := KindError
	switch {
	case singbox.IsTimeout(err) || errors.Is(err, context.DeadlineExceeded):
		kind = KindTimeout
	case singbox.IsNotFound(err):
		kind = KindNotFound
	}
	msg := clip(err.Error())
	r.OK, r.Reason, r.Kind, r.Error = &ok, &kind, &kind, &msg
	return r
}

// probeOrder 是这个页签这一轮要测的节点的顺序:单节点页签就是那一个;多节点页签先测内核子组此刻选中的,再测别的;
// force 时全部都要测。没有可测的(没有有效节点、没落成出站)返回空。
func probeOrder(l Lane, sel map[string]string, force bool) []string {
	if l.Ref == nil || len(l.Valid) == 0 {
		return nil
	}
	if len(l.Valid) == 1 || l.SubTag == nil {
		return []string{l.Valid[0]}
	}
	order := make([]string, 0, len(l.Valid))
	cur := sel[*l.SubTag]
	if cur != "" {
		for _, n := range l.Valid {
			if n == cur {
				order = append(order, n)
				break
			}
		}
	}
	for _, n := range l.Valid {
		if len(order) == 0 || n != order[0] {
			order = append(order, n)
		}
	}
	return order
}

// applyProbes 把一轮的结果记进运行数据(持锁)。
func (gr *groupRT) applyProbes(probes []*laneProbe, sel map[string]string, now time.Time) {
	anyUp := false
	for _, p := range probes {
		l := gr.lanes[p.lane.ID]
		if l == nil {
			continue
		}
		l.kernelNow, l.confirmed = "", nil
		if p.lane.SubTag != nil {
			l.kernelNow = sel[*p.lane.SubTag]
		}
		if p.skipped {
			l.health, l.failStreak, l.upSince = "down", 0, time.Time{}
			continue
		}
		for n, r := range p.results {
			l.nodes[n] = r
		}
		l.confirmed = p.confirmed
		if p.passed {
			l.health, l.failStreak = "up", 0
			if l.upSince.IsZero() {
				l.upSince = now
			}
			anyUp = true
		} else {
			l.health = "down"
			l.failStreak++
			l.upSince = time.Time{}
		}
	}
	if anyUp {
		gr.noneStreak = 0
	} else {
		gr.noneStreak++
	}
}

type decision struct {
	toRef    string
	toLane   string // "" = 拒绝出站
	reason   string
	fromLane string
	fromRef  string
}

// decide 按这一轮的结果定要不要切(持锁)。返回 nil = 不切。
func (gr *groupRT) decide(sel map[string]string, now time.Time, interval time.Duration) *decision {
	g := gr.g
	curRef, known := sel[g.Tag]
	prevLane := gr.curLane
	gr.curKnown, gr.curRef = known && curRef != "", curRef
	gr.curLane = ""
	if gr.curKnown {
		for _, l := range g.Lanes {
			if l.Ref != nil && *l.Ref == curRef {
				gr.curLane = l.ID
				break
			}
		}
	}
	if gr.curLane != prevLane || gr.curSince.IsZero() {
		gr.curSince = now
	}
	if !gr.curKnown {
		return nil // 读不到这个组的当前选择:不动
	}

	threshold := int(max(g.Settings.FailureThreshold, 1))
	cooldown := max(interval/2, minCooldown)
	cool := !gr.lastSwitchAt.IsZero() && now.Sub(gr.lastSwitchAt) < cooldown

	usable := func(l Lane) bool {
		rt := gr.lanes[l.ID]
		return l.Ref != nil && rt != nil && rt.health == "up"
	}
	firstUsable := func(below int) *Lane { // 优先级最高的可用页签;below >= 0 时只看 Index 比它小的
		for i := range g.Lanes {
			l := g.Lanes[i]
			if (below < 0 || l.Index < below) && usable(l) {
				return &l
			}
		}
		return nil
	}
	mk := func(to *Lane, reason string) *decision {
		d := &decision{reason: reason, fromLane: gr.curLane, fromRef: curRef}
		if to == nil {
			d.toRef = g.RejectTag
		} else {
			d.toRef, d.toLane = *to.Ref, to.ID
		}
		return d
	}

	switch {
	case gr.curLane != "": // 当前在某个页签上
		var cur Lane
		for _, l := range g.Lanes {
			if l.ID == gr.curLane {
				cur = l
			}
		}
		rt := gr.lanes[cur.ID]
		if rt != nil && rt.failStreak >= threshold { // 确认没用了:走(不受冷却限制)
			if to := firstUsable(-1); to != nil {
				return mk(to, "当前页签连续 "+itoa(rt.failStreak)+" 轮没有可用节点,转到「"+to.Name+"」")
			}
			if gr.noneStreak >= threshold && curRef != g.RejectTag {
				return mk(nil, "所有页签都连续 "+itoa(gr.noneStreak)+" 轮没有可用节点,转到拒绝出站")
			}
			return nil
		}
		if g.Settings.RestorePrimary && !cool {
			for i := range g.Lanes {
				l := g.Lanes[i]
				if l.Index >= cur.Index {
					break
				}
				lt := gr.lanes[l.ID]
				if usable(l) && lt != nil && !lt.upSince.IsZero() && now.Sub(lt.upSince) >= time.Duration(g.Settings.RecoveryHoldMs)*time.Millisecond {
					return mk(&l, "「"+l.Name+"」已恢复并持续可用,切回")
				}
			}
		}
	case curRef == g.RejectTag: // 在拒绝出站上
		if to := firstUsable(-1); to != nil && !cool {
			return mk(to, "「"+to.Name+"」恢复可用,从拒绝出站切回")
		}
	default: // 当前选择不在计划里
		if to := firstUsable(-1); to != nil && !cool {
			return mk(to, "当前选择不在计划里,按优先级转到「"+to.Name+"」")
		}
		if gr.noneStreak >= threshold && !cool {
			return mk(nil, "当前选择不在计划里,而且所有页签都没有可用节点,转到拒绝出站")
		}
	}
	return nil
}

// recordSwitch 记下一次成功的切换(持锁)。
func (gr *groupRT) recordSwitch(d *decision, now time.Time) {
	from := SwitchEnd{Ref: d.fromRef}
	if d.fromLane != "" {
		id := d.fromLane
		from.LaneID = &id
	}
	to := SwitchEnd{Ref: d.toRef}
	if d.toLane != "" {
		id := d.toLane
		to.LaneID = &id
	}
	gr.lastSwitch = &Switch{At: now.UnixMilli(), From: from, To: to, Reason: d.reason}
	gr.lastSwitchAt = now
	gr.curLane, gr.curRef, gr.curKnown, gr.curSince = d.toLane, d.toRef, true, now
	// 切过去的页签,它的失败计数不带过去的旧账(它刚被确认可用)
}

// computeStatus 算组的总体状态(持锁)。
func (gr *groupRT) computeStatus() string {
	if gr.lastRoundAt.IsZero() {
		return "pending"
	}
	if !gr.curKnown {
		return "unknown"
	}
	if gr.curRef == gr.g.RejectTag {
		return "reject"
	}
	if gr.curLane == "" {
		return "unknown"
	}
	rt := gr.lanes[gr.curLane]
	if rt != nil && rt.failStreak > 0 {
		return "failing"
	}
	for _, l := range gr.g.Lanes {
		if l.ID == gr.curLane && l.Index == 0 {
			return "ok"
		}
	}
	return "backup"
}

func httpsURL(u string) string {
	u = strings.TrimSpace(u)
	if u == "" {
		return DefaultTestURL
	}
	if p, err := url.Parse(u); err == nil && p.Scheme == "http" {
		p.Scheme = "https"
		return p.String()
	}
	return u
}

// intervalOf 是两轮检测之间的间隔:没设用 core 的默认 300 秒,设得太短(< 10 秒)按 10 秒算。
func intervalOf(s Settings) time.Duration {
	v := int64(s.IntervalMs)
	if v <= 0 {
		v = defaultIntervalMs
	}
	return time.Duration(max(v, minIntervalMs)) * time.Millisecond
}

func nodeTimeout(msv int64) time.Duration {
	if msv <= 0 {
		msv = defaultTimeoutMs
	}
	msv = min(max(msv, minTimeoutMs), maxTimeoutMs)
	return time.Duration(msv) * time.Millisecond
}

func clip(s string) string {
	r := []rune(s)
	if len(r) > maxErrLen {
		return string(r[:maxErrLen]) + "…"
	}
	return s
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}
