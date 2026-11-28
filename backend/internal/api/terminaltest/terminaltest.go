// Package terminaltest 实现 /api/openbox/terminal-test:模拟 LAN 终端的真实路由测试。
// 响应形状取自前端 api/openbox.ts 的 OpenboxTerminalCapability / OpenboxTerminalTest,没有参照上游。
//
// GET /capability 只读,检测「能不能做」。POST 现在做到「建虚拟终端并取址」:缺前提时如实回 capable:false
// 和缺的项;具备前提就建命名空间 + veth、DHCP 取址,把结果放进 source 返回;建不起来回 setupError(原因原文)。
// 取址之后接着在虚拟终端的命名空间里发探测(GET / HEAD / TCP / TLS,见 internal/nsprobe):先用 DHCP 给的 DNS 解析域名
// (填 dns),再直连目标(填 exit),所以响应有 source / dns / exit;conntrack 取证(entry、dnsEvidence)、内核 DNS 追踪
// firstLayer 还没做,响应里如实没有这个字段。
// kernelDns(内核日志实录:命中哪条 DNS 规则、交给哪个解析器、经哪个节点、上游回了什么)要订阅内核日志流,订阅在发探测之前开;
// 没接 Deps.KernelLog、或目标是 IP 时不带。
// source.override:DHCP 给的网关不是本机(旁路由场景)时,虚拟终端的网关和 DNS 改指到本机 LAN 口地址再测(见 run)。
// kernel / entry 要在终端那条连接还开着的时候去读内核连接表:Prober 是 HoldProber(出结果后先留着连接)且接了 Deps.Kernel 才做,
// 判法见 entry.go。
// dnsEvidence(conntrack 里这次 DNS 查询的回复方是不是被问的服务器本人)用终端发 DNS 时的 UDP 源端口精确认出这一次的记录;
// 连接跟踪表读不到、或没拿到源端口时不带这个字段(不把「读不到」说成「没有」)。
// dnsForward(dnsmasq 把这次域名查询交给内核 DNS 还是直接问上游)只在有把握时才给:终端问的是本机 LAN 地址上的 dnsmasq、
// 并且本后端的接管生效(见 internal/dnsforward),其它情况不猜、不带这个字段。
// 没有注入 Prober 时只做到建终端和取址(响应不带 dns / exit)。没有注入 Terminal(没接线)时回 501,不碰系统。
// 建好的虚拟终端空闲一段时间(IdleAfter)后自动拆掉,下一次测试再建。
package terminaltest

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/timeflysoon/Open-Box/backend/internal/conntrack"
	"github.com/timeflysoon/Open-Box/backend/internal/dnsforward"
	"github.com/timeflysoon/Open-Box/backend/internal/httpx"
	"github.com/timeflysoon/Open-Box/backend/internal/kerneldns"
	"github.com/timeflysoon/Open-Box/backend/internal/nsprobe"
	"github.com/timeflysoon/Open-Box/backend/internal/routetest"
	"github.com/timeflysoon/Open-Box/backend/internal/singbox"
	"github.com/timeflysoon/Open-Box/backend/internal/system"
)

// Terminal 是虚拟终端的建、取址、拆(*system.VTermNet 实现了它),测试里换假的。
type Terminal interface {
	Ensure(ctx context.Context, lanDevice string) (system.VirtualTerminal, error)
	AcquireDHCP(ctx context.Context, v system.VirtualTerminal) (system.DHCPLease, error)
	// PointGatewayAt 把虚拟终端的默认网关改指到 gateway(旁路由场景用,见 run)。
	PointGatewayAt(ctx context.Context, v system.VirtualTerminal, gateway string) error
	Teardown(ctx context.Context) error
}

// Prober 在虚拟终端的命名空间里发一次探测(*nsprobe.Exec 实现了它),测试里换假的。
// 返回的字符串是探测进程的标准错误(最后一行,可能为空);探测本身失败不是 error,写在 Result 里。
type Prober interface {
	Probe(ctx context.Context, namespace string, req nsprobe.Request) (nsprobe.Result, string, error)
}

