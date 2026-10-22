package routing

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/timeflysoon/Open-Box/core/internal/clientroutes"
	"github.com/timeflysoon/Open-Box/core/internal/dnsrewrite"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// 对应上游 engine/dns.mjs(基线 v0.1.318 快照)的 buildDnsWithResolvers:生成 sing-box 的 dns 段,
// 同时交出「谁用哪台解析器」的映射(Resolvers)和每条 dns.rules 归谁(RuleOwners)。
// 输出用 map[string]any(sing-box 不在乎键序;数组里的规则顺序才是语义,逐条保持)。
//
// 相对旧版(backup 分支)的主要变化,都在 buildDnsWithResolvers 里:
//   - 代理侧只有一组解析器(dns-proxy + 每个备用上游一台 dns-proxy__altN),不再每个站点集 / 自定义出口 / 终端各开一台;
//   - 直连侧 / 代理侧都可以配备用上游,和主上游并发竞速(evaluate + respond),谁先给出 NOERROR 用谁的;
//   - 站点集和兜底的代理支包进热切换开关(flip.go),直连支紧跟其后,翻面只改开关文件、不重启内核;
//   - 终端分流按终端答:「不进内核」「直连」的终端用单独的 dns-terminal-direct;dnsmasq 模式下本地主机名交回 dnsmasq;
//   - HTTPS / SVCB 查询直接回 NOERROR 空应答;DNS 重写、订阅 / 节点站点直连的规则集、FakeIP、IPv6 分层照新基线。

const (
	FakeIPV4  = "198.19.0.0/16"
	FakeIPV6  = "fc00::/18"
	fakeIPTag = "dns-fakeip"

	// ProxyResolverTag 是代理侧的解析器:走代理的域名(站点集、兜底、前置自定义分流、终端分流)都交给它。
	// 连上游走哪条线路由部署时的「目标分流」按上游地址判(Node 端写 detour),这里先写兜底的 selector。
	ProxyResolverTag = "dns-proxy"
	// TerminalDirectTag 是按终端答的直连解析器:和 dns-direct 同一个上游,单独一个 tag。内核只把 dns-direct 那一组的
	// 应答写进入口放行集合,这些终端的答案不能写进去。
	TerminalDirectTag = "dns-terminal-direct"
)

var localSuffixes = []string{".lan", ".local", ".home", ".internal", ".home.arpa"}

// FakeIPCachePath:按地址池隔离缓存文件(旧内核清理单栈 FakeIP 缓存时缺失的 IPv6 bucket 会使事务回滚;
// 升级换池后也不会继续返回旧占位地址)。
func FakeIPCachePath(base string) string {
	return base + ".fakeip-" + regexp.MustCompile(`[^a-zA-Z0-9]`).ReplaceAllString(FakeIPV4+"-"+FakeIPV6, "_")
}

// DNSStrategy:内核解析的地址族。没开 IPv6 只要 A(路由器上 v6 出不去)。
func DNSStrategy(profile any) string {
	if jsx.Truthy(jsx.Get(profile, "ipv6")) {
		return "prefer_ipv4"
	}
	return "ipv4_only"
}

// DirectHostSets:订阅和节点站点直连的本地规则集(部署时的 directHostSets)。地址变了只换文件、不重启内核。
// DirectHostSets 是订阅和节点站点直连的两份本地规则集 tag(域名 / IP);dns 只用域名那份,route 两份都用。
type DirectHostSets struct{ Domain, IP string }

// TerminalDNS 对应 options.terminalDns。
type TerminalDNS struct {
	AutoRedirect bool
	// DirectBypassOff 为真表示「直连不进内核」关着(JS 里 directBypass === false)。取反存放,零值就是 JS 的缺省(开)。
	DirectBypassOff bool
	// AdmitDirect:「只让这些终端进内核」名单外终端的专用入站 tag(engine/config.mjs 的 DNS_DIRECT_INBOUND_TAG);空串 = 没有。
	AdmitDirect string
}

