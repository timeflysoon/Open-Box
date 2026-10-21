package routing

import "strings"

// 出站选择相关的小函数,对应旧 Node 的 effectiveOutbound / resolveSelectionLeaf / policyChosenOutbound。

// builtinTags 是内置出站的当前名字(内置出站可以改名,档案里存的 direct / block 只是占位)。
// directEnabled / blockEnabled 只有 policyOutboundOptions 用:节点管理里停用了内置的直连 / 拒绝,
// 站点集 selector 的成员里就不放它。
type builtinTags struct {
	direct, block               string
	directEnabled, blockEnabled bool
}

var defaultBuiltin = builtinTags{"direct", "block", true, true}

func parseBuiltin(v any) builtinTags {
	m, ok := asObject(v)
	if !ok {
		return defaultBuiltin
	}
	b := builtinTags{}
	b.direct, _ = m["direct"].(string)
	b.block, _ = m["block"].(string)
	b.directEnabled = jsTruthy(m["directEnabled"])
	b.blockEnabled = jsTruthy(m["blockEnabled"])
	return b
}

// parseMembers:selector 的成员表。缺省(或不是数组)按 ['direct']。
func parseMembers(v any) []string {
	a, ok := asArray(v)
	if !ok {
		return []string{"direct"}
	}
	out := make([]string, 0, len(a))
	for _, e := range a {
		s, _ := e.(string) // 非字符串成员不会等于任何出站名;占位成空串
		out = append(out, s)
	}
	return out
}

func parseSelections(v any) map[string]any {
	if m, ok := asObject(v); ok {
		return m
	}
	return map[string]any{}
}

const proxySentinel = "proxy"

func contains(list []string, s string) bool { return inList(s, list) }

// effectiveOutbound:default 空着(或指向已经不存在的组)时,内核落到成员表第一项。
func effectiveOutbound(def string, members []string, b builtinTags) string {
	want := def
	switch def {
	case "direct":
		want = b.direct
	case "block":
		want = b.block
	}
	if contains(members, want) {
		return want
	}
	if def == proxySentinel {
		for _, m := range members {
			if m != b.direct && m != b.block {
				return m
			}
		}
	}
	if len(members) == 0 {
		return ""
	}
	return members[0]
}

// resolveSelectionLeaf:顺着 selector 的当前选择一路下钻到叶子(最多 16 层,防环)。
func resolveSelectionLeaf(selections map[string]any, name string) string {
	current := name
	seen := map[string]bool{}
	for i := 0; i < 16; i++ {
		next, has := selections[current]
		if !has || seen[current] {
			break
		}
		seen[current] = true
		s, isStr := next.(string)
		if !isStr {
			return "\x00non-string" // 非字符串的选择值不会等于任何出站名
		}
		current = s
	}
	return current
}

func policyChosenOutbound(name, def string, members []string, b builtinTags, selections map[string]any) string {
	if _, has := selections[name]; has {
		return resolveSelectionLeaf(selections, name)
	}
	return effectiveOutbound(def, members, b)
}

func policyGoesDirect(name, def string, members []string, b builtinTags, selections map[string]any) bool {
	return policyChosenOutbound(name, def, members, b, selections) == b.direct
}

// ---- 自定义分流行的出口 / 规则集名 ----

func customPolicyActive(c CustomPolicy) bool { return c.Enabled && len(c.Rules) > 0 }

func customOutboundTag(r CustomRule, b builtinTags) string {
	switch r.Outbound {
	case "direct":
		return b.direct
	case "block":
		return b.block
	}
	return r.Outbound
}

func customRuleTag(r CustomRule) string {
	switch r.Type {
	case "geosite", "geoip":
		return r.Type + "-" + r.Value
	case "ruleset":
		return r.Value
	case "ruleUrl":
		return ListTagForUrl(r.Value)
	}
	return ""
}

func isRuleListTag(tag string) bool { return strings.HasPrefix(tag, ruleListPrefix) }
func isGeoipTag(tag string) bool    { return strings.HasPrefix(tag, "geoip-") }