// Conntrack 查连接跟踪表(*conntrack.Reader 实现),测试里换假的。读不到返回 error,不能当成「没有记录」。
type Conntrack interface {
	Find(ctx context.Context, q conntrack.Query) ([]conntrack.Entry, error)
}

// Deps 是本分组的依赖。
type Deps struct {
	// Capability 返回此刻的前提检查结果(*system.TerminalProbe 的 Capability),测试里换假的。
	Capability func(ctx context.Context) system.TerminalCapability
	// Terminal 为空 = 没接线,POST 具备前提时回 501。
	Terminal Terminal
	// Prober 为空 = 只建终端和取址,不发探测。
	Prober Prober
	// Conntrack 为空 = 不做 conntrack 取证(不带 dnsEvidence,entry 里也没有 conntrack 证据)。
	Conntrack Conntrack
	// Kernel 取内核当前的连接快照(singbox.KernelConnections)。为空、或 Prober 不是 HoldProber,就不做 kernel / entry。
	Kernel func(ctx context.Context) (singbox.KernelSnapshot, error)
	// Route 问系统路由(*routeget.Getter),判旁路用;为空时不判旁路(entry 里 no-route)。
	Route RouteGetter
	// KernelLog 订阅内核日志流(singbox.OpenKernelLogs)。为空 = 不做 kernelDns。订阅必须在发探测之前开、探测完关,
	// 内核的日志流只给订阅期间产生的行。
	KernelLog func(ctx context.Context) (LogTap, error)
	// KernelDNSConfig 取判断 kernelDns 要用的配置(DNS 服务器、出站类型,以及内核此刻的代理列表——用来补全 chain);
	// 为空或出错时不补服务器信息,日志里能认出的照给。
	KernelDNSConfig func(ctx context.Context) (*kerneldns.Config, error)
	// KernelKind 返回当前内核("sing-box" / "mihomo")。为空或读不到按 sing-box 处理。
	// 内核是 mihomo 时日志里的 DNS 追踪记录格式与 sing-box 不同,截不出内核 DNS 决策,
	// 此时 kernelDns 回 reason=unsupported-log 并尽量附上按已部署 mihomo 配置推算的走向。
	KernelKind func(ctx context.Context) string
	// MihomoKernelDNS 在内核是 mihomo 时给出推算结果(MihomoConfigured / ProbeFakeIP)。
	// 为空时 unsupported-log 只报原因、不带推算走向。
	MihomoKernelDNS func(ctx context.Context, domain string, probeIP string) (*kerneldns.Config, error)
	// DNSForward 返回此刻 dnsmasq 对查询的转发情况(*dnsforward.Service 的 Describe),拿不准返回 nil;为空 = 不填 dnsForward。
	DNSForward func(ctx context.Context) *dnsforward.Result
	// FirstLayer 返回「进内核之前」那一层的情况(NewFirstLayer 接出来的),拿不准返回 nil;为空 = 不填 firstLayer。
	FirstLayer func(ctx context.Context) *FirstLayer
	// IdleAfter 是最后一次测试之后过多久自动拆掉虚拟终端,默认 5 分钟。
	IdleAfter time.Duration
	// Log 可为空。
	Log *slog.Logger
}

const (
	maxBody          = 4 << 10
	defaultIdleAfter = 5 * time.Minute
	idleTeardownTime = 60 * time.Second
)

// Register 把接口挂到 mux 上。
func Register(mux *http.ServeMux, d Deps) {
	h := &handlers{d: d, sem: make(chan struct{}, 1)}
	if h.d.IdleAfter <= 0 {
		h.d.IdleAfter = defaultIdleAfter
	}
	if h.d.Log == nil {
		h.d.Log = slog.New(slog.DiscardHandler)
	}
	mux.HandleFunc("/api/openbox/terminal-test/capability", httpx.Methods(map[string]http.HandlerFunc{http.MethodGet: h.capability}))
	mux.HandleFunc("/api/openbox/terminal-test", httpx.Methods(map[string]http.HandlerFunc{http.MethodPost: h.run}))
}

