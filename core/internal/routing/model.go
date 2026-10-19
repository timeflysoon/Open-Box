package routing

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// 对应旧 Node 的 engine/routing-model.mjs 里「归一化 + 老档案迁移」那部分。

const (
	FallbackTag      = "其他"
	FallbackIcon     = "globe:earth-meridians"
	CustomPolicyName = "前置自定义分流"
	CustomPolicyIcon = "misc:pin"
	defaultAdRuleset = "geosite-category-ads-all"
	defaultProxyTag  = "PROXY"
	ruleListPrefix   = "list-"
)

var (
	cnRulesets       = []string{"geosite-cn", "geoip-cn"}
	regionRuleTypes  = []string{"geosite", "geoip", "domain", "domainSuffix", "ipcidr"}
	regionRuleActs   = []string{"direct", "proxy"}
	customRuleTypes  = []string{"domainSuffix", "domain", "domainKeyword", "ipCidr", "geosite", "geoip", "ruleUrl", "ruleset", "port"}
	regionModeToID   = map[string]string{"CN": "cn", "HKMO": "hkmo", "OTHER": "other"}
	httpURLRe        = regexp.MustCompile(`(?i)^https?://`)
	portTokenRe      = regexp.MustCompile(`^(\d{1,5})(?:-(\d{1,5}))?$`)
	builtinRegionsJS = []any{
		map[string]any{"id": "cn", "name": "中国大陆", "catchAll": "proxy", "rules": []any{
			map[string]any{"type": "geosite", "value": "cn", "action": "direct"},
			map[string]any{"type": "geoip", "value": "cn", "action": "direct"}}},
		map[string]any{"id": "hkmo", "name": "香港澳门", "catchAll": "direct", "rules": []any{}},
		map[string]any{"id": "other", "name": "其他地区", "catchAll": "direct", "rules": []any{
			map[string]any{"type": "geosite", "value": "cn", "action": "proxy"},
			map[string]any{"type": "geoip", "value": "cn", "action": "proxy"}}},
	}
)

// ListTagForUrl 把规则集链接折算成规则集名:FNV-1a(按 UTF-16 码元)取 8 位十六进制。
// Node 端有同样的算法,两边必须一致,否则部署时下回来的规则集对不上号。
func ListTagForUrl(url string) string {
	s := jsTrim(url)
	if s == "" {
		return ""
	}
	h := uint32(0x811c9dc5)
	for _, u := range utf16.Encode([]rune(s)) {
		h ^= uint32(u)
		h *= 0x01000193
	}
	return fmt.Sprintf("%s%08x", ruleListPrefix, h)
}

// ParsePortSpec 解析「51820」「1000-2000」,多个用逗号/空白隔开。有一个写错整体返回 ok=false。
func ParsePortSpec(value string) (ports []int, ranges []string, ok bool) {
	tokens := strings.FieldsFunc(value, func(r rune) bool { return r == ',' || isJSSpace(r) })
	if len(tokens) == 0 {
		return nil, nil, false
	}
	inRange := func(n int) bool { return n >= 1 && n <= 65535 }
	for _, tok := range tokens {
		m := portTokenRe.FindStringSubmatch(tok)
		if m == nil {
			return nil, nil, false
		}
		a, _ := strconv.Atoi(m[1])
		b := a
		if m[2] != "" {
			b, _ = strconv.Atoi(m[2])
		}
		if !inRange(a) || !inRange(b) || a > b {
			return nil, nil, false
		}
		if a == b {
			ports = append(ports, a)
		} else {
			ranges = append(ranges, fmt.Sprintf("%d:%d", a, b))
		}
	}
	return ports, ranges, true
}

// Policy 是归一化后的站点集。字段顺序就是 JSON 输出顺序(指纹依赖它,不要调换)。
type Policy struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Icon          string   `json:"icon"`
	Default       string   `json:"default"`
	Enabled       bool     `json:"enabled"`
	RuleUrls      []string `json:"ruleUrls"`
	Rulesets      []string `json:"rulesets"`
	Domain        []string `json:"domain"`
	DomainSuffix  []string `json:"domainSuffix"`
	DomainKeyword []string `json:"domainKeyword"`
	IPCidr        []string `json:"ipCidr"`
}

