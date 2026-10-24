package config

import (
	"encoding/json"
	"fmt"

	"github.com/timeflysoon/Open-Box/core/internal/clientroutes"
	"github.com/timeflysoon/Open-Box/core/internal/directhosts"
	"github.com/timeflysoon/Open-Box/core/internal/dnsfilter"
	"github.com/timeflysoon/Open-Box/core/internal/emit"
	"github.com/timeflysoon/Open-Box/core/internal/groups"
	"github.com/timeflysoon/Open-Box/core/internal/ipx"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
	"github.com/timeflysoon/Open-Box/core/internal/routing"
	"github.com/timeflysoon/Open-Box/core/internal/servers"
)

// 对应基线 engine/config.mjs 的 buildConfigDetailed(逐段对照,注释里写了对应的基线段落)。
// 入参是新版 Node 发给核心的那一份:除基线的解构参数外,多了 platform、chainNodes(链式代理候选,Node 解析好的)、
// filterExpectedKey,profile 里多了 clashApiSecret。clientBindings 基线里没有对应逻辑,目前只收下不用;platform 只有 container 有行为(dns-in-lan,见 README)。

const defaultCachePath = "/opt/open-box/data/cache.db"

// toAny 把任意值走一遍 JSON,得到和 Node 收到的一样的形态(map[string]any / []any / float64 ...)。
func toAny(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		panic(err)
	}
	return out
}

func asList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return []any{}
}

