package routing

import (
	"encoding/json"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// 改版前留在档案里的 routing 字段:地区层(regions / regionId / regionMode)、「出站」页签开关、广告拦截、
// 更早的 categories / directRulesets / fallback,以及主 selector 名 proxyTag。迁移把它们翻译成站点集后从档案里删掉。
var legacyRoutingKeys = []string{
	"regions", "regionId", "regionMode", "outboundOptions", "adBlock", "adRuleset", "categories", "directRulesets", "fallback", "proxyTag",
}

// migrateStoredRoutingObj 把存下来的 routing 迁到新模型(engine/routing-model.mjs 的 migrateStoredRouting)。
// 返回迁完的对象和 changed;没有老字段时原样返回(非对象当成 {})。
func migrateStoredRoutingObj(routing any) (any, bool, bool) {
	// 官方 v0.1.354:数组(以及其他非对象)按空对象处理,返回 {}
	raw, ok := asObject(routing)
	if !ok {
		raw = map[string]any{}
	}
	hasLegacyKey := false
	for _, k := range legacyRoutingKeys {
		if _, present := raw[k]; present {
			hasLegacyKey = true
			break
		}
	}
	if !hasLegacyKey {
		return raw, false, true
	}

	res := make(map[string]any, len(raw)+2)
	for k, v := range raw {
		res[k] = v
	}

	// 空数组 + 有老字段,同样是一份没迁过的老档案
	cats, _ := asArray(raw["categories"])
	hasLegacy := len(cats) > 0
	if dr, ok := asArray(raw["directRulesets"]); ok && !hasLegacy {
		for _, t := range dr {
			if s, isStr := t.(string); !isStr || !inList(s, cnRulesets) {
				hasLegacy = true
				break
			}
		}
	}
	pols, hasPolicies := asArray(raw["policies"])
	policies := make([]any, 0, len(pols))
	if !hasPolicies || (len(pols) == 0 && hasLegacy) {
		for _, p := range migrateLegacy(raw) {
			policies = append(policies, policyToAny(p))
		}
	} else {
		policies = append(policies, pols...) // 用户自己的站点集原样保留
	}

	// fallbackDefault 写进档案就说明地区层已经迁过;没写才翻译
	if _, done := nonEmpty(raw["fallbackDefault"]); !done {
		rp, fb := migrateRegion(raw)
		for _, p := range rp {
			policies = append(policies, policyToAny(p))
		}
		if fb != "" {
			res["fallbackDefault"] = fb
		}
	}
	// 本来就没有 policies、翻译也没翻出东西,就不写 policies:作为 patch 合并时不能把现有站点集清空
	if hasPolicies || len(policies) > 0 {
		res["policies"] = policies
	}
	for _, k := range legacyRoutingKeys {
		delete(res, k)
	}
	return res, true, true
}

func policyToAny(p Policy) map[string]any {
	notes := make(map[string]any, len(p.Notes))
	for k, v := range p.Notes {
		notes[k] = v
	}
	m := map[string]any{
		"id": p.ID, "name": p.Name, "icon": p.Icon, "default": p.Default, "enabled": p.Enabled,
		"ruleUrls": toAny(p.RuleUrls), "rulesets": toAny(p.Rulesets), "domain": toAny(p.Domain),
		"domainSuffix": toAny(p.DomainSuffix), "domainKeyword": toAny(p.DomainKeyword), "ipCidr": toAny(p.IPCidr),
		"notes": notes,
	}
	if len(p.MissingRulesets) > 0 {
		m["missingRulesets"] = toAny(p.MissingRulesets)
	}
	return m
}

// migrateStoredRouting(routing) → {routing, changed}
func hMigrateStoredRouting(_ *protocol.Context, args []json.RawMessage) (any, error) {
	raw, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	out, changed, _ := migrateStoredRoutingObj(raw)
	return struct {
		Routing any  `json:"routing"`
		Changed bool `json:"changed"`
	}{out, changed}, nil
}