// DNSOptions 是旧版 buildDns 的 options。
type DNSOptions struct {
	SystemDNS      []any                // 部署时读到的系统上游 DNS;「上游 DNS」取第一个真值
	GroupTags      []string             // 节点管理里出到配置的条目(含内置直连 / 拒绝)
	Builtin        builtinTags          // 内置出站的当前名字与启用开关
	Selections     map[string]any       // 内核里各 selector 当前的选择
	DirectHostSets *DirectHostSets      // 订阅和节点站点直连(规则集形态,部署用);nil = 没有
	DirectDomains  []string             // 订阅和节点站点直连(直接给域名,测试用);DirectHostSets 为 nil 时才用
	RuleLists      ruleLists            // 规则集链接的形状表
	ClientRoutes   []clientroutes.Route // 终端分流(normalizeClientRoutes 整理过的)
	KnownOutbounds map[string]bool      // nil = 没传(不检查)
	FilterRules    []any                // 域名过滤产生的 DNS 规则
	Terminal       TerminalDNS
}

// Resolvers 是「谁用哪台解析器」:站点集名 → 解析器 tag、前置自定义分流每一行 → tag(拒绝行 / 纯 IP 行为 null)、
// 指定终端的来源 → tag、兜底 → tag。routing 的 buildRoute 按它给路由规则加「先解析再判 IP 规则」的 resolve 动作。
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

// RuleOwner:每条 dns.rules 归谁。内核日志里 `dns: match[N]` 只给规则下标,直连应答放行要知道命中的是哪个站点集,
// 才能按站点集顺序判「前面有没有走代理的 IP 规则会先抢走这个地址」。记成区段 [From, To)。
// Kind:custom(前置自定义第 Index 行)/ directHosts / client / policy(第 Index 个站点集)/ fallback。
type RuleOwner struct {
	From  int    `json:"from"`
	To    int    `json:"to"`
	Kind  string `json:"kind"`
	Index int    `json:"index"`
	Name  string `json:"name"`
}

