package routing

import (
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/clientroutes"
)

// 对应上游 engine/routing.mjs(基线 v0.1.318)的 buildRoute 和 preMatchBypassRules:生成 sing-box 的 route 段。
// preResolveRules(「预解析」规则)正式生成不启用(config.mjs 不传 resolvers,注释里写明留待后续方案验证),所以没有移植,
// options.resolvers 对应的入参也没有。

// DirectHosts 是订阅和节点站点直连的名单(域名 + 节点域名解析出来的 IP 段)。
type DirectHosts struct {
	Domains []string
	Cidrs   []string
}

// RouteOptions 是 buildRoute 的 options。
type RouteOptions struct {
	DNSMode   string // 空 = hijack
	DirectTag string // 内置直连当前的名字;空 = "direct"
	BlockTag  string // 空 = "block"
	// 订阅和节点站点直连:部署的配置用两份本地规则集(DirectHostSets),直接给地址的(DirectHosts,测试)照旧写进规则
	DirectHosts    *DirectHosts
	DirectHostSets *DirectHostSets
	// 出口此刻是代理线路的规则前面插 v6 / UDP 443 的 reject;nil = 不插
	RejectV6For   func(tag string) bool
	RejectQuicFor func(tag string) bool
	TunCidrs      []string
	DnsmasqTag    string
	// 名单外终端的专用 DNS 入站(「只让这些终端进内核」),和 dns-in 一起劫持
	DNSDirectInbound string
	ClientRoutes     []clientroutes.Route
	KnownOutbounds   map[string]bool // nil = 没传(不筛)
	RuleLists        ruleLists
	// 首包预判放行(「直连不进内核」开着、有 nft 重定向时才写)
	PreMatchBypass bool
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

// customRouteRule:前置自定义分流的一行 → 一条路由规则;认不出来返回 nil。
func customRouteRule(r CustomRule, l ruleLists, outbound string) map[string]any {
	if tag := customRuleTag(r); tag != "" {
		tags := routeRulesetTags([]string{tag}, l)
		if len(tags) == 0 {
			return nil
		}
		return map[string]any{"rule_set": tags, "outbound": outbound}
	}
	// 端口:TCP / UDP 都算,不限协议——放行 WireGuard 这种 UDP 也就是靠它
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

// routePart 是前置自定义分流一行编出来的一条规则;noDomain 表示它只管没有域名的连接。
type routePart struct {
	rule     map[string]any
	noDomain bool
}

// customRuleParts:前置自定义分流的一行 → 进配置的一到两条规则。IP 只管 IP、域名只管域名:
// IP 段 / geoip / 规则集链接编出来的 IP 那份带「连接没有域名」的前提(noDomain),域名那几档照常;端口行两类连接都管。
func customRuleParts(r CustomRule, l ruleLists, outbound string) []routePart {
	if tag := customRuleTag(r); tag != "" {
		var domainTags, ipTags []string
		for _, t := range routeRulesetTags([]string{tag}, l) {
			if isIPRuleSetTag(t) {
				ipTags = append(ipTags, t)
			} else {
				domainTags = append(domainTags, t)
			}
		}
		var parts []routePart
		if len(domainTags) > 0 {
			parts = append(parts, routePart{map[string]any{"rule_set": domainTags, "outbound": outbound}, false})
		}
		if len(ipTags) > 0 {
			parts = append(parts, routePart{map[string]any{"rule_set": ipTags, "outbound": outbound}, true})
		}
		return parts
	}
	emitted := customRouteRule(r, l, outbound)
	if emitted == nil {
		return nil
	}
	_, hasIP := emitted["ip_cidr"]
	return []routePart{{emitted, hasIP}}
}

// PreMatchOptions 是 preMatchBypassRules 的 options。DirectHostSet 是订阅和节点站点直连的 IP 那份规则集 tag。
type PreMatchOptions struct {
	ClientRoutes   []clientroutes.Route
	DirectHosts    *DirectHosts
	DirectHostSet  string
	DirectTag      string
	BlockTag       string
	RuleLists      ruleLists
	KnownOutbounds map[string]bool
	TunCidrs       []string
}

// PreMatchBypassRules 相当于 preMatchBypassRules:首包预判放行(sing-box 1.13+ 的 bypass 动作)。
// 订阅和节点站点直连的地址、终端分流里出口是「直连」的终端,在首包判定时照规则放行;排在它们前面、可能把连接送去别处的
// (前置自定义分流里走代理 / 拒绝的行、DNS 接管、tun 防回环)按 IP / 规则集 / 端口取反挂上。必须排在 sniff 前面。
func PreMatchBypassRules(conf Routing, o PreMatchOptions) []any {
	directTag, blockTag := o.DirectTag, o.BlockTag
	if directTag == "" {
		directTag = "direct"
	}
	if blockTag == "" {
		blockTag = "block"
	}
	var direct []clientroutes.Route
	for _, cr := range o.ClientRoutes {
		if clientroutes.IsDirectClientRoute(cr, directTag) {
			direct = append(direct, cr)
		}
	}
	var hostCidrs []string
	if o.DirectHostSet == "" && o.DirectHosts != nil {
		hostCidrs = o.DirectHosts.Cidrs
	}
	if len(direct) == 0 && len(hostCidrs) == 0 && o.DirectHostSet == "" {
		return []any{}
	}
	cidrs := append([]string{}, o.TunCidrs...)
	var sets, ranges []string
	ports := []int{53}
	addStr := func(list *[]string, v string) {
		for _, e := range *list {
			if e == v {
				return
			}
		}
		*list = append(*list, v)
	}
	if customPolicyActive(conf.Custom) {
		b := builtinTags{direct: directTag, block: blockTag}
		for _, rule := range conf.Custom.Rules {
			target := customOutboundTag(rule, b)
			if target == directTag {
				continue
			}
			if o.KnownOutbounds != nil && !o.KnownOutbounds[target] {
				continue
			}
			for _, part := range customRuleParts(rule, o.RuleLists, target) {
				if v, ok := part.rule["ip_cidr"].([]string); ok {
					for _, c := range v {
						addStr(&cidrs, c)
					}
				}
				if v, ok := part.rule["rule_set"].([]string); ok {
					for _, t := range v {
						addStr(&sets, t)
					}
				}
				if v, ok := part.rule["port"].([]int); ok {
					for _, p := range v {
						dup := false
						for _, e := range ports {
							if e == p {
								dup = true
							}
						}
						if !dup {
							ports = append(ports, p)
						}
					}
				}
				if v, ok := part.rule["port_range"].([]string); ok {
					for _, r := range v {
						addStr(&ranges, r)
					}
				}
			}
		}
	}
	var keep []map[string]any
	if len(cidrs) > 0 {
		keep = append(keep, map[string]any{"ip_cidr": cidrs, "invert": true})
	}
	if len(sets) > 0 {
		keep = append(keep, map[string]any{"rule_set": sets, "invert": true})
	}
	portRule := map[string]any{"port": ports, "invert": true}
	if len(ranges) > 0 {
		portRule["port_range"] = ranges
	}
	keep = append(keep, portRule)

	var ips, macs []string
	seenIP, seenMac := map[string]bool{}, map[string]bool{}
	for _, cr := range direct {
		if cr.Match == "mac" {
			for _, m := range cr.Macs {
				if !seenMac[m] {
					seenMac[m] = true
					macs = append(macs, m)
				}
			}
		} else {
			for _, s := range cr.Sources {
				if !seenIP[s] {
					seenIP[s] = true
					ips = append(ips, s)
				}
			}
		}
	}
	build := func(first map[string]any) map[string]any {
		return andRule(append([]map[string]any{first}, keep...), map[string]any{"action": "bypass"})
	}
	// 顺序和内核规则表一致:订阅和节点站点直连在终端分流前面
	out := []any{}
	if o.DirectHostSet != "" {
		out = append(out, build(map[string]any{"rule_set": []string{o.DirectHostSet}}))
	}
	if len(hostCidrs) > 0 {
		out = append(out, build(map[string]any{"ip_cidr": hostCidrs}))
	}
	if len(ips) > 0 {
		out = append(out, build(map[string]any{"source_ip_cidr": ips}))
	}
	if len(macs) > 0 {
		out = append(out, build(map[string]any{"source_mac_address": macs}))
	}
	return out
}

func quicMatch() map[string]any { return map[string]any{"network": "udp", "port": 443} }

// copyMap 浅拷贝。
func copyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m)+2)
	for k, v := range m {
		out[k] = v
	}
	return out
}

