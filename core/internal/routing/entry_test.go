package routing

import (
	"encoding/json"
	"testing"
)

func TestEntryPlanBlacklistOnly(t *testing.T) {
	routing := mustJSON(t, `{"policies":[{"name":"国内","default":"direct","rulesets":["geoip-cn"]}],"fallbackDefault":"direct"}`)
	on := entryPlan(routing, mustJSON(t, `{"members":["direct"]}`))
	if on.Mode != "blacklist" || on.Reason != "" || on.NeedSets == nil || on.NeedCidrs == nil || len(on.NeedSets)+len(on.NeedCidrs) != 0 {
		t.Fatalf("旁路开着时应是空原因的 blacklist: %+v", on)
	}
	off := entryPlan(routing, mustJSON(t, `{"members":["direct"],"enabled":false}`))
	if off.Mode != "blacklist" || off.Reason == "" {
		t.Fatalf("旁路关闭时应带上原因: %+v", off)
	}
	// 数组字段必须序列化成 [] 而不是 null,Node 会对它们取 length / Array.isArray
	b, _ := json.Marshal(on)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"needSets", "needCidrs"} {
		if a, ok := m[k].([]any); !ok || len(a) != 0 {
			t.Fatalf("%s 应为空数组: %v", k, m[k])
		}
	}
	if m["directAnswer"] != false {
		t.Fatalf("directAnswer 应为 false: %v", m)
	}
}
