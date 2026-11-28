package terminaltest

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/timeflysoon/Open-Box/backend/internal/kerneldns"
	"github.com/timeflysoon/Open-Box/backend/internal/nsprobe"
	"github.com/timeflysoon/Open-Box/backend/internal/singbox"
)

// orderProber 在探测时把「probe」记进事件序列,用来核对「先订阅、再探测、再关订阅」。
type orderProber struct {
	*fakeProber
	events *[]string
	mu     *sync.Mutex
}

func (o *orderProber) Probe(ctx context.Context, ns string, req nsprobe.Request) (nsprobe.Result, string, error) {
	o.mu.Lock()
	*o.events = append(*o.events, "probe")
	o.mu.Unlock()
	return o.fakeProber.Probe(ctx, ns, req)
}

type fakeTap struct {
	entries []singbox.LogEntry
	stops   int
	record  func(string)
}

func (f *fakeTap) Stop() []singbox.LogEntry {
	f.stops++
	f.record("stop")
	return f.entries
}

func tapDeps(t *testing.T, entries []singbox.LogEntry, openErr error) (Deps, *fakeTap, *[]string) {
	t.Helper()
	var mu sync.Mutex
	events := []string{}
	rec := func(s string) { mu.Lock(); events = append(events, s); mu.Unlock() }
	tap := &fakeTap{entries: entries, record: rec}
	d := capableDeps(newFakeTerm())
	d.Prober = &orderProber{fakeProber: &fakeProber{res: connectedRes()}, events: &events, mu: &mu}
	d.KernelLog = func(context.Context) (LogTap, error) {
		rec("open")
		if openErr != nil {
			return nil, openErr
		}
		return tap, nil
	}
	d.KernelDNSConfig = func(context.Context) (*kerneldns.Config, error) {
		return &kerneldns.Config{Servers: map[string]kerneldns.Server{"up": {Tag: "up", Type: "udp", Server: "1.1.1.1", Port: 53}}, Final: "up", RuleCount: 2, Outbounds: map[string]string{}}, nil
	}
	return d, tap, &events
}

func logLines(domain string) []singbox.LogEntry {
	return []singbox.LogEntry{
		{Level: "info", Payload: "[77 0ms] inbound/direct[dns-in]: inbound packet connection from 127.0.0.1:5353"},
		{Level: "debug", Payload: "[77 0ms] dns: exchange " + domain + ". IN A"},
		{Level: "debug", Payload: "[77 0ms] dns: match[1] domain_suffix=example.com => route(up)"},
		{Level: "debug", Payload: "[77 21ms] dns: exchanged " + domain + " NOERROR 300"},
		{Level: "info", Payload: "[77 21ms] dns: exchanged A " + domain + ". 300 IN A 93.184.216.34"},
	}
}

func TestRunFillsKernelDNSFromLogs(t *testing.T) {
	d, tap, events := tapDeps(t, logLines("example.com"), nil)
	got := decode(t, serve(t, d, "POST", "/api/openbox/terminal-test", `{"target":"example.com"}`))
	k, _ := got["kernelDns"].(map[string]any)
	srv, _ := k["server"].(map[string]any)
	if k["seen"] != true || k["ruleIndex"] != float64(1) || k["ruleText"] != "domain_suffix=example.com" || k["action"] != "route(up)" ||
		srv["tag"] != "up" || srv["server"] != "1.1.1.1" || k["result"] != "exchanged" || k["rcode"] != "NOERROR" || k["ttl"] != float64(300) || k["ms"] != float64(21) {
		t.Fatalf("kernelDns:%v", got["kernelDns"])
	}
	if got := strings.Join(*events, ","); got != "open,probe,stop" {
		t.Fatalf("要先订阅、再探测、再关订阅:%s", got)
	}
	if tap.stops != 1 {
		t.Fatalf("Stop 次数:%d", tap.stops)
	}
}

func TestRunKernelDNSNotSeen(t *testing.T) {
	d, _, _ := tapDeps(t, logLines("other.test"), nil)
	k, _ := decode(t, serve(t, d, "POST", "/api/openbox/terminal-test", `{"target":"example.com"}`))["kernelDns"].(map[string]any)
	if k["seen"] != false || k["reason"] != "not-seen" {
		t.Fatalf("日志里没有这个域名的查询:%v", k)
	}
}

