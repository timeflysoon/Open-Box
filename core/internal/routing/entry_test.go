package routing

import (
	"encoding/json"
	"testing"
)

// 计划的内容对照在金标准里;这里只管 Node 对返回形状的要求:needSets / needCidrs 必须序列化成 [] 而不是 null。
func TestEntryPlanArraysAreNotNull(t *testing.T) {
	routing := mustJSON(t, `{"policies":[{"name":"国内","default":"direct","rulesets":["geoip-cn"]}],"fallbackDefault":"direct"}`)
	for _, opts := range []string{`{"members":["direct"]}`, `{"members":["direct"],"fakeIp":true}`, `{"members":["direct"],"enabled":false}`} {
		b, _ := json.Marshal(entryPlan(routing, mustJSON(t, opts)))
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		for _, k := range []string{"needSets", "needCidrs"} {
			if _, ok := m[k].([]any); !ok {
				t.Fatalf("%s 应为数组: %v(选项 %s)", k, m[k], opts)
			}
		}
	}
}

// 官方 v0.1.353:有终端走代理时 directAnswer 照样看 FakeIP / DNS 模式 / 前置端口规则,不因终端分流直接关掉。
func TestEntryPlanDirectAnswerWithProxyClient(t *testing.T) {
	routing := mustJSON(t, `{"policies":[],"fallbackDefault":"direct"}`)
	opts := func(extra string) any {
		return mustJSON(t, `{"members":["direct","美国"],"clientRoutes":[{"ip":"192.168.1.5","outbound":"美国"}]`+extra+`}`)
	}
	if p := entryPlan(routing, opts(`,"fakeIp":true`)); p.Mode != entryModeBlacklist || !p.DirectAnswer {
		t.Fatalf("有终端走代理 + FakeIP:黑名单模式,directAnswer 应为 true: %+v", p)
	}
	if p := entryPlan(routing, opts(`,"fakeIp":true,"dnsMode":"off"`)); p.DirectAnswer {
		t.Fatalf("DNS 禁用时 directAnswer 应为 false: %+v", p)
	}
	if p := entryPlan(routing, opts(``)); p.DirectAnswer {
		t.Fatalf("没开 FakeIP 时 directAnswer 应为 false: %+v", p)
	}
}