func (p Policy) hasCondition() bool {
	return len(p.Rulesets) > 0 || len(p.Domain) > 0 || len(p.DomainSuffix) > 0 ||
		len(p.DomainKeyword) > 0 || len(p.IPCidr) > 0
}

func normalizePolicy(raw any, index int) Policy {
	ruleUrls := []string{}
	for _, u := range strList(get(raw, "ruleUrls")) {
		if httpURLRe.MatchString(u) {
			ruleUrls = append(ruleUrls, u)
		}
	}
	rulesets := strList(get(raw, "rulesets"))
	for _, u := range ruleUrls {
		rulesets = append(rulesets, ListTagForUrl(u))
	}
	p := Policy{
		Enabled:       notFalse(get(raw, "enabled")),
		RuleUrls:      ruleUrls,
		Rulesets:      dedupe(rulesets),
		Domain:        strList(get(raw, "domain")),
		DomainSuffix:  strList(get(raw, "domainSuffix")),
		DomainKeyword: strList(get(raw, "domainKeyword")),
		IPCidr:        strList(get(raw, "ipCidr")),
	}
	var ok bool
	if p.ID, ok = nonEmpty(get(raw, "id")); !ok {
		p.ID = idx("policy-%d", index)
	}
	if p.Name, ok = nonEmpty(get(raw, "name")); !ok {
		p.Name = idx("策略-%d", index+1)
	}
	p.Icon, _ = nonEmpty(get(raw, "icon"))
	p.Default, _ = nonEmpty(get(raw, "default"))
	return p
}

// CustomRule / CustomPolicy:前置自定义分流(固定置顶的那一条)。
type CustomRule struct {
	Type     string `json:"type"`
	Value    string `json:"value"`
	Outbound string `json:"outbound"`
}

type CustomPolicy struct {
	Name      string       `json:"name"`
	Icon      string       `json:"icon"`
	IconScale float64      `json:"iconScale"`
	Enabled   bool         `json:"enabled"`
	Rules     []CustomRule `json:"rules"`
}

func normalizeCustomRule(raw any) (CustomRule, bool) {
	m, ok := asObject(raw)
	if !ok {
		return CustomRule{}, false
	}
	typ, isStr := m["type"].(string)
	if !isStr || !inList(typ, customRuleTypes) {
		return CustomRule{}, false
	}
	value, ok1 := nonEmpty(m["value"])
	outbound, ok2 := nonEmpty(m["outbound"])
	if !ok1 || !ok2 {
		return CustomRule{}, false
	}
	if typ == "ruleUrl" && !httpURLRe.MatchString(value) {
		return CustomRule{}, false
	}
	if typ == "port" {
		if _, _, ok := ParsePortSpec(value); !ok {
			return CustomRule{}, false
		}
	}
	return CustomRule{Type: typ, Value: value, Outbound: outbound}, true
}

func normalizeCustomPolicy(raw any) CustomPolicy {
	c := CustomPolicy{Enabled: notFalse(get(raw, "enabled")), Rules: []CustomRule{}}
	var ok bool
	if c.Name, ok = nonEmpty(get(raw, "name")); !ok {
		c.Name = CustomPolicyName
	}
	if c.Icon, ok = nonEmpty(get(raw, "icon")); !ok {
		c.Icon = CustomPolicyIcon
	}
	c.IconScale, _ = isInteger(get(raw, "iconScale"))
	if rules, ok := asArray(get(raw, "rules")); ok {
		for _, r := range rules {
			if cr, ok := normalizeCustomRule(r); ok {
				c.Rules = append(c.Rules, cr)
			}
		}
	}
	return c
}

// ---- 改版前的地区层(只用于迁移) ----

type regionRule struct{ typ, value, action string }
type region struct {
	id, name string
	rules    []regionRule
	catchAll string
}

func regionRuleTag(r regionRule) string {
	if r.typ == "geosite" || r.typ == "geoip" {
		return r.typ + "-" + r.value
	}
	return ""
}

func normalizeRegionRule(raw any) (regionRule, bool) {
	m, ok := asObject(raw)
	if !ok {
		return regionRule{}, false
	}
	typ, isStr := m["type"].(string)
	if !isStr || !inList(typ, regionRuleTypes) {
		return regionRule{}, false
	}
	value, ok := nonEmpty(m["value"])
	if !ok {
		return regionRule{}, false
	}
	action := "direct"
	if a, ok := m["action"].(string); ok && inList(a, regionRuleActs) {
		action = a
	}
	return regionRule{typ, value, action}, true
}

