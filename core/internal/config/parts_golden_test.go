package config

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// 金标准来自基线 engine/ 里的 tun-options.mjs、node-dns.mjs、config.mjs(见 testdata/gen-configparts-golden.mjs)。

type partsCase struct {
	Fn    string `json:"fn"`
	Args  []any  `json:"args"`
	Want  any    `json:"want"`
	Error string `json:"error"`
}

func arg(a []any, i int) any {
	if i < len(a) {
		return a[i]
	}
	return jsx.Undefined
}

// roundTrip 把 Go 的结果转一遍 JSON,和金标准(也是 JSON)比。
func roundTrip(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func runPart(c partsCase) (any, error) {
	a := c.Args
	switch c.Fn {
	case "tunStack":
		return TunStack(arg(a, 0)), nil
	case "tunMtu":
		return TunMTU(arg(a, 0)), nil
	case "tunTcpMss":
		return TunTCPMss(arg(a, 0)), nil
	case "tunConsts":
		return map[string]any{"name": TunInterfaceName, "stacks": TunStacks, "mtu": []int{TunMTUMin, TunMTUMax}, "mss": []int{TunMSSMin, TunMSSMax}}, nil
	case "validateNodeDns":
		if msg := ValidateNodeDNS(arg(a, 0)); msg != "" {
			return msg, nil
		}
		return nil, nil
	case "normalizeNodeDns":
		conf := NormalizeNodeDNS(arg(a, 0))
		if conf == nil {
			return nil, nil
		}
		m := map[string]any{"url": conf.URL}
		if conf.Bootstrap != "" {
			m["bootstrap"] = conf.Bootstrap
		}
		return m, nil
	case "nodeDnsServers":
		tag, servers, ok := NodeDNSServers(arg(a, 0), arg(a, 1))
		if !ok {
			return nil, nil
		}
		return map[string]any{"tag": tag, "servers": servers}, nil
	case "planNodeDns":
		p := PlanNodeDNS(arg(a, 0))
		return map[string]any{"servers": p.Servers, "bySubscription": p.Entries()}, nil
	case "withNodeResolver":
		ob, isMap := arg(a, 0).(map[string]any)
		if !isMap {
			return arg(a, 0), nil
		}
		tag, _ := arg(a, 1).(string) // 非字符串的 tag(null / 0 / 缺失)都是假值,等同没有
		return WithNodeResolver(ob, tag), nil
	case "configConsts":
		return map[string]any{
			"panelInboundPort": PanelInboundPort, "panelInboundTag": PanelInboundTag, "tunV4Net": TunV4Net, "tunV6Net": TunV6Net,
			"dnsInboundPort": DNSInboundPort, "dnsDirectInboundTag": DNSDirectInboundTag, "dnsDirectInboundPort": DNSDirectInboundPort,
			"dnsmasqOutboundTag": DNSMasqOutboundTag, "defaultRulesetDir": DefaultRulesetDir, "flipDirName": "flip",
		}, nil
	case "flipDirFor":
		return FlipDirFor(arg(a, 0)), nil
	case "findDuplicateTag":
		l, _ := arg(a, 0).([]any)
		if tag, ok := FindDuplicateTag(l); ok {
			return tag, nil
		}
		return nil, nil
	}
	return nil, fmt.Errorf("未知用例 %s", c.Fn)
}

func TestPartsGolden(t *testing.T) {
	b, err := os.ReadFile("../../testdata/configparts_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []partsCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	bad := 0
	for i, c := range g.Cases {
		got, err := runPart(c)
		if err != nil {
			t.Fatalf("#%d %s: %v", i, c.Fn, err)
		}
		if !reflect.DeepEqual(roundTrip(t, got), c.Want) {
			if bad++; bad <= 8 {
				ga, _ := json.Marshal(got)
				wa, _ := json.Marshal(c.Want)
				in, _ := json.Marshal(c.Args)
				t.Errorf("#%d %s(%s)\n  go   %s\n  want %s", i, c.Fn, in, ga, wa)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("%d 条不一致(共 %d 条)", bad, len(g.Cases))
	}
	t.Logf("%d 条金标准全部一致", len(g.Cases))
}
