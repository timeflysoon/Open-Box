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
