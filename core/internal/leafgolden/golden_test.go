// Package leafgolden 只有测试:把 configDetailed 的几个叶子模块
// (ipx / clientroutes / servers / directhosts / dnsrewrite)统一对照旧版 Node 的金标准。
package leafgolden

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/timeflysoon/Open-Box/core/internal/clientroutes"
	"github.com/timeflysoon/Open-Box/core/internal/directhosts"
	"github.com/timeflysoon/Open-Box/core/internal/dnsrewrite"
	"github.com/timeflysoon/Open-Box/core/internal/ipx"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
	"github.com/timeflysoon/Open-Box/core/internal/servers"
)

type goldenCase struct {
	Fn    string `json:"fn"`
	Args  []any  `json:"args"`
	Want  any    `json:"want"`
	Error string `json:"error"`
}

func arg(args []any, i int) any {
	if i < len(args) {
		return args[i]
	}
	return jsx.Undefined
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}

func call(fn string, a []any) (any, error) {
	switch fn {
	case "isIPv4":
		return ipx.IsIPv4(a[0].(string)), nil
	case "isIPv6":
		return ipx.IsIPv6(a[0].(string)), nil
	case "isIP":
		return float64(ipx.IsIP(a[0].(string))), nil
	case "subtractCidrs":
		return ipx.SubtractCidrs(list(a[0]), list(a[1])), nil
	case "cidrsOverlap":
		return ipx.CidrsOverlap(a[0], a[1]), nil
	case "cidrContains":
		return ipx.CidrContains(a[0], a[1]), nil
	case "normalizeCidr":
		return clientroutes.NormalizeCidr(arg(a, 0)), nil
	case "normalizeMac":
		return clientroutes.NormalizeMac(arg(a, 0)), nil
	case "normalizeClientRoutes":
		return clientroutes.NormalizeClientRoutes(arg(a, 0), jsx.Get(arg(a, 1), "directTag")), nil
	case "buildServerInbounds":
		return servers.BuildServerInbounds(arg(a, 0), arg(a, 1)), nil
	case "collectDirectHosts":
		return directhosts.Collect(arg(a, 0), arg(a, 1)), nil
	case "bypassSources":
		return clientroutes.BypassSources(arg(a, 0)), nil
	case "admitSources":
		return clientroutes.AdmitSources(arg(a, 0)), nil
	case "admitDnsDirect":
		return clientroutes.AdmitDNSDirect(arg(a, 0), arg(a, 1)), nil
	case "guardTerminalRules":
		return clientroutes.GuardTerminalRules(arg(a, 0), arg(a, 1)), nil
	case "isSharedCdnCidr":
		return directhosts.IsSharedCdnCidr(arg(a, 0)), nil
	case "nodeDirectRuleSets":
		d, _ := arg(a, 0).(string)
		return directhosts.NodeDirectRuleSets(d), nil
	case "nodeDirectConsts":
		return map[string]any{
			"domainTag": directhosts.NodeDirectDomainTag, "ipTag": directhosts.NodeDirectIPTag,
			"placeholder": map[string]any{"domain": directhosts.NodeDirectPlaceholderDomain, "cidr": directhosts.NodeDirectPlaceholderCidr},
			"cdn":         directhosts.SharedCdnCidrs,
		}, nil
	case "normalizeDnsRewrite":
		return dnsrewrite.NormalizeDnsRewrite(arg(a, 0)), nil
	case "rewriteDnsRules":
		return dnsrewrite.RewriteDnsRules(dnsrewrite.NormalizeDnsRewrite(arg(a, 0)).Rules), nil
	case "normalizeDomain":
		return dnsrewrite.NormalizeDomain(arg(a, 0), jsx.Get(arg(a, 1), "allowWildcard") == true), nil
	case "normalizeRule":
		idx, _ := arg(a, 1).(float64)
		return dnsrewrite.NormalizeRuleForTest(arg(a, 0), int(idx)), nil
	case "rewriteDnsServer":
		return dnsrewrite.RewriteDnsServer(), nil
	}
	return nil, fmt.Errorf("未知 fn %s", fn)
}

// 金标准来自上游 engine 基线(见 testdata/gen-leaf-golden.mjs)。
func TestLeafGolden(t *testing.T) {
	b, err := os.ReadFile("../../testdata/leaf_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	bad, byFn := 0, map[string]int{}
	for i, c := range g.Cases {
		if c.Error != "" {
			t.Fatalf("#%d %s 基线报错 %q,这批语料不该有报错", i, c.Fn, c.Error)
		}
		got, err := call(c.Fn, c.Args)
		if err != nil {
			t.Fatal(err)
		}
		gb, _ := json.Marshal(got)
		var gotAny any
		_ = json.Unmarshal(gb, &gotAny)
		if !reflect.DeepEqual(gotAny, c.Want) {
			byFn[c.Fn]++
			if bad++; bad <= 6 {
				in, _ := json.Marshal(c.Args)
				wb, _ := json.Marshal(c.Want)
				t.Errorf("#%d %s 输出不一致\n输入: %.300s\n有: %.400s\n要: %.400s", i, c.Fn, in, gb, wb)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("共 %d 条不一致(总 %d 条),按函数: %v", bad, len(g.Cases), byFn)
	}
	t.Logf("%d 条金标准全部一致", len(g.Cases))
}