func TestRunKernelDNSNoLogWhenSubscribeFails(t *testing.T) {
	d, _, events := tapDeps(t, nil, errors.New("控制接口连不上(内核没在运行?)"))
	got := decode(t, serve(t, d, "POST", "/api/openbox/terminal-test", `{"target":"example.com"}`))
	k, _ := got["kernelDns"].(map[string]any)
	if k["seen"] != false || k["reason"] != "no-log" || !strings.Contains(k["error"].(string), "控制接口连不上") {
		t.Fatalf("%v", k)
	}
	if got["exit"] == nil || !strings.Contains(strings.Join(*events, ","), "probe") {
		t.Fatal("订阅不上不影响探测本身")
	}
}

func TestRunKernelDNSAbsentWhenNotApplicable(t *testing.T) {
	// 目标是 IP:没有 DNS 查询,不订阅
	d, _, events := tapDeps(t, logLines("example.com"), nil)
	if _, has := decode(t, serve(t, d, "POST", "/api/openbox/terminal-test", `{"target":"1.1.1.1"}`))["kernelDns"]; has {
		t.Error("目标是 IP 不该有 kernelDns")
	}
	for _, e := range *events {
		if e == "open" {
			t.Error("目标是 IP 不该去订阅内核日志")
		}
	}
	// 没接线
	d = capableDeps(newFakeTerm())
	d.Prober = &fakeProber{res: connectedRes()}
	if _, has := decode(t, serve(t, d, "POST", "/api/openbox/terminal-test", `{"target":"example.com"}`))["kernelDns"]; has {
		t.Error("没接线不该有 kernelDns")
	}
}

func TestRunKernelDNSStopsTapEvenWhenProbeFails(t *testing.T) {
	d, tap, _ := tapDeps(t, nil, nil)
	d.Prober = &fakeProber{err: errors.New("ip netns exec 失败")}
	decode(t, serve(t, d, "POST", "/api/openbox/terminal-test", `{"target":"example.com"}`))
	if tap.stops != 1 {
		t.Fatalf("探测起不来也要关订阅:%d", tap.stops)
	}
}

func TestRunKernelDNSWorksWithoutConfig(t *testing.T) {
	d, _, _ := tapDeps(t, logLines("example.com"), nil)
	d.KernelDNSConfig = func(context.Context) (*kerneldns.Config, error) { return nil, errors.New("读不到配置") }
	k, _ := decode(t, serve(t, d, "POST", "/api/openbox/terminal-test", `{"target":"example.com"}`))["kernelDns"].(map[string]any)
	if k["seen"] != true || k["server"] != nil || k["ruleIndex"] != float64(1) {
		t.Fatalf("读不到配置时日志里认得出的照给,服务器信息留空:%v", k)
	}
}

// 内核是 mihomo 时:日志里没有 sing-box 那种 DNS 追踪记录,应回 unsupported-log,
// 并带上按已部署 mihomo 配置推算的走向与 FakeIP 判断(上游 v0.1.496)。
func TestRunKernelDNSSupportedLogMihomo(t *testing.T) {
	d, _, _ := tapDeps(t, logLines("example.com"), nil)
	d.KernelKind = func(context.Context) string { return "mihomo" }
	d.MihomoKernelDNS = func(_ context.Context, domain, probeIP string) (*kerneldns.Config, error) {
		fake := kerneldns.IsFakeIP(probeIP)
		return &kerneldns.Config{
			MihomoConfigured: map[string]any{"ruleKey": "DOMAIN-SUFFIX,example.com", "fakeIp": false},
			ProbeFakeIP:      &fake,
		}, nil
	}
	k, _ := decode(t, serve(t, d, "POST", "/api/openbox/terminal-test", `{"target":"example.com"}`))["kernelDns"].(map[string]any)
	if k["seen"] != false || k["reason"] != "unsupported-log" {
		t.Fatalf("mihomo 应回 unsupported-log:%v", k)
	}
	cfg, _ := k["configured"].(map[string]any)
	if cfg == nil || cfg["ruleKey"] != "DOMAIN-SUFFIX,example.com" {
		t.Fatalf("configured 没带上:%v", k["configured"])
	}
}

// 没有接 MihomoKernelDNS 时,mihomo 仍要给出 unsupported-log(只报原因,不带推算)。
func TestRunKernelDNSMihomoWithoutProbe(t *testing.T) {
	d, _, _ := tapDeps(t, logLines("example.com"), nil)
	d.KernelKind = func(context.Context) string { return "mihomo" }
	k, _ := decode(t, serve(t, d, "POST", "/api/openbox/terminal-test", `{"target":"example.com"}`))["kernelDns"].(map[string]any)
	if k["reason"] != "unsupported-log" || k["configured"] != nil {
		t.Fatalf("应只报原因:%v", k)
	}
}