type DNSResult struct {
	DNS        map[string]any `json:"dns"`
	Resolvers  Resolvers      `json:"resolvers"`
	RuleOwners []RuleOwner    `json:"ruleOwners"`
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

func merge(a, b map[string]any) map[string]any {
	out := make(map[string]any, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

// extraTag:备用上游的服务器 tag,主 tag 后面挂序号(从 1 起)。tag 只在配置内部用,不对外。
func extraTag(tag string, i int) string { return fmt.Sprintf("%s__alt%d", tag, i+1) }

func httpsRRRule() map[string]any {
	// HTTPS(65)/ SVCB(64)类型的查询直接回 NOERROR 空应答:浏览器并发发 A / AAAA / HTTPS 三种查询,HTTPS 那条经代理侧
	// 解析器常常没有应答,浏览器要等它超时(约 10 秒)才重试。HTTPS 记录只用来做 ECH / ALPN 提示,没有它浏览器直接按 A / AAAA 连。
	return map[string]any{"query_type": []string{"HTTPS", "SVCB"}, "action": "predefined", "rcode": "NOERROR"}
}

func localNameRules(dnsMode string) []any {
	// 劫持模式下局域网的查询根本到不了 dnsmasq,而本地主机名(DHCP 租约名、/etc/hosts、*.lan)只有 dnsmasq 认得:
	// 这类名字交给 local(→ 路由器自己的 dnsmasq),其余一律不走 local。dnsmasq 转发模式不需要:客户端本来就先经过 dnsmasq。
	if dnsMode != "hijack" {
		return []any{}
	}
	return []any{
		map[string]any{"domain_suffix": localSuffixes, "server": "dns-local"},
		map[string]any{"domain_regex": []string{"^[^.]+$"}, "server": "dns-local"},
	}
}

// BuildDNS 相当于 buildDnsWithResolvers(profile, options)。
func BuildDNS(profile any, o DNSOptions) (DNSResult, error) {
	dnsConf := jsx.Get(profile, "dns")
	if jsx.IsUndefined(dnsConf) {
		return DNSResult{}, errors.New("Cannot read properties of undefined (reading 'split')")
	}
	if dnsConf == nil {
		return DNSResult{}, errors.New("Cannot read properties of null (reading 'split')")
	}
	strategy := DNSStrategy(profile)
	dnsMode := DNSMode(profile)
	b := o.Builtin
	directUp := directUpstream(profile, o.SystemDNS)
	directServer := dnsServerEntry(directUp, "dns-direct", "")
	localRules := localNameRules(dnsMode)
	localServers := []any{}
	if len(localRules) > 0 {
		localServers = append(localServers, map[string]any{"type": "local", "tag": "dns-local"})
	}

	resolvers := Resolvers{Policies: map[string]string{}, Custom: []any{}, Clients: []ClientResolver{}, Fallback: "dns-direct"}
	ruleOwners := []RuleOwner{}

	// DNS 重写(engine/dns-rewrite.mjs):命中源域名的查询交给面板进程开的重写服务,排在所有规则最前面。
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

	// 终端分流:哪些终端的解析由内核按终端答。劫持模式下内核接得到每台终端的查询,老样子全部按终端答;
	// dnsmasq 模式下只有入口把查询转给内核 DNS 入站的那几类才看得到来源。
	split := jsx.Truthy(jsx.Get(dnsConf, "split"))
	tdo := clientroutes.TerminalDNSOptions{
		DNSMode: dnsMode, AutoRedirect: o.Terminal.AutoRedirect, DirectBypass: !o.Terminal.DirectBypassOff,
		SplitDNS: split, DirectTag: b.direct, BlockTag: b.block,
	}
	answersPerTerminal := func(cr clientroutes.Route) bool {
		return dnsMode == "hijack" || clientroutes.TerminalDNSRedirected(cr, tdo)
	}
	// 「只让这些终端进内核」名单外终端的专用入站:查询一律直连解析。
	admitInbound := o.Terminal.AdmitDirect
	// dnsmasq 模式下转进来的终端不再经过 dnsmasq:本地主机名照劫持模式的办法交回 dnsmasq,只管这些终端。
	terminalLocalRules := []any{}
	if dnsMode == "dnsmasq" {
		matches := []map[string]any{}
		for _, cr := range o.ClientRoutes {
			if !clientroutes.TerminalDNSRedirected(cr, tdo) {
				continue
			}
			if m := clientroutes.SourceMatch(cr); m != nil {
				matches = append(matches, m)
			}
		}
		if admitInbound != "" {
			matches = append(matches, map[string]any{"inbound": []string{admitInbound}})
		}
		for _, m := range matches {
			terminalLocalRules = append(terminalLocalRules,
				merge(m, map[string]any{"domain_suffix": localSuffixes, "server": "dns-local"}),
				merge(m, map[string]any{"domain_regex": []string{"^[^.]+$"}, "server": "dns-local"}))
		}
	}

	if !split {
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
		return DNSResult{DNS: only, Resolvers: resolvers, RuleOwners: ruleOwners}, nil
	}

	conf := normalizeRouting(jsx.Get(profile, "routing"))
	proxyUp := proxyUpstream(profile, o.SystemDNS)
	proxyExtras := proxyExtraUpstreams(profile, o.SystemDNS)
	directExtras := directExtraUpstreams(profile, o.SystemDNS)
	// 代理侧只有这一组解析器:detour 先写兜底的 selector,部署时按目标分流改成上游地址该走的出口。
	// 上游 DNS 固定直连,不写 detour。
	proxyDetour := func(up upstream) string {
		if up.Wan {
			return ""
		}
		return conf.Fallback.Name
	}
	servers := []any{directServer}
	for i, up := range directExtras {
		servers = append(servers, dnsServerEntry(up, extraTag("dns-direct", i), ""))
	}
	servers = append(servers, rewriteServers...)
	servers = append(servers, dnsServerEntry(proxyUp, ProxyResolverTag, proxyDetour(proxyUp)))
	for i, up := range proxyExtras {
		servers = append(servers, dnsServerEntry(up, extraTag(ProxyResolverTag, i), proxyDetour(up)))
	}

	// 规则顺序和连接侧(routing)对齐:DNS 重写 → 本地主机名 → 前置自定义分流 → 订阅 / 节点站点直连 → 终端分流 → 站点集 → 兜底。
	rules := []any{}
	rules = append(rules, rewriteRules...)
	rules = append(rules, localRules...)
	rules = append(rules, terminalLocalRules...)
	rules = append(rules, httpsRRRule())
	rules = append(rules, filterRules...)

	own := func(kind string, index int, name string, body func()) {
		from := len(rules)
		body()
		if len(rules) > from {
			ruleOwners = append(ruleOwners, RuleOwner{From: from, To: len(rules), Kind: kind, Index: index, Name: name})
		}
	}

	// 按终端答的直连解析器:有终端用到时才建,备用上游跟 dns-direct 一样竞速。
	terminalDirectServers := false
	terminalDirect := func() string {
		if !terminalDirectServers {
			terminalDirectServers = true
			servers = append(servers, merge(directServer, map[string]any{"tag": TerminalDirectTag}))
			for i, up := range directExtras {
				servers = append(servers, dnsServerEntry(up, extraTag(TerminalDirectTag, i), ""))
			}
		}
		return TerminalDirectTag
	}

	// 每个站点集的域名怎么解析,看它此刻实际走哪:走直连 → dns-direct;走代理 → 代理侧解析器。"此刻走哪"优先用内核里
	// 当前的选择(selections),内核没在跑时才退回档案里的默认。
	members := policyOutboundOptions(o.GroupTags, b)
	selections := o.Selections
	if selections == nil {
		selections = map[string]any{}
	}
	goesDirect := func(name, def string) bool { return policyGoesDirect(name, def, members, b, selections) }

	fakeIP := DNSFakeIPEnabled(profile)
	v6mode := IPv6ProxyMode(profile)
	// 代理 v6 降为 IPv4:走代理的匹配 AAAA 直接回空(NOERROR、没有记录)。用 predefined 动作而不是规则上的
	// strategy: ipv4_only——后者在 sing-box 1.14 里是遗留写法,和 query_type 不能共存、启动直接 FATAL。
	proxyV4Only := v6mode == "ipv4"
	// FakeIP 的占位只在「代理也管 v6」(交给节点)时连 AAAA 一起给。
	fakeIPTypes := []string{"A"}
	if v6mode == "node" {
		fakeIPTypes = []string{"A", "AAAA"}
	}
	emptyAAAA := func(match map[string]any) map[string]any {
		return merge(match, map[string]any{"query_type": []string{"AAAA"}, "action": "predefined", "rcode": "NOERROR"})
	}

	// 竞速规则:mk(tail) 负责套上这条规则该有的条件(普通规则 / 带热切换开关的 logical),这里只管「并发发起 +
	// 谁先回 NOERROR 谁赢 + 都没成时落回普通规则」。没配备用上游时退化成一条普通规则。
	// 响应 tag 必须整份配置唯一(内核:duplicate evaluate tag 直接 FATAL);同一条规则被 splitRuleSetConditions 拆成几段时,每段各占一个号。
	raceSeq := 0
	pushRaceOrPlain := func(mk func(tail map[string]any) any, tag string, extras []upstream) {
		if len(extras) == 0 {
			rules = append(rules, mk(map[string]any{"server": tag}))
			return
		}
		tags := []string{tag}
		for i := range extras {
			tags = append(tags, extraTag(tag, i))
		}
		round := raceSeq
		raceSeq++
		responseTag := func(i int) string { return fmt.Sprintf("race-%d-%d", round, i) }
		for i, t := range tags {
			rules = append(rules, mk(map[string]any{"action": "evaluate", "server": t, "tag": responseTag(i)}))
		}
		// respond 规则只按响应 tag 匹配,不带域名条件:tag 是这一段专属的,不会串台。
		for i := range tags {
			rules = append(rules, map[string]any{"match_response": responseTag(i), "response_rcode": "NOERROR", "action": "respond", "race": true})
		}
		// 几个上游都没给出 NOERROR:落回主上游那条普通规则,行为和单上游时一样。
		rules = append(rules, mk(map[string]any{"server": tag}))
	}
	plain := func(match map[string]any) func(map[string]any) any {
		return func(tail map[string]any) any { return merge(match, tail) }
	}
	pushProxyRule := func(match map[string]any, tag string) {
		for _, part := range splitRuleSetConditions(match) {
			if proxyV4Only {
				rules = append(rules, emptyAAAA(part))
			}
			if fakeIP {
				rules = append(rules, merge(part, map[string]any{"query_type": fakeIPTypes, "server": fakeIPTag}))
			}
			pushRaceOrPlain(plain(part), tag, proxyExtras)
		}
	}

	// 热切换(flip.go):站点集此刻走直连还是走代理不定死在规则结构里。每个站点集两支都写——包了开关的代理支在前,
	// 直连支紧跟其后——翻面只改写开关文件,不重启内核。前置自定义分流 / 终端分流那两块的出口是设置里定死的,不用成对。
	flipFlags := FlipFlagMap(conf)
	pushFlipPair := func(match map[string]any, tag, flag string) {
		sw := func() map[string]any { return map[string]any{"rule_set": []string{flag}} } // 每条规则各用一份,不共享
		for _, part := range splitRuleSetConditions(match) {
			if proxyV4Only {
				rules = append(rules, andRule([]map[string]any{part, sw(), {"query_type": []string{"AAAA"}}}, map[string]any{"action": "predefined", "rcode": "NOERROR"}))
			}
			// FakeIP:占位地址那条排在真实解析器前面,同样挂着开关(翻到直连后 A 查询就回真实地址)。
			if fakeIP {
				rules = append(rules, andRule([]map[string]any{part, sw(), {"query_type": fakeIPTypes}}, map[string]any{"server": fakeIPTag}))
			}
			pushRaceOrPlain(func(tail map[string]any) any { return andRule([]map[string]any{part, sw()}, tail) }, tag, proxyExtras)
			pushRaceOrPlain(plain(part), "dns-direct", directExtras)
		}
	}

	// 「不进内核」的终端整台不进内核,前置自定义分流也管不到它们,解析排在前置自定义分流前面:一律直连解析、给真实地址
	// (前置自定义分流里走代理的域名会拿到占位地址,那只有内核认得)。
	bypassFrom := len(rules)
	if admitInbound != "" {
		pushRaceOrPlain(plain(map[string]any{"inbound": []string{admitInbound}}), terminalDirect(), directExtras)
	}
	for _, cr := range o.ClientRoutes {
		if !cr.Bypass || !answersPerTerminal(cr) {
			continue
		}
		match := clientroutes.SourceMatch(cr)
		if match == nil {
			continue
		}
		pushRaceOrPlain(plain(match), terminalDirect(), directExtras)
		if _, byIP := match["source_ip_cidr"]; byIP {
			resolvers.Clients = append(resolvers.Clients, ClientResolver{cr.Sources, TerminalDirectTag})
		}
	}
	if len(rules) > bypassFrom {
		ruleOwners = append(ruleOwners, RuleOwner{From: bypassFrom, To: len(rules), Kind: "client", Index: 0, Name: ""})
	}

	if customPolicyActive(conf.Custom) {
		for customIndex, rule := range conf.Custom.Rules {
			customIndex, rule := customIndex, rule
			own("custom", customIndex, "", func() {
				match := customDnsMatch(rule, o.RuleLists)
				if match == nil {
					resolvers.Custom = append(resolvers.Custom, nil)
					return
				}
				target := customOutboundTag(rule, b)
				if target == b.direct {
					pushRaceOrPlain(plain(match), "dns-direct", directExtras)
					resolvers.Custom = append(resolvers.Custom, "dns-direct")
					return
				}
				// 出口是拒绝的行:解析也拒,和连接侧一致(明确拒绝不能变成「先解析再说」)。
				if target == b.block {
					rules = append(rules, merge(match, map[string]any{"action": "reject"}))
					resolvers.Custom = append(resolvers.Custom, nil)
					return
				}
				pushProxyRule(match, ProxyResolverTag)
				resolvers.Custom = append(resolvers.Custom, ProxyResolverTag)
			})
		}
	}

	// 订阅和节点站点直连:它们的域名也用直连侧解析。部署的配置引用域名那份本地规则集(地址变了只换文件、不重启内核);
	// 直接给地址的(测试)照旧写进规则。
	if o.DirectHostSets != nil {
		own("directHosts", 0, "", func() {
			pushRaceOrPlain(plain(map[string]any{"rule_set": []string{o.DirectHostSets.Domain}}), "dns-direct", directExtras)
		})
	} else if len(o.DirectDomains) > 0 {
		own("directHosts", 0, "", func() {
			pushRaceOrPlain(plain(map[string]any{"domain": o.DirectDomains}), "dns-direct", directExtras)
		})
	}

	// 终端分流:指定来源的终端,解析跟着它的出口是直连还是代理(直连给真实地址,代理给占位地址 / 交给代理侧解析器)。
	// 「不进内核」的终端上面已经答过了,这里不再写。
	clientFrom := len(rules)
	for _, cr := range o.ClientRoutes {
		if cr.Bypass || !answersPerTerminal(cr) {
			continue
		}
		match := clientroutes.SourceMatch(cr)
		if match == nil || cr.Outbound == "" {
			continue
		}
		_, byIP := match["source_ip_cidr"]
		if cr.Outbound == b.block {
			rules = append(rules, merge(match, map[string]any{"action": "reject"}))
			continue
		}
		if cr.Outbound == b.direct {
			pushRaceOrPlain(plain(match), terminalDirect(), directExtras)
			if byIP {
				resolvers.Clients = append(resolvers.Clients, ClientResolver{cr.Sources, TerminalDirectTag})
			}
			continue
		}
		if o.KnownOutbounds != nil && !o.KnownOutbounds[cr.Outbound] {
			continue
		}
		pushProxyRule(merge(match, nil), ProxyResolverTag)
		if byIP {
			resolvers.Clients = append(resolvers.Clients, ClientResolver{cr.Sources, ProxyResolverTag})
		}
	}
	if len(rules) > clientFrom {
		ruleOwners = append(ruleOwners, RuleOwner{From: clientFrom, To: len(rules), Kind: "client", Index: 0, Name: ""})
	}

	for index, policy := range conf.ActivePolicies {
		index, policy := index, policy
		if !hasDomainCondition(policy, o.RuleLists) {
			continue
		}
		// 此刻走直连的站点集也写代理那一支(挂着开关):它随时可能翻到代理。
		flag, _ := flipFlags.Get(policy.Name)
		own("policy", index, policy.Name, func() {
			pushFlipPair(policyDnsRule(policy, "", o.RuleLists), ProxyResolverTag, flag)
		})
		if goesDirect(policy.Name, policy.Default) {
			resolvers.Policies[policy.Name] = "dns-direct"
		} else {
			resolvers.Policies[policy.Name] = ProxyResolverTag
		}
	}
	fallbackFrom := len(rules)

	if goesDirect(conf.Fallback.Name, conf.Fallback.Default) {
		resolvers.Fallback = "dns-direct"
	} else {
		resolvers.Fallback = ProxyResolverTag
	}
	// final 带不了条件,代理支写成显式规则排在最后,顺序:AAAA 空应答(代理 v6 降为 IPv4 时)→ FakeIP 占位 → 代理侧解析器;
	// 都挂在兜底的开关上。final 固定指直连侧。
	fallbackSwitch := func() map[string]any { return map[string]any{"rule_set": []string{FlipFallbackTag}} }
	if proxyV4Only {
		rules = append(rules, andRule([]map[string]any{fallbackSwitch(), {"query_type": []string{"AAAA"}}}, map[string]any{"action": "predefined", "rcode": "NOERROR"}))
	}
	if fakeIP {
		// v6 占位段只在「代理也管 v6」(交给节点)时给;降级和不进内核都不给——不进内核时终端拿到占位 v6 会直接往 WAN 发。
		fs := map[string]any{"type": "fakeip", "tag": fakeIPTag, "inet4_range": FakeIPV4}
		if v6mode == "node" {
			fs["inet6_range"] = FakeIPV6
		}
		servers = append(servers, fs)
		// 兜底走代理时,上面都没命中的域名 A(交给节点时连 AAAA)也发占位地址。
		rules = append(rules, andRule([]map[string]any{fallbackSwitch(), {"query_type": fakeIPTypes}}, map[string]any{"server": fakeIPTag}))
	}
	// 兜底代理支的真实解析器排在最后(其它查询类型、以及没开 FakeIP 时的 A 都走它)。
	pushRaceOrPlain(func(tail map[string]any) any { return merge(fallbackSwitch(), tail) }, ProxyResolverTag, proxyExtras)
	if len(localServers) > 0 || len(terminalLocalRules) > 0 {
		servers = append(servers, map[string]any{"type": "local", "tag": "dns-local"})
	}
	// final 带不了条件,也就没法竞速。直连侧配了备用上游时,在规则表最后补一段无条件的竞速:前面都没命中的查询走到这里,
	// 几家一起问、谁先回 NOERROR 用谁的;都没成就落到 final(主上游)。没配备用时这段整个不生成。
	if len(directExtras) > 0 {
		tags := []string{"dns-direct"}
		for i := range directExtras {
			tags = append(tags, extraTag("dns-direct", i))
		}
		round := raceSeq
		raceSeq++
		for i, t := range tags {
			rules = append(rules, map[string]any{"action": "evaluate", "server": t, "tag": fmt.Sprintf("race-%d-%d", round, i)})
		}
		for i := range tags {
			rules = append(rules, map[string]any{"match_response": fmt.Sprintf("race-%d-%d", round, i), "response_rcode": "NOERROR", "action": "respond", "race": true})
		}
	}
	if len(rules) > fallbackFrom {
		ruleOwners = append(ruleOwners, RuleOwner{From: fallbackFrom, To: len(rules), Kind: "fallback", Index: 0, Name: conf.Fallback.Name})
	}
	dns := map[string]any{
		"servers": servers,
		"rules":   rules,
		// 兜底走代理时由上面那条挂着开关的规则接走;走直连时落到这里。
		"final":           "dns-direct",
		"strategy":        strategy,
		"reverse_mapping": true,
	}
	return DNSResult{DNS: dns, Resolvers: resolvers, RuleOwners: ruleOwners}, nil
}
