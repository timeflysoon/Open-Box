package routing

import (
	"github.com/timeflysoon/Open-Box/core/internal/clientroutes"
)

// 对应旧 Node 的 engine/routing.mjs 的 buildRoute:生成 sing-box 的 route 段。
// 旧文件里的 preResolveRules(「预解析」规则)正式生成不启用(config.mjs 不传 resolvers,
// 注释里写明留待后续方案验证),所以没有移植。

// DirectHosts 是订阅和节点站点直连的名单(域名 + 节点域名解析出来的 IP 段)。
type DirectHosts struct {
	Domains []string
	Cidrs   []string
}

// RouteOptions 是旧版 buildRoute 的 options。
type RouteOptions struct {
	DNSMode        string // 空 = hijack
	DirectTag      string // 内置直连当前的名字;空 = "direct"
	BlockTag       string // 空 = "block"
	DirectHosts    *DirectHosts
	RejectV6For    func(tag string) bool // nil = 不插 v6 拒绝
	TunCidrs       []string
	DnsmasqTag     string
	ClientRoutes   []clientroutes.Route
	KnownOutbounds map[string]bool // nil = 没传(不筛)
	RuleLists      ruleLists
}

// tagSet 是保序去重的集合(JS 的 Set 按插入顺序迭代,规则集清单的顺序要和它一致)。
type tagSet struct {
	seen map[string]bool
	list []string
}

func (s *tagSet) add(tag string) {
	if tag == "" || s.seen[tag] {
		return
	}
	if s.seen == nil {
		s.seen = map[string]bool{}
	}
	s.seen[tag] = true
	s.list = append(s.list, tag)
}

// policyRule:一条策略的匹配条件 → 一条路由规则(域名 / IP 字段是「或」)。
func policyRule(p Policy, l ruleLists) map[string]any {
	rule := map[string]any{}
	if tags := routeRulesetTags(p.Rulesets, l); len(tags) > 0 {
		rule["rule_set"] = tags
	}
	if len(p.Domain) > 0 {
		rule["domain"] = p.Domain
	}
	if len(p.DomainSuffix) > 0 {
		rule["domain_suffix"] = p.DomainSuffix
	}
	if len(p.DomainKeyword) > 0 {
		rule["domain_keyword"] = p.DomainKeyword
	}
	if len(p.IPCidr) > 0 {
		rule["ip_cidr"] = p.IPCidr
	}
	rule["outbound"] = p.Name
	return rule
}

// customRouteRule:前置自定义分流的一行 → 一条路由规则;认不出来返回 nil。
func customRouteRule(r CustomRule, l ruleLists, outbound string) map[string]any {
	if tag := customRuleTag(r); tag != "" {
		tags := routeRulesetTags([]string{tag}, l)
		if len(tags) == 0 {
			return nil
		}
		return map[string]any{"rule_set": tags, "outbound": outbound}
	}
	if r.Type == "port" {
		ports, ranges, ok := ParsePortSpec(r.Value)
		if !ok {
			return nil
		}
		m := map[string]any{"outbound": outbound}
		if len(ports) > 0 {
			m["port"] = ports
		}
		if len(ranges) > 0 {
			m["port_range"] = ranges
		}
		return m
	}
	field := map[string]string{"domain": "domain", "domainSuffix": "domain_suffix", "domainKeyword": "domain_keyword", "ipCidr": "ip_cidr"}[r.Type]
	if field == "" {
		return nil
	}
	return map[string]any{field: []string{r.Value}, "outbound": outbound}
}