// BuildRoute 相当于 buildRoute(routing, rulesetDir, options),返回 route 段和用到的规则集标签(按首次出现的顺序)。
func BuildRoute(routing any, rulesetDir string, o RouteOptions) (map[string]any, []string) {
	rulesetDir = strings.TrimRight(rulesetDir, "/")
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

	// 首包预判放行,排在 sniff 前面
	rules := []any{}
	if o.PreMatchBypass {
		pm := PreMatchOptions{
			ClientRoutes: o.ClientRoutes, DirectHosts: o.DirectHosts, DirectTag: directTag, BlockTag: blockTag,
			RuleLists: o.RuleLists, KnownOutbounds: known, TunCidrs: o.TunCidrs,
		}
		if o.DirectHostSets != nil {
			pm.DirectHostSet = o.DirectHostSets.IP
		}
		rules = append(rules, PreMatchBypassRules(conf, pm)...)
	}
	rules = append(rules, map[string]any{"action": "sniff"})

	// 热切换:出口是站点集的规则,v6 / QUIC 拒绝恒定插一条「同条件 + 开关 + 附加条件」的 logical AND——开关 ON(不是直连)
	// 才命中,翻面只改写开关文件、不重启内核。出口是节点 / 节点组 / 直连 / 拒绝的规则类别不会变,按 rejectV6For / rejectQuicFor 此刻的结论直接写
	flipFlags := FlipFlagMap(conf)
	canQuic := func(match map[string]any) bool {
		_, hasPort := match["port"]
		_, hasRange := match["port_range"]
		_, hasNet := match["network"]
		return !hasPort && !hasRange && !hasNet
	}
	// noDomain:这条是按 IP 判的那一份,只管没有域名的连接。同条件的 v6 / QUIC 拒绝也带着这个前提
	pushRule := func(rule map[string]any, noDomain bool) {
		match := copyMap(rule)
		delete(match, "outbound")
		outbound, _ := rule["outbound"].(string)
		sub := func(extra ...map[string]any) []map[string]any {
			list := []map[string]any{match}
			if noDomain {
				list = append(list, noDomainGuard())
			}
			return append(list, extra...)
		}
		routed := rule
		if noDomain {
			routed = andRule(sub(), map[string]any{"outbound": rule["outbound"]})
		}
		reject := func() map[string]any { return map[string]any{"action": "reject"} }
		if flag, has := flipFlags.Get(outbound); outbound != "" && has {
			flagRule := map[string]any{"rule_set": []string{flag}}
			if o.RejectV6For != nil {
				rules = append(rules, andRule(sub(flagRule, map[string]any{"ip_version": 6}), reject()))
			}
			if o.RejectQuicFor != nil && canQuic(match) {
				rules = append(rules, andRule(sub(flagRule, quicMatch()), reject()))
			}
			rules = append(rules, routed)
			return
		}
		if o.RejectV6For != nil && outbound != "" && o.RejectV6For(outbound) {
			if noDomain {
				rules = append(rules, andRule(sub(map[string]any{"ip_version": 6}), reject()))
			} else {
				m := copyMap(match)
				m["ip_version"] = 6
				m["action"] = "reject"
				rules = append(rules, m)
			}
		}
		if o.RejectQuicFor != nil && outbound != "" && o.RejectQuicFor(outbound) && canQuic(match) {
			if noDomain {
				rules = append(rules, andRule(sub(quicMatch()), reject()))
			} else {
				m := copyMap(match)
				for k, v := range quicMatch() {
					m[k] = v
				}
				m["action"] = "reject"
				rules = append(rules, m)
			}
		}
		rules = append(rules, routed)
	}

	dnsInbound := []string{"dns-in"}
	if o.DNSDirectInbound != "" {
		dnsInbound = append(dnsInbound, o.DNSDirectInbound)
	}
	switch dnsMode {
	case "hijack":
		// dns-in(以及名单外终端的 dns-in-direct)收到的连接一律当 DNS 处理(GitHub #550)
		rules = append(rules, map[string]any{"protocol": "dns", "action": "hijack-dns"})
		rules = append(rules, map[string]any{"inbound": dnsInbound, "action": "hijack-dns"})
	case "off":
		rules = append(rules, map[string]any{"inbound": []string{"dns-in"}, "action": "hijack-dns"})
	case "dnsmasq":
		rules = append(rules, map[string]any{"inbound": dnsInbound, "action": "hijack-dns"})
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

	// 前置自定义分流:排在所有分流规则最前面;出口必须是配置里真有的 outbound。一行一个出口,按行的先后进配置。
	// IP 只管 IP、域名只管域名(customRuleParts)
	if customPolicyActive(conf.Custom) {
		b := builtinTags{direct: directTag, block: blockTag}
		for _, rule := range conf.Custom.Rules {
			target := customOutboundTag(rule, b)
			if known != nil && !known[target] {
				continue
			}
			for _, part := range customRuleParts(rule, o.RuleLists, target) {
				if rs, ok := part.rule["rule_set"].([]string); ok {
					for _, t := range rs {
						tags.add(t)
					}
				}
				pushRule(part.rule, part.noDomain)
			}
		}
	}

	rules = append(rules, map[string]any{"ip_is_private": true, "outbound": directTag})
	// NTP 对时直连(GitHub #156):UDP 123 一律直连;排在前置自定义分流后面,真要经节点对时可以在那里写一条端口 123
	rules = append(rules, map[string]any{"network": "udp", "port": []int{123}, "outbound": directTag})

	// 订阅和节点站点直连:排在所有站点集之前
	if hs := o.DirectHostSets; hs != nil {
		rules = append(rules, map[string]any{"rule_set": []string{hs.Domain, hs.IP}, "outbound": directTag})
	} else if dh := o.DirectHosts; dh != nil && (len(dh.Domains) > 0 || len(dh.Cidrs) > 0) {
		rule := map[string]any{"outbound": directTag}
		if len(dh.Domains) > 0 {
			rule["domain"] = dh.Domains
		}
		if len(dh.Cidrs) > 0 {
			rule["ip_cidr"] = dh.Cidrs
		}
		rules = append(rules, rule)
	}

	// 终端分流:来源 IP / 网段或 MAC,排在站点集之前
	for _, cr := range o.ClientRoutes {
		match := clientroutes.SourceMatch(cr)
		if match == nil || cr.Outbound == "" {
			continue
		}
		if known != nil && !known[cr.Outbound] {
			continue
		}
		match["outbound"] = cr.Outbound
		pushRule(match, false)
	}

	// 站点集按用户排的顺序逐条匹配。每个站点集拆成「看域名」「看 IP」两份:看 IP 的那份带着「连接没有域名」的前提;
	// 规则集 + 域名 / IP 字段再拆成紧邻的两条(1.14 的规则集语义)
	for _, policy := range conf.ActivePolicies {
		for _, t := range routeRulesetTags(policy.Rulesets, o.RuleLists) {
			tags.add(t)
		}
		domain, ip := policyRouteMatches(policy, o.RuleLists)
		emit := func(m map[string]any, noDomain bool) {
			for _, part := range splitRuleSetConditions(m) {
				r := copyMap(part)
				r["outbound"] = policy.Name
				pushRule(r, noDomain)
			}
		}
		if domain != nil {
			emit(domain, false)
		}
		if ip != nil {
			emit(ip, true)
		}
	}
	// 兜底走代理时,没命中的 v6 连接 / QUIC 同样明确拒绝(final 写不了条件,单独写;挂在兜底的开关上)
	if o.RejectV6For != nil {
		rules = append(rules, andRule([]map[string]any{{"rule_set": []string{FlipFallbackTag}}, {"ip_version": 6}}, map[string]any{"action": "reject"}))
	}
	if o.RejectQuicFor != nil {
		rules = append(rules, andRule([]map[string]any{{"rule_set": []string{FlipFallbackTag}}, quicMatch()}, map[string]any{"action": "reject"}))
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