func targetOf(v any) (string, bool) {
	s, ok := v.(string)
	if ok && inList(s, regionRuleActs) {
		return s, true
	}
	return "", false
}

func migrateRegionRules(raw any) []regionRule {
	target, ok := targetOf(get(raw, "target"))
	if !ok {
		target = "direct"
	}
	out := []regionRule{}
	for _, tag := range strList(get(raw, "rulesets")) {
		typ := "geosite"
		if strings.HasPrefix(tag, "geoip-") {
			typ = "geoip"
		}
		value := tag
		if strings.HasPrefix(tag, typ+"-") {
			value = tag[len(typ)+1:]
		}
		out = append(out, regionRule{typ, value, target})
	}
	return out
}

func normalizeRegion(raw any, index int) region {
	r := region{}
	var ok bool
	if r.id, ok = nonEmpty(get(raw, "id")); !ok {
		r.id = idx("region-%d", index)
	}
	if r.name, ok = nonEmpty(get(raw, "name")); !ok {
		r.name = idx("地区-%d", index+1)
	}
	if rules, isArr := asArray(get(raw, "rules")); isArr {
		r.rules = []regionRule{}
		for _, x := range rules {
			if rr, ok := normalizeRegionRule(x); ok {
				r.rules = append(r.rules, rr)
			}
		}
	} else {
		r.rules = migrateRegionRules(raw)
	}
	if c, ok := targetOf(get(raw, "catchAll")); ok {
		r.catchAll = c
	} else if c, ok := targetOf(get(raw, "fallback")); ok {
		r.catchAll = c
	} else {
		r.catchAll = "proxy"
	}
	return r
}

// migrateLegacy:老档案(categories/directRulesets/fallback)→ 站点集。只在没有 policies 时走。
func migrateLegacy(raw map[string]any) []Policy {
	policies := []Policy{}
	if cats, ok := asArray(raw["categories"]); ok {
		for _, cat := range cats {
			rs, ok := nonEmpty(get(cat, "ruleset"))
			if !ok {
				continue
			}
			def := ""
			if t, ok := nonEmpty(get(cat, "target")); ok {
				def = t
			}
			// id 里用的是未 trim 的原值(与旧实现一致)
			orig, _ := get(cat, "ruleset").(string)
			policies = append(policies, normalizePolicy(map[string]any{
				"id": "legacy-" + orig, "name": rs, "default": def, "rulesets": []any{rs},
			}, len(policies)))
		}
	}
	extra := []string{}
	for _, t := range strList(raw["directRulesets"]) {
		if !inList(t, cnRulesets) {
			extra = append(extra, t)
		}
	}
	if len(extra) > 0 {
		policies = append(policies, normalizePolicy(map[string]any{
			"id": "legacy-direct", "name": "始终直连", "default": "direct", "rulesets": toAny(extra),
		}, len(policies)))
	}
	return policies
}

// migrateRegion:地区层退役,选中的那条地区拆成一到两个站点集;兜底变成兜底站点集的默认选中项。
func migrateRegion(raw map[string]any) ([]Policy, string) {
	regionsArr, _ := asArray(raw["regions"])
	_, hasID := nonEmpty(raw["regionId"])
	_, hasMode := nonEmpty(raw["regionMode"])
	if len(regionsArr) == 0 && !hasID && !hasMode {
		return []Policy{}, ""
	}
	src := regionsArr
	if len(src) == 0 {
		src = builtinRegionsJS
	}
	regions := make([]region, len(src))
	for i, r := range src {
		regions[i] = normalizeRegion(r, i)
	}
	wanted := ""
	if id, ok := nonEmpty(raw["regionId"]); ok {
		wanted = id
	} else if _, ok := nonEmpty(raw["regionMode"]); ok {
		if mode, isStr := raw["regionMode"].(string); isStr {
			wanted = regionModeToID[mode]
		}
	}
	chosen := regions[0]
	for _, r := range regions {
		if r.id == wanted {
			chosen = r
			break
		}
	}
	policies := []Policy{}
	for _, action := range []string{"direct", "proxy"} {
		var rules []regionRule
		for _, r := range chosen.rules {
			if r.action == action {
				rules = append(rules, r)
			}
		}
		if len(rules) == 0 {
			continue
		}
		var tags, domain, suffix, cidr []string
		for _, r := range rules {
			switch r.typ {
			case "geosite", "geoip":
				tags = append(tags, regionRuleTag(r))
			case "domain":
				domain = append(domain, r.value)
			case "domainSuffix":
				suffix = append(suffix, r.value)
			case "ipcidr":
				cidr = append(cidr, r.value)
			}
		}
		label := "代理"
		if action == "direct" {
			label = "直连"
		}
		policies = append(policies, normalizePolicy(map[string]any{
			"id": "region-" + chosen.id + "-" + action, "name": chosen.name + "·" + label,
			"icon": FallbackIcon, "default": action,
			"rulesets": toAny(tags), "domain": toAny(domain), "domainSuffix": toAny(suffix), "ipCidr": toAny(cidr),
		}, len(policies)))
	}
	fb := "direct"
	if chosen.catchAll == "proxy" {
		fb = "proxy"
	}
	return policies, fb
}