type handlers struct {
	d Deps
	// sem 让同一时刻只有一次测试在建 / 取址(后面的探测也在它里面);用通道而不是互斥锁,
	// 等的时候请求被取消能马上走。timer 只在持有 sem 时读写。
	sem   chan struct{}
	timer *time.Timer
}

func (h *handlers) cap(ctx context.Context) system.TerminalCapability {
	if h.d.Capability == nil {
		return system.TerminalCapability{Missing: []string{system.MissingRoot}}
	}
	c := h.d.Capability(ctx)
	if c.Missing == nil {
		c.Missing = []string{}
	}
	return c
}

func (h *handlers) capability(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	httpx.JSON(w, http.StatusOK, h.cap(r.Context()))
}

// run 对应前端 testTerminal。请求体与 route-test 一样({ target, port?, method? }),校验也共用 routetest.Parse。
func (h *handlers) run(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	var in routetest.Input
	if !httpx.DecodeJSON(w, r, &in, maxBody) {
		return
	}
	in, err := routetest.Parse(in)
	if err != nil {
		var ie *routetest.InputError
		if errors.As(err, &ie) {
			httpx.Error(w, http.StatusBadRequest, ie.Msg)
		} else {
			httpx.Error(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	c := h.cap(r.Context())
	if !c.OK {
		// 缺前提:前端按 capable:false + missing 提示,不是错误
		httpx.JSON(w, http.StatusOK, map[string]any{"target": in.Target, "mode": "lan", "capable": false, "missing": c.Missing})
		return
	}
	if h.d.Terminal == nil {
		httpx.Error(w, http.StatusNotImplemented, "模拟终端的真实路由测试暂未实现(这台设备具备条件,但建立虚拟终端的部分还没接上)")
		return
	}
	select {
	case h.sem <- struct{}{}:
		defer func() { <-h.sem }()
	case <-r.Context().Done():
		return
	}
	// 测试开始就停掉空闲拆除的计时,做完再重新计时;计时到点时拿不到 sem 就说明有测试在跑,不拆
	h.stopIdle()
	defer h.armIdle()

	start := time.Now()
	out := map[string]any{"target": in.Target, "mode": "lan", "capable": true}
	done := func() {
		out["timing"] = map[string]any{"totalMs": time.Since(start).Milliseconds()}
		httpx.JSON(w, http.StatusOK, out)
	}
	if c.LAN == nil || c.LAN.Device == "" {
		out["setupError"] = "没有找到可以接虚拟终端的 LAN 口"
		done()
		return
	}
	v, err := h.d.Terminal.Ensure(r.Context(), c.LAN.Device)
	if err != nil {
		if r.Context().Err() != nil {
			return // 请求被取消,Ensure 已自己回滚
		}
		out["setupError"] = err.Error()
		done()
		return
	}
	lease, err := h.d.Terminal.AcquireDHCP(r.Context(), v)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		out["setupError"] = err.Error()
		done()
		return
	}
	dns, gateway := lease.DNS, lease.Gateway
	if dns == nil {
		dns = []string{}
	}
	// 旁路由场景:DHCP 给的网关不是本机(主路由在发地址),终端的流量根本不经过本机。这时把虚拟终端的网关和 DNS
	// 改指到本机 LAN 口的地址,模拟「终端手动指向旁路由」,测的才是经本机的那条路。DHCP 没给网关(没有默认路由)
	// 不算旁路由、不改;本机 LAN 地址认不出来也不改。
	override := false
	if lan := net.ParseIP(c.LAN.Address); lan != nil && lan.To4() != nil && gateway != "" && !sameIP(gateway, c.LAN.Address) {
		if err := h.d.Terminal.PointGatewayAt(r.Context(), v, c.LAN.Address); err != nil {
			if r.Context().Err() != nil {
				return
			}
			out["setupError"] = "DHCP 给的网关不是本机,把虚拟终端的网关改指到本机失败:" + err.Error()
			done()
			return
		}
		override, gateway, dns = true, c.LAN.Address, []string{c.LAN.Address}
	}
	src := map[string]any{
		"kind": "virtual", "name": v.Namespace, "ip": lease.IP, "mac": v.MAC, "via": "dhcp",
		"dns": dns, "gateway": gateway, "lanDevice": v.LANDevice, "reused": v.Reused, "dhcpMs": lease.Ms,
	}
	if override {
		src["override"] = map[string]any{"gateway": gateway}
	}
	out["source"] = src
	if h.d.FirstLayer != nil {
		if fl := h.d.FirstLayer(r.Context()); fl != nil {
			out["firstLayer"] = fl
		}
	}
	if h.d.Prober != nil {
		h.probe(r.Context(), out, probeEnv{ns: v.Namespace, dns: dns, lanAddr: c.LAN.Address, lanDevice: c.LAN.Device, srcIP: lease.IP}, in)
		if r.Context().Err() != nil {
			return
		}
	}
	done()
}

// probeEnv 是探测要用的环境:命名空间、DHCP 给的 DNS、本机 LAN 口地址(终端问的 DNS 服务器正是它,才说得上
// 「dnsmasq 怎么转发」;连接被改写成它,才算重定向进了内核)和设备(路由查询的入口接口)、终端自己的地址(取证按它认记录)。
type probeEnv struct {
	ns        string
	dns       []string
	lanAddr   string
	lanDevice string
	srcIP     string
}

// probe 在虚拟终端里发探测,把 dns / exit / kernel / entry(和探测进程的 stderr)放进 out。
func (h *handlers) probe(ctx context.Context, out map[string]any, env probeEnv, in routetest.Input) {
	req := nsprobe.Request{Target: in.Target, Port: in.Port, Method: in.Method, DNS: env.dns}
	var k *kernelLook
	var res nsprobe.Result
	var stderr string
	var err error
	// kernelDns:域名目标才有 DNS 查询。订阅在发探测之前开,探测完留一小会儿等日志送到再关
	var tap LogTap
	var tapErr error
	var logs []singbox.LogEntry
	wantKernelDNS := h.d.KernelLog != nil && net.ParseIP(in.Target) == nil
	if wantKernelDNS {
		tap, tapErr = h.d.KernelLog(ctx)
	}
	stopTap := func() {
		if tap != nil {
			logs = tap.Stop()
			tap = nil
		}
	}
	defer stopTap()
	hp, canHold := h.d.Prober.(HoldProber)
	hold := canHold && h.d.Kernel != nil
	if hold {
		res, stderr, err = hp.ProbeHold(ctx, env.ns, req, func(r nsprobe.Result) { k = h.lookupKernel(ctx, env.srcIP, r) })
	} else {
		res, stderr, err = h.d.Prober.Probe(ctx, env.ns, req)
	}
	if tap != nil {
		select { // 日志经 WebSocket 送过来有一点延迟
		case <-time.After(kernelLogSettle):
		case <-ctx.Done():
		}
		stopTap()
	}
	port := in.Port
	if port == 0 {
		port = 443
	}
	url := routetest.ProbeURL(in.Target, in.Port)
	if in.Method == routetest.MethodTCP {
		url = net.JoinHostPort(in.Target, strconv.Itoa(port))
	}
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		// 探测进程没跑起来:不是线路的问题,原因原文给出
		out["dns"] = map[string]any{"skipped": true}
		out["exit"] = map[string]any{"url": url, "port": port, "method": in.Method, "ok": false, "error": err.Error()}
		if stderr != "" {
			out["probeStderr"] = stderr
		}
		return
	}
	if res.DNS == nil {
		out["dns"] = map[string]any{"skipped": true}
	} else {
		d := map[string]any{"server": res.DNS.Server, "ok": res.DNS.OK, "answers": orEmpty(res.DNS.Answers), "ms": res.DNS.MS}
		if res.DNS.Error != "" {
			d["error"] = res.DNS.Error
		}
		out["dns"] = d
		h.fillDNSForward(ctx, out, res.DNS.Server, env.lanAddr)
		h.fillDNSEvidence(ctx, out, res.DNS, env.srcIP)
		if wantKernelDNS {
			h.fillKernelDNS(ctx, out, logs, tapErr, in.Target)
		}
	}
	ex := map[string]any{"url": url, "port": port, "method": in.Method, "ok": res.OK}
	if res.Status != nil {
		ex["status"] = *res.Status
	}
	if res.MS != nil {
		ex["ms"] = *res.MS
	}
	if res.ConnectMs != nil {
		ex["connectMs"] = *res.ConnectMs
	}
	if res.LocalPort != 0 {
		ex["localPort"] = res.LocalPort
	}
	if res.ConnectTo != "" {
		ex["connectTo"] = res.ConnectTo
	}
	if res.Challenge != "" {
		ex["challenge"] = res.Challenge
	}
	if res.Error != "" {
		ex["error"] = res.Error
	}
	if hold {
		h.fillKernelAndEntry(ctx, out, ex, env, in, res, k)
	}
	out["exit"] = ex
	if stderr != "" {
		out["probeStderr"] = stderr
	}
}

// kernelLogSettle 是探测结束后再等多久才关日志订阅。内核打日志在先、应答在后,这里只是等日志送到。
const kernelLogSettle = 200 * time.Millisecond

// LogTap 是一次开着的内核日志订阅(*singbox.LogTap 实现)。
type LogTap interface {
	Stop() []singbox.LogEntry
}

// fillKernelDNS 从订阅期间收到的内核日志里截这次 DNS 查询的过程(kerneldns.Analyze)。订阅没开成:no-log 并给原因;
// 日志里没有这个域名的查询:not-seen(多半是 dnsmasq 用自己的缓存答了)。
func (h *handlers) fillKernelDNS(ctx context.Context, out map[string]any, logs []singbox.LogEntry, tapErr error, domain string) {
	if tapErr != nil {
		out["kernelDns"] = map[string]any{"seen": false, "reason": "no-log", "error": tapErr.Error()}
		return
	}
	// 内核是 mihomo:日志里没有 sing-box 那种 DNS 追踪记录,截不出决策。
	// 上游 v0.1.496 起把这种情况单独标成 unsupported-log,让界面能说清「不是没查,是这个内核不输出」,
	// 而不是混在 not-seen 里让人以为 dnsmasq 缓存答了。
	if h.d.KernelKind != nil && h.d.KernelKind(ctx) == "mihomo" {
		m := map[string]any{"seen": false, "reason": "unsupported-log"}
		if h.d.MihomoKernelDNS != nil {
			if c, err := h.d.MihomoKernelDNS(ctx, domain, probeIPFrom(out)); err == nil && c != nil {
				// 按已部署 mihomo 配置推算出来的走向(命中哪条 DNS 规则、交给谁),以及探测是否拿到 FakeIP 占位地址
				if c.MihomoConfigured != nil {
					m["configured"] = c.MihomoConfigured
				}
				if c.ProbeFakeIP != nil {
					m["probeFakeIp"] = *c.ProbeFakeIP
				}
			}
		}
		out["kernelDns"] = m
		return
	}
	var cfg *kerneldns.Config
	if h.d.KernelDNSConfig != nil {
		if c, err := h.d.KernelDNSConfig(ctx); err == nil {
			cfg = c
		}
	}
	out["kernelDns"] = kerneldns.Analyze(logs, domain, cfg).Map()
}

// fillDNSEvidence 查连接跟踪表里终端这次 DNS 查询的记录:用 nsprobe 报的 UDP 源端口精确认出,
// 回复方是不是被问的服务器(不是就是被改写 / 劫持了)。读不到表、没拿到源端口都不带字段,不猜。
func (h *handlers) fillDNSEvidence(ctx context.Context, out map[string]any, d *nsprobe.DNSResult, srcIP string) {
	if h.d.Conntrack == nil || len(d.LocalPorts) == 0 || srcIP == "" {
		return
	}
	host, port := splitDNSServer(d.Server)
	if host == "" {
		return
	}
	entries, err := h.d.Conntrack.Find(ctx, conntrack.Query{Proto: "udp", Src: srcIP, Dst: host, Dport: port})
	if err != nil {
		if ctx.Err() == nil {
			h.d.Log.Debug("读连接跟踪表失败,不给 dnsEvidence", "err", err)
		}
		return
	}
	ev := conntrack.AnalyzeDNS(entries, host, port, d.LocalPorts)
	out["dnsEvidence"] = map[string]any{"flows": ev.Flows, "hijacked": ev.Hijacked, "answeredBy": ev.AnsweredBy, "line": ev.Line}
}

// splitDNSServer 把 DHCP 给的服务器("ip" 或 "ip:端口")拆成地址和端口(默认 53);认不出地址返回空串。
func splitDNSServer(s string) (string, int) {
	host, p, err := net.SplitHostPort(s)
	if err != nil {
		host, p = s, "53"
	}
	if net.ParseIP(host) == nil {
		return "", 0
	}
	n, err := strconv.Atoi(p)
	if err != nil || n < 1 || n > 65535 {
		return "", 0
	}
	return host, n
}

// fillDNSForward 在终端问的是本机 LAN 地址时(DHCP 把路由器自己发给了终端),按 Deps.DNSForward 补 dnsForward。
// DHCP 给的是别的 DNS(旁路由、公共 DNS)时 dnsmasq 根本没参与,不说。
func (h *handlers) fillDNSForward(ctx context.Context, out map[string]any, server, lanAddr string) {
	if h.d.DNSForward == nil {
		return
	}
	a, b := net.ParseIP(server), net.ParseIP(lanAddr)
	if a == nil || b == nil || !a.Equal(b) {
		return
	}
	f := h.d.DNSForward(ctx)
	if f == nil {
		return
	}
	m := map[string]any{"forward": f.Forward, "plan": f.Plan}
	if f.To != "" {
		m["to"] = f.To
	}
	out["dnsForward"] = m
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// stopIdle / armIdle 管「空闲后自动拆除」的计时,调用时都要持有 sem。
func (h *handlers) stopIdle() {
	if h.timer != nil {
		h.timer.Stop()
		h.timer = nil
	}
}

func (h *handlers) armIdle() {
	h.timer = time.AfterFunc(h.d.IdleAfter, h.idleTeardown)
}

// idleTeardown 在空闲到点时拆掉虚拟终端。拿不到 sem(有测试正在跑)就什么都不做:那次测试结束时会重新计时。
// 拆失败只记日志,记账保留,下次测试或下次启动会再拆(见 system.VTermNet)。
func (h *handlers) idleTeardown() {
	select {
	case h.sem <- struct{}{}:
	default:
		return
	}
	defer func() { <-h.sem }()
	h.timer = nil
	ctx, cancel := context.WithTimeout(context.Background(), idleTeardownTime)
	defer cancel()
	if err := h.d.Terminal.Teardown(ctx); err != nil {
		h.d.Log.Warn("空闲后拆除虚拟终端失败,记账已保留,之后会再试", "err", err)
		return
	}
	h.d.Log.Info("虚拟终端空闲,已拆除")
}

// probeIPFrom 从已经算好的 dns 结果里取第一个解析地址,给 mihomo 的 FakeIP 判断用。
// 取不到(跳过 / 没有应答 / 失败)返回空串。
func probeIPFrom(out map[string]any) string {
	d, _ := out["dns"].(map[string]any)
	if d == nil {
		return ""
	}
	list, _ := d["answers"].([]string)
	if len(list) == 0 {
		if raw, ok := d["answers"].([]any); ok && len(raw) > 0 {
			s, _ := raw[0].(string)
			return s
		}
		return ""
	}
	return list[0]
}
