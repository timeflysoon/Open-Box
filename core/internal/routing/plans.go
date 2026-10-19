package routing

import (
	"encoding/json"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// ---------------------------------------------------------------------------
// classes:每个站点集(含兜底)此刻实际落到哪一类出口 direct / block / proxy
// 对应旧 Node 的 policyClasses。
// ---------------------------------------------------------------------------

func classOf(chosen string, b builtinTags) string {
	switch chosen {
	case b.direct:
		return "direct"
	case b.block:
		return "block"
	}
	return "proxy"
}

func policyClasses(routing any, members []string, b builtinTags, selections map[string]any) map[string]string {
	conf := normalizeRouting(routing)
	out := map[string]string{}
	for _, p := range conf.ActivePolicies {
		out[p.Name] = classOf(policyChosenOutbound(p.Name, p.Default, members, b, selections), b)
	}
	out[conf.Fallback.Name] = classOf(policyChosenOutbound(conf.Fallback.Name, conf.Fallback.Default, members, b, selections), b)
	return out
}

// ---------------------------------------------------------------------------
// forwardPlan:dnsmasq 接管模式下该怎么转发查询
// 对应旧 Node 的 dnsmasqForwardPlan。mode: none(一个都不转发)/ domains(只转发列出的域名)/ all(全量转发)
// ---------------------------------------------------------------------------

type ExpandItem struct {
	Tag   string `json:"tag"`
	Owner string `json:"owner"`
}

type ForwardPlan struct {
	Mode    string       `json:"mode"`
	Domains []string     `json:"domains"`
	Expand  []ExpandItem `json:"expand"`
	Reason  string       `json:"reason"`
}

func planAll(reason string) ForwardPlan {
	return ForwardPlan{Mode: "all", Domains: []string{}, Expand: []ExpandItem{}, Reason: reason}
}

var customTypeLabel = map[string]string{"domainKeyword": "域名关键词", "ruleset": "规则集"}

func forwardPlan(routing any, members []string, b builtinTags, selections map[string]any, extra any) ForwardPlan {
	conf := normalizeRouting(routing)
	var rewriteDomains []string
	if a, ok := asArray(get(extra, "rewriteDomains")); ok {
		for _, d := range a {
			if s, isStr := d.(string); isStr && s != "" {
				rewriteDomains = append(rewriteDomains, s)
			}
		}
	}
	if !policyGoesDirect(conf.Fallback.Name, conf.Fallback.Default, members, b, selections) {
		return planAll("兜底「" + conf.Fallback.Name + "」走代理")
	}
	// 广告拦截是规则集,拦截又必须在 DNS 入口就生效;广告规则集里关键词 / 正则很多,只能全量交给内核
	if conf.AdBlock {
		return planAll("广告拦截开着,拦截规则集 dnsmasq 展不开,拒绝只能在内核里做")
	}
	domains := []string{}
	seen := map[string]bool{}
	expand := []ExpandItem{}
	addDomain := func(value, owner string) string {
		safe, ok := dnsmasqSafeDomain(value)
		if !ok {
			return owner + "的域名「" + value + "」写不进 dnsmasq(非法字符 / 标签超长)"
		}
		if !seen[safe] {
			seen[safe] = true
			domains = append(domains, safe)
		}
		return ""
	}
	// 前置自定义分流:走代理和要拒绝的域名行都要进名单;按 IP / 端口分流的行在解析阶段用不上,跳过
	if customPolicyActive(conf.Custom) {
		for _, rule := range conf.Custom.Rules {
			target := customOutboundTag(rule, b)
			if target == b.direct {
				continue
			}
			owner := "前置自定义分流"
			if target == b.block {
				owner += "要拒绝的"
			}
			switch {
			case rule.Type == "domain" || rule.Type == "domainSuffix":
				if bad := addDomain(rule.Value, owner); bad != "" {
					return planAll(bad)
				}
			case rule.Type == "geosite" || rule.Type == "ruleUrl":
				expand = append(expand, ExpandItem{customRuleTag(rule), owner + "「" + rule.Value + "」"})
			default:
				if label, ok := customTypeLabel[rule.Type]; ok {
					return planAll(owner + "「" + rule.Value + "」是" + label + ",dnsmasq 展不开")
				}
			}
		}
	}
	for _, p := range conf.ActivePolicies {
		if policyGoesDirect(p.Name, p.Default, members, b, selections) {
			continue
		}
		if len(p.DomainKeyword) > 0 {
			return planAll("站点集「" + p.Name + "」用了域名关键词,dnsmasq 展不开")
		}
		for _, d := range append(append([]string{}, p.Domain...), p.DomainSuffix...) {
			if bad := addDomain(d, "站点集「"+p.Name+"」"); bad != "" {
				return planAll(bad)
			}
		}
		// geoip 只按 IP 分,解析阶段用不上;geosite / 规则集链接交给部署时展开
		for _, tag := range p.Rulesets {
			if !isGeoipTag(tag) {
				expand = append(expand, ExpandItem{tag, "站点集「" + p.Name + "」"})
			}
		}
	}
	for _, d := range rewriteDomains {
		if !seen[d] {
			seen[d] = true
			domains = append(domains, d)
		}
	}
	if len(domains) == 0 && len(expand) == 0 {
		return ForwardPlan{Mode: "none", Domains: []string{}, Expand: []ExpandItem{}, Reason: "没有走代理的域名,DNS 全部由路由器原有上游解析"}
	}
	return ForwardPlan{Mode: "domains", Domains: domains, Expand: expand, Reason: ""}
}

// ---------------------------------------------------------------------------
// bypassPlan:哪些目标 IP 集合可以在系统入口(nft)就旁路掉、根本不进内核
// 对应旧 Node 的 nativeBypassPlan。
//
// 比旧版多两个选项(从 Node 的调用处推断,旧版没有):
//   enabled=false         用户在设置里关掉了入口旁路 → 直接不开
//   ignoreProxyClients    不因为「有终端被指定走代理」而关掉(用来单独算其余部分)
// ---------------------------------------------------------------------------

type EarlierRule struct {
	Name  string   `json:"name"`
	Geoip []string `json:"geoip"`
	Cidrs []string `json:"cidrs"`
}

type PendingItem struct {
	Policy  string        `json:"policy"`
	Sets    []string      `json:"sets"`
	Against []EarlierRule `json:"against"`
}

type BypassPlan struct {
	Enabled bool          `json:"enabled"`
	Sets    []string      `json:"sets"`
	Pending []PendingItem `json:"pending"`
	FakeIP  bool          `json:"fakeIp"`
	Reason  string        `json:"reason"`
}

func jsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && x == x
	case string:
		return x != ""
	}
	return true
}