// BuildRoute 相当于 buildRoute(routing, rulesetDir, options),返回 route 段和用到的规则集标签(按首次出现的顺序)。
func BuildRoute(routing any, rulesetDir string, o RouteOptions) (map[string]any, []string) {
	conf := normalizeRouting(routing)
	tags := &tagSet{}
	dnsMode := o.DNSMode
	if dnsMode == "" {
		dnsMode = "hijack"
	}
	directTag, blockTag := o.DirectTag, o.BlockTag
	if directTag == "" {
		directTag = "direct"
	}
	if blockTag == "" {
		blockTag = "block"
	}
	known := o.KnownOutbounds
	rules := []any{map[string]any{"action": "sniff"}}

	// 出口此刻是代理线路时,先插一条同条件 + ip_version 6 的 reject
	pushRule := func(rule map[string]any) {
		if ob, _ := rule["outbound"].(string); o.RejectV6For != nil && ob != "" && o.RejectV6For(ob) {
			match := make(map[string]any, len(rule)+2)
			for k, v := range rule {
				if k != "outbound" {
					match[k] = v
				}
			}
			match["ip_version"] = 6
			match["action"] = "reject"
			rules = append(rules, match)
		}
		rules = append(rules, rule)
	}

	switch dnsMode {
	case "hijack":
		rules = append(rules, map[string]any{"protocol": "dns", "action": "hijack-dns"})
	case "off":
		rules = append(rules, map[string]any{"inbound": []string{"dns-in"}, "action": "hijack-dns"})
	case "dnsmasq":
		rules = append(rules, map[string]any{"inbound": []string{"dns-in"}, "action": "hijack-dns"})
		if len(o.TunCidrs) > 0 && o.DnsmasqTag != "" {
			rules = append(rules, map[string]any{
				"ip_cidr": o.TunCidrs, "port": []int{53}, "action": "route",
				"outbound": o.DnsmasqTag, "override_address": "127.0.0.1",
			})
		}
	}
	// 防回环:目标是 tun 自己的网段的连接直接拒绝,必须排在 ip_is_private 前面
	if len(o.TunCidrs) > 0 {
		rules = append(rules, map[string]any{"ip_cidr": o.TunCidrs, "action": "reject"})
	}

	// 前置自定义分流:排在所有分流规则最前面;出口必须是配置里真有的 outbound
	if customPolicyActive(conf.Custom) {
		b := builtinTags{direct: directTag, block: blockTag}
		for _, rule := range conf.Custom.Rules {
			target := customOutboundTag(rule, b)
			if known != nil && !known[target] {
				continue
			}
			emitted := customRouteRule(rule, o.RuleLists, target)
			if emitted == nil {
				continue
			}
			if rs, ok := emitted["rule_set"].([]string); ok {
				for _, t := range rs {
					tags.add(t)
				}
			}
			pushRule(emitted)
		}
	}

	rules = append(rules, map[string]any{"ip_is_private": true, "outbound": directTag})

	// 订阅和节点站点直连
	if dh := o.DirectHosts; dh != nil && (len(dh.Domains) > 0 || len(dh.Cidrs) > 0) {
		rule := map[string]any{"outbound": directTag}
		if len(dh.Domains) > 0 {
			rule["domain"] = dh.Domains
		}
		if len(dh.Cidrs) > 0 {
			rule["ip_cidr"] = dh.Cidrs
		}
		rules = append(rules, rule)
	}

	// 终端分流
	for _, cr := range o.ClientRoutes {
		if len(cr.Sources) == 0 || cr.Outbound == "" {
			continue
		}
		if known != nil && !known[cr.Outbound] {
			continue
		}
		pushRule(map[string]any{"source_ip_cidr": cr.Sources, "outbound": cr.Outbound})
	}

	if conf.AdBlock {
		tags.add(conf.AdRuleset)
		rules = append(rules, map[string]any{"rule_set": conf.AdRuleset, "action": "reject"})
	}

	// 站点集:按用户排的顺序,规则集 + 域名 / IP 拆成紧邻的两条
	for _, policy := range conf.ActivePolicies {
		for _, t := range routeRulesetTags(policy.Rulesets, o.RuleLists) {
			tags.add(t)
		}
		for _, part := range splitRuleSetConditions(policyRule(policy, o.RuleLists)) {
			pushRule(part)
		}
	}
	if o.RejectV6For != nil && o.RejectV6For(conf.Fallback.Name) {
		rules = append(rules, map[string]any{"ip_version": 6, "action": "reject"})
	}

	ruleSet := make([]any, 0, len(tags.list))
	for _, t := range tags.list {
		ruleSet = append(ruleSet, map[string]any{"type": "local", "tag": t, "format": "binary", "path": rulesetDir + "/" + t + ".srs"})
	}
	route := map[string]any{
		"auto_detect_interface":   true,
		"default_domain_resolver": "dns-direct",
		"rule_set":                ruleSet,
		"rules":                   rules,
		"final":                   conf.Fallback.Name,
	}
	if tags.list == nil {
		return route, []string{}
	}
	return route, tags.list
}
