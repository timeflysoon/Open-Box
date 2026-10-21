package routing

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// classes / forwardPlan / bypassPlan 对照旧版 Node(policyClasses / dnsmasqForwardPlan / nativeBypassPlan)。
func TestPlansGoldenAgainstUpstream(t *testing.T) {
	b, err := os.ReadFile("../../testdata/plans_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	reg := protocol.NewRegistry()
	Register(reg)
	bad := 0
	for i, c := range g.Cases {
		req, _ := json.Marshal(map[string]any{"protocol": 1, "method": c.Fn, "args": c.Args})
		got := call(t, reg, req)
		if !reflect.DeepEqual(got, c.Want) {
			if bad++; bad <= 5 {
				gb, _ := json.Marshal(got)
				wb, _ := json.Marshal(c.Want)
				in, _ := json.Marshal(c.Args)
				t.Errorf("#%d %s 输出不一致\n输入: %s\n有: %s\n要: %s", i, c.Fn, in, gb, wb)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("共 %d 条不一致(总 %d 条)", bad, len(g.Cases))
	}
	t.Logf("%d 条金标准全部一致", len(g.Cases))
}

func mustJSON(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// ignoreProxyClients 是 v0.1.318 快照之后才有的选项,没有明文实现可对照(金标准不含它),这里手写覆盖。
func TestBypassPlanIgnoreProxyClients(t *testing.T) {
	routing := mustJSON(t, `{"policies":[{"name":"国内","default":"direct","rulesets":["geoip-cn"]}],"fallbackDefault":"direct"}`)
	opts := func(extra string) any {
		return mustJSON(t, `{"members":["direct","美国"],"clientRoutes":[{"ip":"192.168.1.5","outbound":"美国"}]`+extra+`}`)
	}
	if p := bypassPlan(routing, opts("")); p.Enabled {
		t.Fatalf("有终端走代理时应关闭: %+v", p)
	}
	if p := bypassPlan(routing, opts(`,"ignoreProxyClients":true`)); !p.Enabled || len(p.Sets) != 1 || p.Sets[0] != "geoip-cn" {
		t.Fatalf("ignoreProxyClients 应跳过终端分流这一项: %+v", p)
	}
}

func TestDnsmasqSafeDomain(t *testing.T) {
	// 期望值由 Node 的 domainToASCII 算出;全角 / ß 等需要 UTS46 映射的写法是已知差异,不在此列
	for in, want := range map[string]string{
		"Example.COM":       "example.com",
		"*.sub.Example.com": "sub.example.com",
		".dot.com":          "dot.com",
		"trail.com.":        "trail.com",
		" padded.org ":      "padded.org",
		"中国.example":        "xn--fiqs8s.example",
		"中文.example":        "xn--fiq228c.example",
		"日本語.jp":            "xn--wgv71a119e.jp",
		"Ünï.cOm":           "xn--n-nga1b.com",
		"bücher.example":    "xn--bcher-kva.example",
		"例え.jp":             "xn--r8jz45g.jp",
		"пример.рф":         "xn--e1afmkfd.xn--p1ai",
		"😀.example":         "xn--e28h.example",
		"-bad.com":          "",
		"bad-.com":          "",
		"a..b":              "",
		"a b.com":           "",
		"with#hash.com":     "",
		"":                  "",
	} {
		got, ok := dnsmasqSafeDomain(in)
		if want == "" && ok || want != "" && (!ok || got != want) {
			t.Errorf("dnsmasqSafeDomain(%q)=(%q,%v) 要 %q", in, got, ok, want)
		}
	}
	if _, ok := dnsmasqSafeDomain(strings.Repeat("a", 64) + ".com"); ok {
		t.Error("标签超过 63 应判不可写")
	}
}