func cloneStrs(s []string) []string { return append([]string{}, s...) }

func bypassPlan(routing any, opts any) BypassPlan {
	conf := normalizeRouting(routing)
	members := []string{"direct"}
	if v := get(opts, "members"); v != nil {
		members = parseMembers(v)
	}
	b := parseBuiltin(get(opts, "builtin"))
	selections := parseSelections(get(opts, "selections"))
	clientRoutes, _ := asArray(get(opts, "clientRoutes"))
	dnsMode := "dnsmasq"
	if v := get(opts, "dnsMode"); v != nil {
		dnsMode, _ = v.(string) // 非字符串按「不是 off」处理(空串即可)
	}
	fakeIP := jsTruthy(get(opts, "fakeIp"))
	enabled := notFalse(get(opts, "enabled"))
	ignoreProxyClients := jsTruthy(get(opts, "ignoreProxyClients"))

	domainSafe := fakeIP && dnsMode != "off"
	notes := []string{}
	if fakeIP && dnsMode == "off" {
		notes = append(notes, "DNS 禁用模式下终端的查询不一定经内核,FakeIP 不作旁路前提,按真实 IP 计算")
	}
	if domainSafe {
		notes = append(notes, "FakeIP 试验开着:走代理的域名规则按占位地址计,不挡直连集合(终端自带加密 DNS / 开启前已缓存的真实地址 / 转发漏匹配不在此保证内)")
	}
	off := func(reason string) BypassPlan {
		return BypassPlan{Sets: []string{}, Pending: []PendingItem{}, FakeIP: domainSafe,
			Reason: strings.Join(append([]string{reason}, notes...), ";")}
	}
	if !enabled {
		return off("入口旁路已在设置里关闭")
	}

	earlier := []EarlierRule{}
	if customPolicyActive(conf.Custom) {
		cidrs, geoip := []string{}, []string{}
		for _, rule := range conf.Custom.Rules {
			if customOutboundTag(rule, b) == b.direct {
				continue
			}
			switch rule.Type {
			case "port":
				return off("前置自定义分流「" + rule.Value + "」按端口分流,任何目标 IP 都可能命中,入口旁路不能越过它")
			case "ipCidr":
				cidrs = append(cidrs, rule.Value)
				continue
			case "geoip":
				geoip = append(geoip, "geoip-"+rule.Value)
				continue
			case "ruleUrl", "ruleset":
				return off("前置自定义分流「" + rule.Value + "」是规则集链接 / 规则集,里面可能有 IP 段,入口旁路不能越过它")
			}
			// 域名 / 后缀 / 关键词行
			if !domainSafe {
				return off("前置自定义分流「" + rule.Value + "」按域名分流,它解析出来的 IP 在入口分不出来,旁路不能越过它")
			}
		}
		if len(cidrs) > 0 || len(geoip) > 0 {
			earlier = append(earlier, EarlierRule{"前置自定义分流", geoip, cidrs})
		}
	}
	if !ignoreProxyClients {
		for _, cr := range clientRoutes {
			ob := get(cr, "outbound")
			if jsTruthy(cr) && jsTruthy(ob) {
				if s, isStr := ob.(string); !isStr || s != b.direct {
					return off("有终端被指定走代理,该终端的全部流量都要进内核")
				}
			}
		}
	}
	if conf.AdBlock {
		return off("广告拦截开着,命中广告规则的目标要在内核里拒绝")
	}

	sets := []string{}
	pending := []PendingItem{}
	blocker := ""
	skipped := []string{}
	for _, p := range conf.ActivePolicies {
		geoip := []string{}
		for _, tag := range p.Rulesets {
			if isGeoipTag(tag) {
				geoip = append(geoip, tag)
			}
		}
		if !policyGoesDirect(p.Name, p.Default, members, b, selections) {
			hasList, hasDomain := false, len(p.Domain) > 0 || len(p.DomainSuffix) > 0 || len(p.DomainKeyword) > 0
			for _, tag := range p.Rulesets {
				if isRuleListTag(tag) {
					hasList = true
				}
				if !isGeoipTag(tag) && !isRuleListTag(tag) {
					hasDomain = true
				}
			}
			if hasList || (hasDomain && !domainSafe) {
				if blocker == "" {
					blocker = p.Name
				}
				continue
			}
			if len(geoip) > 0 || len(p.IPCidr) > 0 {
				earlier = append(earlier, EarlierRule{p.Name, geoip, cloneStrs(p.IPCidr)})
			}
			continue
		}
		if len(geoip) == 0 {
			continue
		}
		if blocker != "" {
			skipped = append(skipped, p.Name)
			continue
		}
		if len(earlier) > 0 {
			against := make([]EarlierRule, len(earlier))
			for i, e := range earlier {
				against[i] = EarlierRule{e.Name, cloneStrs(e.Geoip), cloneStrs(e.Cidrs)}
			}
			pending = append(pending, PendingItem{p.Name, geoip, against})
		} else {
			for _, tag := range geoip {
				if !contains(sets, tag) {
					sets = append(sets, tag)
				}
			}
		}
	}
	if len(sets) == 0 && len(pending) == 0 {
		if len(skipped) > 0 {
			return off("站点集「" + strings.Join(skipped, "」「") + "」前面还有走代理 / 拒绝的站点集「" + blocker + "」,它可能先命中同样的地址(域名规则解析出来的 IP 在入口分不出来),按顺序不能越过它")
		}
		return off("走直连的站点集里没有 geoip 规则集,入口没有可用的 IP 集合")
	}
	reasons := cloneStrs(notes)
	if len(skipped) > 0 {
		reasons = append(reasons, "站点集「"+strings.Join(skipped, "」「")+"」排在「"+blocker+"」之后,没有进入口旁路")
	}
	for _, x := range pending {
		names := make([]string, len(x.Against))
		for i, a := range x.Against {
			names[i] = a.Name
		}
		reasons = append(reasons, "站点集「"+x.Policy+"」的集合要先和前面带 IP 条件的「"+strings.Join(names, "」「")+"」核对重叠,部署时决定")
	}
	return BypassPlan{Enabled: len(sets) > 0, Sets: sets, Pending: pending, FakeIP: domainSafe, Reason: strings.Join(reasons, ";")}
}