func strsToAny(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

// appendTo 往 m[key] 这个数组末尾追加(不存在就新建)。
func appendTo(m map[string]any, key string, items ...any) {
	var cur []any
	switch v := m[key].(type) {
	case []any:
		cur = v
	case []map[string]any:
		for _, e := range v {
			cur = append(cur, e)
		}
	}
	m[key] = append(append([]any{}, cur...), items...)
}

func localEntry(tag, format, path string) map[string]any {
	return map[string]any{"type": "local", "tag": tag, "format": format, "path": path}
}

// BuildDetailed 返回 {config, dnsRuleOwners, directHosts, failover}。
func BuildDetailed(args any) (map[string]any, error) {
	get := func(k string) any { return jsx.Get(args, k) }
	nodes := asList(get("nodes"))
	profile := get("profile")
	userGroups := get("userGroups")
	subscriptions := asList(get("subscriptions"))

	selections := map[string]any{}
	if m, ok := get("selections").(map[string]any); ok {
		selections = m
	}
	cacheFilePath := defaultCachePath
	if v := get("cacheFilePath"); !jsx.IsUndefined(v) {
		cacheFilePath = jsx.ToString(v)
	}
	rulesetDir := DefaultRulesetDir
	if v := get("rulesetDir"); !jsx.IsUndefined(v) {
		// null 当空字符串(上游拼路径时是 rulesetDir ?? "")
		if v == nil {
			rulesetDir = ""
		} else {
			rulesetDir = jsx.ToString(v)
		}
	}
	var tlsCert any = map[string]any{"certPath": "/opt/open-box/etc/certs/server.crt", "keyPath": "/opt/open-box/etc/certs/server.key"}
	if v := get("tlsCert"); !jsx.IsUndefined(v) {
		tlsCert = v
	}
	inlineDirectHosts := get("inlineDirectHosts")
	if jsx.IsUndefined(inlineDirectHosts) {
		inlineDirectHosts = false
	}

	// ---- 订阅和节点站点直连(默认开)----
	var dh *routing.DirectHosts
	if jsx.Get(profile, "directForNodes") != false {
		h := directhosts.Collect(nodes, subscriptions)
		seen := map[string]bool{}
		cidrs := []string{}
		add := func(c string) {
			if !seen[c] {
				seen[c] = true
				cidrs = append(cidrs, c)
			}
		}
		for _, c := range h.Cidrs {
			add(c)
		}
		for _, c := range asList(get("directHostCidrs")) {
			if s, ok := c.(string); ok {
				add(s)
			}
		}
		kept := []string{}
		for _, c := range cidrs {
			if !directhosts.IsSharedCdnCidr(c) {
				kept = append(kept, c)
			}
		}
		domains := h.Domains
		if domains == nil {
			domains = []string{}
		}
		dh = &routing.DirectHosts{Domains: domains, Cidrs: kept}
	}
	var directHostSets *routing.DirectHostSets
	if dh != nil && !jsx.Truthy(inlineDirectHosts) {
		directHostSets = &routing.DirectHostSets{Domain: directhosts.NodeDirectDomainTag, IP: directhosts.NodeDirectIPTag}
	}
	var inlineHosts *routing.DirectHosts
	if directHostSets == nil && dh != nil {
		if inlineDirectHosts != "aligned" {
			inlineHosts = dh
		} else {
			inlineHosts = &routing.DirectHosts{Domains: dh.Domains, Cidrs: dh.Cidrs}
			if len(dh.Domains) == 0 {
				inlineHosts.Domains = []string{directhosts.NodeDirectPlaceholderDomain}
			}
			if len(dh.Cidrs) == 0 {
				inlineHosts.Cidrs = []string{directhosts.NodeDirectPlaceholderCidr}
			}
		}
	}

	// ---- 链式代理:核对过上游和环之后并进节点表 ----
	chain, err := resolveChainNodes(get("chainNodes"), nodes, userGroups)
	if err != nil {
		return nil, err
	}
	allNodes := append(append([]any{}, nodes...), chain...)
	wireguardNodes, outboundNodes := []any{}, []any{}
	for _, n := range allNodes {
		if jsx.Get(n, "type") == "wireguard" {
			wireguardNodes = append(wireguardNodes, n)
		} else {
			outboundNodes = append(outboundNodes, n)
		}
	}

	// ---- 节点组 ----
	var groupsIn any = userGroups
	if !jsx.Truthy(groupsIn) {
		groupsIn = []any{}
	}
	emitRes, err := groups.EmitUserGroups(groupsIn, allNodes, map[string]any{
		"testUrl":        jsx.Get(profile, "testUrl"),
		"expectedStatus": jsx.Get(profile, "testExpectedStatus"),
	})
	if err != nil {
		return nil, err
	}
	b := routing.NewBuiltin(emitRes.Builtin.Direct, emitRes.Builtin.Block, emitRes.Builtin.DirectEnabled, emitRes.Builtin.BlockEnabled)
	userGroupOutbounds := asList(toAny(emitRes.Outbounds))

	// ---- 站点集 selector ----
	routingConf := routing.NormalizeRouting(jsx.Get(profile, "routing"))
	groupTags := emitRes.PublicTags
	policyMemberTags := routing.PolicyOutboundOptions(groupTags, b)
	asSelector := func(tag, preferred string) map[string]any {
		return map[string]any{
			"type": "selector", "tag": tag, "outbounds": strsToAny(policyMemberTags),
			"default": routing.EffectiveOutbound(preferred, policyMemberTags, b),
		}
	}
	outbounds := append([]any{}, userGroupOutbounds...)
	for _, p := range routingConf.ActivePolicies {
		outbounds = append(outbounds, asSelector(p.Name, p.Default))
	}
	outbounds = append(outbounds, asSelector(routingConf.Fallback.Name, routingConf.Fallback.Default))

	// ---- 节点出站 / endpoint ----
	nodeDns := PlanNodeDNS(subscriptions)
	for _, n := range outboundNodes {
		o, err := emit.EmitOutbound(n)
		if err != nil {
			return nil, err
		}
		outbounds = append(outbounds, WithNodeResolver(o, nodeDns.Lookup(jsx.Get(n, "subscriptionId"))))
	}
	endpoints := []any{}
	for _, n := range wireguardNodes {
		e, err := emit.EmitEndpoint(n)
		if err != nil {
			return nil, err
		}
		endpoints = append(endpoints, e)
	}

	dnsMode := routing.DNSMode(profile)
	if dnsMode == "dnsmasq" {
		outbounds = append(outbounds, map[string]any{"type": "direct", "tag": DNSMasqOutboundTag, "bind_interface": "lo"})
	}
	if dup, found := FindDuplicateTag(append(append([]any{}, outbounds...), endpoints...)); found {
		return nil, fmt.Errorf("出站名称重复:「%s」——节点组、站点集、节点、内置直连/拒绝之间不能同名,请改名后再启动", dup)
	}

	// ---- 终端分流 / 出口类别 ----
	clientRoutes := clientroutes.NormalizeClientRoutes(jsx.Get(profile, "clientRoutes"), b.Direct())
	knownOutbounds := map[string]bool{}
	for _, o := range append(append([]any{}, outbounds...), endpoints...) {
		if t, ok := jsx.Get(o, "tag").(string); ok {
			knownOutbounds[t] = true
		}
	}
	classes := routing.PolicyClasses(jsx.Get(profile, "routing"), policyMemberTags, b, selections)
	isProxyOutbound := func(tag string) bool {
		if tag == b.Direct() || tag == b.Block() {
			return false
		}
		if c, has := classes[tag]; has {
			return c == "proxy"
		}
		return true
	}
	var rejectV6For, rejectQuicFor func(string) bool
	if routing.IPv6ProxyMode(profile) == "ipv4" {
		rejectV6For = isProxyOutbound
	}
	if jsx.Get(profile, "rejectQuic") == true {
		rejectQuicFor = isProxyOutbound
	}
	filtering, err := dnsfilter.Build(profile, get("dnsFilter"), get("filterExpectedKey"))
	if err != nil {
		return nil, err
	}

	tun := jsx.Get(profile, "tun")
	autoRedirect := jsx.Truthy(tun) && jsx.Truthy(jsx.Get(tun, "autoRedirect")) && dnsMode != "off"
	directBypass := jsx.Get(profile, "directBypass") != false
	splitDNS := jsx.Truthy(jsx.Get(profile, "dns")) && jsx.Truthy(jsx.Get(jsx.Get(profile, "dns"), "split"))
	admitDirect := clientroutes.AdmitDNSDirect(jsx.Get(profile, "clientRoutes"), map[string]any{"dnsMode": dnsMode, "autoRedirect": autoRedirect, "splitDns": splitDNS})
	admitTag := ""
	if admitDirect {
		admitTag = DNSDirectInboundTag
	}

	// ---- DNS ----
	dnsOpts := routing.DNSOptions{
		SystemDNS: asList(get("systemDns")), GroupTags: groupTags, Builtin: b, Selections: selections,
		DirectHostSets: directHostSets, RuleLists: routing.ParseRuleLists(get("ruleLists")), ClientRoutes: clientRoutes,
		KnownOutbounds: knownOutbounds, FilterRules: filtering.Rules,
		Terminal: routing.TerminalDNS{AutoRedirect: autoRedirect, DirectBypassOff: !directBypass, AdmitDirect: admitTag},
	}
	if inlineHosts != nil {
		dnsOpts.DirectDomains = inlineHosts.Domains
	}
	dnsRes, err := routing.BuildDNS(profile, dnsOpts)
	if err != nil {
		return nil, err
	}
	dns := toAny(dnsRes.DNS).(map[string]any)
	if len(nodeDns.Servers) > 0 {
		for _, s := range nodeDns.Servers {
			appendTo(dns, "servers", s)
		}
	}

	// ---- 路由 ----
	v6InTun := routing.IPv6InTun(profile)
	tunCidrs := []string{TunV4Net}
	if v6InTun {
		tunCidrs = []string{TunV4Net, TunV6Net}
	}
	dnsmasqTag := ""
	if dnsMode == "dnsmasq" {
		dnsmasqTag = DNSMasqOutboundTag
	}
	routeRaw, _ := routing.BuildRoute(jsx.Get(profile, "routing"), rulesetDir, routing.RouteOptions{
		DNSMode: dnsMode, DirectTag: b.Direct(), BlockTag: b.Block(), DirectHostSets: directHostSets, DirectHosts: inlineHosts,
		RejectV6For: rejectV6For, RejectQuicFor: rejectQuicFor, TunCidrs: tunCidrs, DnsmasqTag: dnsmasqTag,
		ClientRoutes: clientRoutes, KnownOutbounds: knownOutbounds, RuleLists: routing.ParseRuleLists(get("ruleLists")),
		PreMatchBypass: autoRedirect && directBypass, DNSDirectInbound: admitTag,
	})
	route := toAny(routeRaw).(map[string]any)
	if len(filtering.Sets) > 0 {
		appendTo(route, "rule_set", filtering.Sets...)
	}
	if directHostSets != nil {
		for _, s := range directhosts.NodeDirectRuleSets(rulesetDir) {
			appendTo(route, "rule_set", s)
		}
	}
	flipDir := FlipDirFor(rulesetDir)
	if v := get("flipDir"); jsx.Truthy(v) {
		flipDir = jsx.ToString(v)
	}
	normRouting := routing.NormalizeRouting(jsx.Get(profile, "routing"))
	seenFlag := map[string]bool{}
	routing.FlipFlagMap(normRouting).Each(func(_, tag string) {
		if !seenFlag[tag] {
			seenFlag[tag] = true
			appendTo(route, "rule_set", localEntry(tag, "source", flipDir+"/"+tag+".json"))
		}
	})

	// ---- tun 入站 ----
	tunAddress := []any{TunV4}
	if v6InTun {
		tunAddress = []any{TunV4, TunV6}
	}
	localSubnets := asList(get("localSubnets"))
	holes := []any{TunV4Net, TunV6Net}
	if autoRedirect && dnsMode == "hijack" {
		holes = append(append([]any{}, localSubnets...), TunV4Net, TunV6Net)
	}
	fakeIP := routing.DNSFakeIPEnabled(profile)
	if fakeIP && routing.IPv6ProxyMode(profile) == "node" {
		holes = append(holes, routing.FakeIPV6)
	}
	excludeBase := strsToAny(TunExcludeV4)
	if v6InTun {
		excludeBase = append(excludeBase, strsToAny(TunExcludeV6)...)
	}
	protectedSubnets := append(append([]any{}, localSubnets...), TunV4Net, TunV6Net, "127.0.0.0/8", "169.254.0.0/16", "::1/128", "fe80::/10")
	if routing.CustomPolicyActive(routingConf.Custom) {
		for _, rule := range routingConf.Custom.Rules {
			if rule.Type != "ipCidr" {
				continue
			}
			if _, ok := ipx.ParseCidr(rule.Value); !ok {
				continue
			}
			target := routing.CustomOutboundTag(rule, b)
			if target == b.Direct() || target == b.Block() || !knownOutbounds[target] {
				continue
			}
			overlaps := false
			for _, base := range excludeBase {
				if ipx.CidrsOverlap(base, rule.Value) {
					overlaps = true
					break
				}
			}
			if !overlaps {
				continue
			}
			for _, h := range ipx.SubtractCidrs([]any{rule.Value}, protectedSubnets) {
				holes = append(holes, h)
			}
		}
	}
	routeExclude := ipx.SubtractCidrs(excludeBase, holes)
	if autoRedirect {
		routeExclude = ipx.SubtractCidrs(strsToAny(routeExclude), strsToAny(EndOfAddressSpace))
	}
	tunInbound := map[string]any{
		"type": "tun", "interface_name": TunInterfaceName, "tag": "tun-in", "address": tunAddress,
		"auto_route": true, "strict_route": routing.IPv6ProxyMode(profile) != "bypass", "stack": TunStack(profile),
		"route_exclude_address": strsToAny(routeExclude), "udp_timeout": TunUDPTimeout,
	}
	if mtu := TunMTU(profile); mtu != 0 {
		tunInbound["mtu"] = mtu
	}
	if autoRedirect {
		tunInbound["auto_redirect"] = true
	}
	if bypassMacs := clientroutes.BypassSources(jsx.Get(profile, "clientRoutes")).Macs; autoRedirect && len(bypassMacs) > 0 {
		tunInbound["exclude_mac_address"] = strsToAny(bypassMacs)
	}
	admit := clientroutes.AdmitSources(jsx.Get(profile, "clientRoutes"))
	if autoRedirect && len(admit.Macs) > 0 && len(admit.IPs) == 0 {
		tunInbound["include_mac_address"] = strsToAny(admit.Macs)
	}
	if autoRedirect && dnsMode != "off" {
		tunInbound["dns_mode"] = "hijack"
		if v6InTun {
			tunInbound["dns_address"] = []any{TunV4Peer, TunV6Peer}
		} else {
			tunInbound["dns_address"] = []any{TunV4Peer}
		}
	} else {
		tunInbound["dns_mode"] = "disabled"
	}

	// ---- 入口原生旁路 ----
	var bypassEnabled bool
	var bypassSets []string
	var trimmed map[string]bool
	if nb := get("nativeBypass"); jsx.Truthy(nb) && isObjectLike(nb) {
		bypassEnabled = jsx.Truthy(jsx.Get(nb, "enabled"))
		for _, s := range asList(jsx.Get(nb, "sets")) {
			if str, ok := s.(string); ok {
				bypassSets = append(bypassSets, str)
			}
		}
		trimmed = map[string]bool{}
		if tm, ok := jsx.Get(nb, "trimmed").(map[string]any); ok {
			for k, v := range tm {
				trimmed[k] = jsx.Truthy(v)
			}
		}
	} else {
		plan := routing.NativeBypassPlan(jsx.Get(profile, "routing"), map[string]any{
			"members":    strsToAny(policyMemberTags),
			"builtin":    map[string]any{"direct": b.Direct(), "block": b.Block(), "directEnabled": emitRes.Builtin.DirectEnabled, "blockEnabled": emitRes.Builtin.BlockEnabled},
			"selections": selections, "clientRoutes": toAny(clientRoutes), "fakeIp": fakeIP, "dnsMode": dnsMode, "enabled": directBypass,
		})
		bypassEnabled, bypassSets = plan.Enabled, plan.Sets
	}
	if autoRedirect {
		candidates := routing.FlipBypassCandidates(normRouting)
		if len(candidates) > 0 {
			sets := []any{}
			for _, t := range candidates {
				sets = append(sets, routing.FlipBypassTag(t))
				appendTo(route, "rule_set", localEntry(routing.FlipBypassTag(t), "binary", flipDir+"/"+routing.FlipBypassTag(t)+".srs"))
			}
			tunInbound["route_exclude_address_set"] = sets
		}
		need := append([]string{}, routing.FlipNeedFixed...)
		for _, t := range candidates {
			need = append(need, routing.FlipNeedTag(t))
		}
		tunInbound["route_address_set"] = strsToAny(need)
		for _, t := range need {
			appendTo(route, "rule_set", localEntry(t, "binary", flipDir+"/"+t+".srs"))
		}
	} else if bypassEnabled && len(bypassSets) > 0 {
		trimmedTags, whole := []string{}, []string{}
		for _, t := range bypassSets {
			if trimmed[t] {
				trimmedTags = append(trimmedTags, t)
			} else {
				whole = append(whole, t)
			}
		}
		sets := strsToAny(whole)
		for _, t := range trimmedTags {
			sets = append(sets, routing.FlipBypassTag(t))
		}
		tunInbound["route_exclude_address_set"] = sets
		for _, t := range trimmedTags {
			appendTo(route, "rule_set", localEntry(routing.FlipBypassTag(t), "binary", flipDir+"/"+routing.FlipBypassTag(t)+".srs"))
		}
	}

	// ---- 入站 ----
	inbounds := []any{tunInbound, map[string]any{"type": "mixed", "tag": PanelInboundTag, "listen": "127.0.0.1", "listen_port": PanelInboundPort}}
	listen := "0.0.0.0"
	if jsx.Truthy(jsx.Get(profile, "ipv6")) {
		listen = "::"
	}
	inbounds = append(inbounds, map[string]any{"type": "direct", "tag": "dns-in", "listen": listen, "listen_port": DNSInboundPort})
	if jsx.Get(args, "platform") == "container" {
		// 容器部署:额外监听 0.0.0.0:53 的 dns-in-lan,和 dns-in 一样当 DNS 劫持(对官方 v0.1.353 差分核对)
		inbounds = append(inbounds, map[string]any{"type": "direct", "tag": DNSLanInboundTag, "listen": "0.0.0.0", "listen_port": DNSLanInboundPort})
	}
	if admitDirect {
		inbounds = append(inbounds, map[string]any{"type": "direct", "tag": DNSDirectInboundTag, "listen": listen, "listen_port": DNSDirectInboundPort})
	}
	shareInbounds := asList(toAny(servers.BuildServerInbounds(jsx.Get(profile, "servers"), tlsCert)))
	inbounds = append(inbounds, shareInbounds...)
	shareTags := []any{}
	for _, i := range shareInbounds {
		shareTags = append(shareTags, jsx.Get(i, "tag"))
	}
	route["rules"] = clientroutes.GuardTerminalRules(route["rules"], shareTags)
	if jsx.Get(args, "platform") == "container" {
		route["rules"] = append([]any{map[string]any{"action": "hijack-dns", "inbound": []any{DNSLanInboundTag}}}, asList(route["rules"])...)
	}
	if jsx.Truthy(dns["rules"]) {
		dns["rules"] = clientroutes.GuardTerminalRules(dns["rules"], shareTags)
	}

	// ---- 装配 ----
	clash := map[string]any{"external_controller": "127.0.0.1:9095"}
	if secret := jsx.Get(profile, "clashApiSecret"); !jsx.IsUndefined(secret) {
		clash["secret"] = secret
	}
	cachePath := cacheFilePath
	if fakeIP {
		cachePath = routing.FakeIPCachePath(cacheFilePath)
	}
	if fakeIP {
		for _, o := range outbounds {
			m, ok := o.(map[string]any)
			if !ok || m["type"] != "selector" {
				continue
			}
			tag, _ := m["tag"].(string)
			selected, has := selections[tag]
			if !has {
				continue
			}
			for _, member := range asList(m["outbounds"]) {
				if member == selected {
					m["default"] = selected
					break
				}
			}
		}
	}
	config := map[string]any{
		"log": map[string]any{"level": "warn"}, "dns": dns, "inbounds": inbounds, "outbounds": outbounds, "route": route,
		"experimental": map[string]any{"clash_api": clash, "cache_file": map[string]any{"enabled": true, "path": cachePath, "store_fakeip": fakeIP}},
	}
	if len(endpoints) > 0 {
		config["endpoints"] = endpoints
	}
	owners := toAny(dnsRes.RuleOwners)
	if owners == nil {
		owners = []any{}
	}
	var directHostsOut any
	if dh != nil {
		directHostsOut = map[string]any{"domains": strsToAny(dh.Domains), "cidrs": strsToAny(dh.Cidrs)}
	}
	failover := toAny(emitRes.Failover)
	if failover == nil {
		failover = []any{}
	}
	return map[string]any{"config": config, "dnsRuleOwners": owners, "directHosts": directHostsOut, "failover": failover}, nil
}

func isObjectLike(v any) bool {
	switch v.(type) {
	case map[string]any, []any:
		return true
	}
	return false
}
