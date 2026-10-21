package routing

import (
	"encoding/json"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// ---------------------------------------------------------------------------
// classes:每个站点集(含兜底)此刻实际落到哪一类出口 direct / block / proxy
// 对应上游 engine 的 policyClasses。
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
	domains := []string{}
	seen := map[string]bool{}
	expand := []ExpandItem{}
	addDomain := func(value, owner string) string {
		safe, ok := dnsmasqSafeDomain(value)
		if !ok {
			return owner + "的域名「" + value + "」写不进 dnsmasq（非法字符 / 标签超长）"
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