// ---- 协议处理函数 ----

// classes(routing, members, builtin, selections)
func hClasses(_ *protocol.Context, args []json.RawMessage) (any, error) {
	routing, members, b, sel, err := planArgs(args)
	if err != nil {
		return nil, err
	}
	return policyClasses(routing, members, b, sel), nil
}

// forwardPlan(routing, members, builtin, selections, extra)
func hForwardPlan(_ *protocol.Context, args []json.RawMessage) (any, error) {
	routing, members, b, sel, err := planArgs(args)
	if err != nil {
		return nil, err
	}
	extra, err := arg(args, 4)
	if err != nil {
		return nil, err
	}
	return forwardPlan(routing, members, b, sel, extra), nil
}

// bypassPlan(routing, {members, builtin, selections, clientRoutes, fakeIp, dnsMode, enabled, ignoreProxyClients})
func hBypassPlan(_ *protocol.Context, args []json.RawMessage) (any, error) {
	routing, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	opts, err := arg(args, 1)
	if err != nil {
		return nil, err
	}
	return bypassPlan(routing, opts), nil
}

func planArgs(args []json.RawMessage) (routing any, members []string, b builtinTags, sel map[string]any, err error) {
	if routing, err = arg(args, 0); err != nil {
		return
	}
	var m, bi, s any
	if m, err = arg(args, 1); err != nil {
		return
	}
	if bi, err = arg(args, 2); err != nil {
		return
	}
	if s, err = arg(args, 3); err != nil {
		return
	}
	members = []string{"direct"}
	if m != nil {
		members = parseMembers(m)
	}
	return routing, members, parseBuiltin(bi), parseSelections(s), nil
}
