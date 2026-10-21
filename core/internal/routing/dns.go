package routing

import (
	"errors"
	"fmt"

	"github.com/timeflysoon/Open-Box/core/internal/clientroutes"
	"github.com/timeflysoon/Open-Box/core/internal/dnsrewrite"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// 对应旧 Node 的 engine/dns.mjs:生成 sing-box 的 dns 段,同时交出「谁用哪台解析器」的映射。
// 输出用 map[string]any(sing-box 不在乎键序;数组里的规则顺序才是语义,逐条保持)。

const (
	FakeIPV4  = "198.15.0.0/15"
	FakeIPV6  = "fc00::/18"
	fakeIPTag = "dns-fakeip"
)

var localSuffixes = []string{".lan", ".local", ".home", ".internal", ".home.arpa"}

// DNSOptions 是旧版 buildDns 的 options。
type DNSOptions struct {
	SystemDNS      []any                // 路由器 WAN 下发的 DNS 上游;只取第一个真值
	GroupTags      []string             // 节点管理里出到配置的条目(含内置直连 / 拒绝)
	Builtin        builtinTags          // 内置出站的当前名字与启用开关
	Selections     map[string]any       // 内核里各 selector 当前的选择
	DirectDomains  []string             // 订阅和节点站点直连的域名
	RuleLists      ruleLists            // 规则集链接的形状表
	ClientRoutes   []clientroutes.Route // 终端分流
	KnownOutbounds map[string]bool      // nil = 没传(不检查)
	FilterRules    []any                // 域名过滤产生的 DNS 规则
}

// Resolvers 是「谁用哪台解析器」:站点集名 → 解析器 tag、前置自定义分流每一行 → tag(拒绝行 / 纯 IP 行为 null)、
// 指定终端的来源 → tag、兜底 → tag。
type Resolvers struct {
	Policies map[string]string `json:"policies"`
	Custom   []any             `json:"custom"`
	Clients  []ClientResolver  `json:"clients"`
	Fallback string            `json:"fallback"`
}

type ClientResolver struct {
	Sources []string `json:"sources"`
	Server  string   `json:"server"`
}

// DNSFakeIPEnabled:只给走代理的域名发占位地址。
func DNSFakeIPEnabled(profile any) bool {
	dns := jsx.Get(profile, "dns")
	if !jsx.Truthy(dns) {
		return false
	}
	return jsx.Get(dns, "split") != false && jsx.Get(dns, "fakeIpForProxy") == true
}

// IPv6ProxyMode:off / node / ipv4 / bypass。
func IPv6ProxyMode(profile any) string {
	if !jsx.Truthy(profile) || !jsx.Truthy(jsx.Get(profile, "ipv6")) {
		return "off"
	}
	switch jsx.Get(profile, "ipv6Proxy") {
	case "ipv4":
		return "ipv4"
	case "bypass":
		return "bypass"
	}
	return "node"
}

// IPv6InTun:开着 ipv6 且不是「不进内核」。
func IPv6InTun(profile any) bool {
	return jsx.Truthy(jsx.Get(profile, "ipv6")) && IPv6ProxyMode(profile) != "bypass"
}

// DNSMode 取 (profile.dns && profile.dns.mode) || 'hijack';非字符串的真值不等于任何已知模式。
func DNSMode(profile any) string {
	m := jsx.Get(jsx.Get(profile, "dns"), "mode")
	if !jsx.Truthy(m) {
		return "hijack"
	}
	if s, ok := m.(string); ok {
		return s
	}
	return "\x00non-string"
}

func directServerFor(profile any, o DNSOptions) map[string]any {
	var server any = "223.5.5.5"
	var first any
	for _, v := range o.SystemDNS {
		if jsx.Truthy(v) {
			first = v
			break
		}
	}
	if jsx.Truthy(first) {
		server = first
	} else if d := jsx.Get(jsx.Get(profile, "dns"), "direct"); jsx.Truthy(d) {
		server = d
	}
	return map[string]any{"type": "udp", "tag": "dns-direct", "server": server}
}

func proxyServerFor(server any, tag, detour string) map[string]any {
	m := map[string]any{"type": "tcp", "tag": tag, "detour": detour}
	if !jsx.IsUndefined(server) { // JSON.stringify 会丢掉 undefined 的键
		m["server"] = server
	}
	return m
}

// customDnsMatch:前置自定义分流的一行 → 一条 DNS 规则的匹配部分。只按 IP / 端口分流的行不进 DNS。
func customDnsMatch(r CustomRule, l ruleLists) map[string]any {
	if r.Type == "ipCidr" || r.Type == "geoip" || r.Type == "port" {
		return nil
	}
	if tag := customRuleTag(r); tag != "" {
		tags := dnsRulesetTags([]string{tag}, l)
		if len(tags) == 0 {
			return nil
		}
		return map[string]any{"rule_set": tags}
	}
	field := map[string]string{"domain": "domain", "domainSuffix": "domain_suffix", "domainKeyword": "domain_keyword"}[r.Type]
	if field == "" {
		return nil
	}
	return map[string]any{field: []string{r.Value}}
}

func localNameRules(dnsMode string) []any {
	if dnsMode != "hijack" {
		return []any{}
	}
	return []any{
		map[string]any{"domain_suffix": localSuffixes, "server": "dns-local"},
		map[string]any{"domain_regex": []string{"^[^.]+$"}, "server": "dns-local"},
	}
}

// policyDnsRule:策略的域名类条件 → 一条 DNS 规则(ip_cidr 不进来)。
func policyDnsRule(p Policy, server string, l ruleLists) map[string]any {
	rule := map[string]any{}
	if server != "" {
		rule["server"] = server
	}
	if tags := dnsRulesetTags(p.Rulesets, l); len(tags) > 0 {
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
	return rule
}

func hasDomainCondition(p Policy, l ruleLists) bool {
	return len(dnsRulesetTags(p.Rulesets, l)) > 0 || len(p.Domain) > 0 || len(p.DomainSuffix) > 0 || len(p.DomainKeyword) > 0
}

func withKeys(base map[string]any, kv ...any) map[string]any {
	out := make(map[string]any, len(base)+len(kv)/2)
	for k, v := range base {
		out[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i].(string)] = kv[i+1]
	}
	return out
}

// BuildDNS 相当于 buildDnsWithResolvers(profile, options)。
func BuildDNS(profile any, o DNSOptions) (map[string]any, Resolvers, error) {
	dnsConf := jsx.Get(profile, "dns")
	if dnsConf == nil || jsx.IsUndefined(dnsConf) {
		return nil, Resolvers{}, errors.New("Cannot read properties of undefined (reading 'split')")
	}
	strategy := "ipv4_only"
	if jsx.Truthy(jsx.Get(profile, "ipv6")) {
		strategy = "prefer_ipv4"
	}
	dnsMode := DNSMode(profile)
	directServer := directServerFor(profile, o)
	localRules := localNameRules(dnsMode)
	localServers := []any{}
	if len(localRules) > 0 {
		localServers = append(localServers, map[string]any{"type": "local", "tag": "dns-local"})
	}

	resolvers := Resolvers{Policies: map[string]string{}, Custom: []any{}, Clients: []ClientResolver{}, Fallback: "dns-direct"}
	rewrite := dnsrewrite.NormalizeDnsRewrite(dnsConf)
	rewriteRules := []any{}
	if rewrite.Enabled {
		rewriteRules = dnsrewrite.RewriteDnsRules(rewrite.Rules)
	}
	filterRules := o.FilterRules
	rewriteServers := []any{}
	if len(rewriteRules) > 0 {
		rewriteServers = append(rewriteServers, dnsrewrite.RewriteDnsServer())
	}

	if !jsx.Truthy(jsx.Get(dnsConf, "split")) {
		servers := []any{directServer}
		servers = append(servers, rewriteServers...)
		servers = append(servers, localServers...)
		only := map[string]any{"servers": servers, "final": "dns-direct", "strategy": strategy, "reverse_mapping": true}
		if len(rewriteRules) > 0 || len(localRules) > 0 || len(filterRules) > 0 {
			rules := []any{}
			rules = append(rules, rewriteRules...)
			rules = append(rules, localRules...)
			rules = append(rules, filterRules...)
			only["rules"] = rules
		}
		return only, resolvers, nil
	}

	conf := normalizeRouting(jsx.Get(profile, "routing"))
	proxyHost := extractHost(jsx.Get(dnsConf, "proxy"))
	servers := []any{directServer}
	servers = append(servers, rewriteServers...)
	servers = append(servers, proxyServerFor(proxyHost, "dns-proxy", conf.Fallback.Name))

	rules := []any{}
	rules = append(rules, rewriteRules...)
	rules = append(rules, localRules...)
	rules = append(rules, filterRules...)

	b := o.Builtin
	members := policyOutboundOptions(o.GroupTags, b)
	selections := o.Selections
	if selections == nil {
		selections = map[string]any{}
	}
	goesDirect := func(name, def string) bool { return policyGoesDirect(name, def, members, b, selections) }

	fakeIP := DNSFakeIPEnabled(profile)
	v6mode := IPv6ProxyMode(profile)
	proxyV4Only := v6mode == "ipv4"
	fakeIPTypes := []string{"A"}
	if v6mode == "node" {
		fakeIPTypes = []string{"A", "AAAA"}
	}
	emptyAAAA := func(match map[string]any) map[string]any {
		return withKeys(match, "query_type", []string{"AAAA"}, "action", "predefined", "rcode", "NOERROR")
	}
	pushProxyRule := func(match map[string]any, tag string) {
		for _, part := range splitRuleSetConditions(match) {
			if proxyV4Only {
				rules = append(rules, emptyAAAA(part))
			}
			if fakeIP {
				rules = append(rules, withKeys(part, "query_type", fakeIPTypes, "server", fakeIPTag))
			}
			rules = append(rules, withKeys(part, "server", tag))
		}
	}

	if customPolicyActive(conf.Custom) {
		serverByTarget := map[string]string{}
		for _, rule := range conf.Custom.Rules {
			match := customDnsMatch(rule, o.RuleLists)
			if match == nil {
				resolvers.Custom = append(resolvers.Custom, nil)
				continue
			}
			target := customOutboundTag(rule, b)
			if target == b.direct {
				rules = append(rules, withKeys(match, "server", "dns-direct"))
				resolvers.Custom = append(resolvers.Custom, "dns-direct")
				continue
			}
			if target == b.block {
				rules = append(rules, withKeys(match, "action", "reject"))
				resolvers.Custom = append(resolvers.Custom, nil)
				continue
			}
			tag, has := serverByTarget[target]
			if !has {
				tag = fmt.Sprintf("dns-custom-%d", len(serverByTarget))
				serverByTarget[target] = tag
				servers = append(servers, proxyServerFor(proxyHost, tag, target))
			}
			pushProxyRule(match, tag)
			resolvers.Custom = append(resolvers.Custom, tag)
		}
	}

	if len(o.DirectDomains) > 0 {
		rules = append(rules, map[string]any{"domain": o.DirectDomains, "server": "dns-direct"})
	}

	if dnsMode == "hijack" {
		serverByTarget := map[string]string{}
		for _, cr := range o.ClientRoutes {
			if len(cr.Sources) == 0 || cr.Outbound == "" {
				continue
			}
			if cr.Outbound == b.block {
				rules = append(rules, map[string]any{"source_ip_cidr": cr.Sources, "action": "reject"})
				continue
			}
			if cr.Outbound == b.direct {
				rules = append(rules, map[string]any{"source_ip_cidr": cr.Sources, "server": "dns-direct"})
				resolvers.Clients = append(resolvers.Clients, ClientResolver{cr.Sources, "dns-direct"})
				continue
			}
			if o.KnownOutbounds != nil && !o.KnownOutbounds[cr.Outbound] {
				continue
			}
			tag, has := serverByTarget[cr.Outbound]
			if !has {
				tag = fmt.Sprintf("dns-client-%d", len(serverByTarget))
				serverByTarget[cr.Outbound] = tag
				servers = append(servers, proxyServerFor(proxyHost, tag, cr.Outbound))
			}
			pushProxyRule(map[string]any{"source_ip_cidr": cr.Sources}, tag)
			resolvers.Clients = append(resolvers.Clients, ClientResolver{cr.Sources, tag})
		}
	}

	for index, policy := range conf.ActivePolicies {
		if !hasDomainCondition(policy, o.RuleLists) {
			continue
		}
		if goesDirect(policy.Name, policy.Default) {
			for _, r := range splitRuleSetConditions(policyDnsRule(policy, "dns-direct", o.RuleLists)) {
				rules = append(rules, r)
			}
			resolvers.Policies[policy.Name] = "dns-direct"
			continue
		}
		tag := fmt.Sprintf("dns-policy-%d", index)
		servers = append(servers, proxyServerFor(proxyHost, tag, policy.Name))
		pushProxyRule(policyDnsRule(policy, "", o.RuleLists), tag)
		resolvers.Policies[policy.Name] = tag
	}

	fallbackDirect := goesDirect(conf.Fallback.Name, conf.Fallback.Default)
	if fallbackDirect {
		resolvers.Fallback = "dns-direct"
	} else {
		resolvers.Fallback = "dns-proxy"
	}
	if !fallbackDirect && proxyV4Only {
		rules = append(rules, emptyAAAA(map[string]any{}))
	}
	if fakeIP {
		fs := map[string]any{"type": "fakeip", "tag": fakeIPTag, "inet4_range": FakeIPV4}
		if v6mode == "node" {
			fs["inet6_range"] = FakeIPV6
		}
		servers = append(servers, fs)
		if !fallbackDirect {
			rules = append(rules, map[string]any{"query_type": fakeIPTypes, "server": fakeIPTag})
		}
	}
	servers = append(servers, localServers...)
	final := "dns-proxy"
	if fallbackDirect {
		final = "dns-direct"
	}
	return map[string]any{"servers": servers, "rules": rules, "final": final, "strategy": strategy, "reverse_mapping": true}, resolvers, nil
}