// Routing 是 normalizeRouting 的结果。字段顺序就是 JSON 输出顺序。
type Routing struct {
	ProxyTag        string          `json:"proxyTag"`
	OutboundOptions OutboundOptions `json:"outboundOptions"`
	Custom          CustomPolicy    `json:"custom"`
	Policies        []Policy        `json:"policies"`
	ActivePolicies  []Policy        `json:"activePolicies"`
	Fallback        Fallback        `json:"fallback"`
	AdBlock         bool            `json:"adBlock"`
	AdRuleset       string          `json:"adRuleset"`
}

type OutboundOptions struct {
	Direct bool `json:"direct"`
	Reject bool `json:"reject"`
	Groups bool `json:"groups"`
}

type Fallback struct {
	Name    string `json:"name"`
	Icon    string `json:"icon"`
	Default string `json:"default"`
}

func normalizeRouting(routing any) Routing {
	raw, ok := asObject(routing)
	if !ok {
		raw = map[string]any{}
	}
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

	var base []Policy
	pols, hasPolicies := asArray(raw["policies"])
	if !hasPolicies || (len(pols) == 0 && hasLegacy) {
		base = migrateLegacy(raw)
	} else {
		base = make([]Policy, len(pols))
		for i, p := range pols {
			base[i] = normalizePolicy(p, i)
		}
	}

	// fallbackDefault 一旦写进档案,就说明已经迁过地区层,不再重复翻译。
	// 注意旧实现的细节:没写 fallbackDefault 时一律走 migrateRegion,
	// 没有地区数据则兜底默认选中项是空串(不是 "direct")。
	var regionPolicies []Policy
	regionFallback := ""
	_, hasFD := nonEmpty(raw["fallbackDefault"])
	if !hasFD {
		regionPolicies, regionFallback = migrateRegion(raw)
	}

	fallbackName, ok := nonEmpty(raw["fallbackName"])
	if !ok {
		fallbackName = FallbackTag
	}
	fallbackIcon, ok := nonEmpty(raw["fallbackIcon"])
	if !ok {
		fallbackIcon = FallbackIcon
	}

	policies := []Policy{}
	for _, p := range append(base, regionPolicies...) {
		if p.hasCondition() && p.Name != FallbackTag && p.Name != fallbackName {
			policies = append(policies, p)
		}
	}
	active := []Policy{}
	for _, p := range policies {
		if p.Enabled {
			active = append(active, p)
		}
	}

	opts, _ := asObject(raw["outboundOptions"])
	fbDefault := regionFallback
	if d, ok := nonEmpty(raw["fallbackDefault"]); ok {
		fbDefault = d
	}

	r := Routing{
		ProxyTag:        defaultProxyTag,
		OutboundOptions: OutboundOptions{notFalse(opts["direct"]), notFalse(opts["reject"]), notFalse(opts["groups"])},
		Custom:          normalizeCustomPolicy(raw["custom"]),
		Policies:        policies,
		ActivePolicies:  active,
		Fallback:        Fallback{Name: fallbackName, Icon: fallbackIcon, Default: fbDefault},
		AdBlock:         raw["adBlock"] == true,
		AdRuleset:       defaultAdRuleset,
	}
	if t, ok := nonEmpty(raw["proxyTag"]); ok {
		r.ProxyTag = t
	}
	if t, ok := nonEmpty(raw["adRuleset"]); ok {
		r.AdRuleset = t
	}
	return r
}
