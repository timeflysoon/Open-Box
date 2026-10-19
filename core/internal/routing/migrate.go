package routing

import (
	"encoding/json"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// 改版前的字段:地区层(regions/regionId/regionMode)和更早的老字段(categories/directRulesets/fallback)。
// 迁移把它们翻译成站点集后从档案里删掉。
//
// 有意保守:adBlock / adRuleset / outboundOptions / proxyTag 这些字段原样保留,
// 宁可少删,也不能因为拿不准而弄丢用户的设置。
var legacyRoutingKeys = []string{"regions", "regionId", "regionMode", "categories", "directRulesets", "fallback"}

// migrateStoredRouting 把存下来的 routing 迁到新模型,返回 {changed, routing}。
// 保证:迁移前后 normalizeRouting 读出来的结果一致;已经迁过的再迁一次 changed 为 false。
func migrateStoredRouting(routing any) (changed bool, out any) {
	raw, ok := asObject(routing)
	if !ok {
		return false, routing
	}
	hasLegacyKey := false
	for _, k := range legacyRoutingKeys {
		if _, present := raw[k]; present {
			hasLegacyKey = true
			break
		}
	}
	if !hasLegacyKey {
		return false, routing
	}

	res := make(map[string]any, len(raw)+2)
	for k, v := range raw {
		res[k] = v
	}

	// 与 normalizeRouting 同一套判定:什么时候用老字段翻译成站点集
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
	res["policies"] = policies

	for _, k := range legacyRoutingKeys {
		delete(res, k)
	}
	return true, res
}

func policyToAny(p Policy) map[string]any {
	return map[string]any{
		"id": p.ID, "name": p.Name, "icon": p.Icon, "default": p.Default, "enabled": p.Enabled,
		"ruleUrls": toAny(p.RuleUrls), "rulesets": toAny(p.Rulesets), "domain": toAny(p.Domain),
		"domainSuffix": toAny(p.DomainSuffix), "domainKeyword": toAny(p.DomainKeyword), "ipCidr": toAny(p.IPCidr),
	}
}

// migrateStoredRouting(routing) → {changed, routing}
func hMigrateStoredRouting(_ *protocol.Context, args []json.RawMessage) (any, error) {
	raw, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	changed, out := migrateStoredRouting(raw)
	return struct {
		Changed bool `json:"changed"`
		Routing any  `json:"routing"`
	}{changed, out}, nil
}
