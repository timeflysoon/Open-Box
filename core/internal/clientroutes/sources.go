package clientroutes

import (
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// 对应基线 engine/client-routes.mjs 里 config 装配要用的几个导出:
// bypassSources / admitSources / admitDnsDirect / guardTerminalRules。
// 它们读的是档案里原样的终端分流列表(profile.clientRoutes),不是 NormalizeClientRoutes 整理过的。

// Sources 是按认法分开合并的终端来源:IPs 是网段,Macs 是 MAC(都已去重、保持首次出现的顺序,非 nil)。
type Sources struct {
	IPs  []string `json:"ips"`
	Macs []string `json:"macs"`
}

func appendUnique(dst []string, seen map[string]bool, src []string) []string {
	for _, s := range src {
		if !seen[s] {
			seen[s] = true
			dst = append(dst, s)
		}
	}
	return dst
}

// collectSources:启用的某一类规则(bypass / admit)里的终端。
func collectSources(list any, flag string) Sources {
	out := Sources{IPs: []string{}, Macs: []string{}}
	l, _ := list.([]any)
	seenIP, seenMac := map[string]bool{}, map[string]bool{}
	for _, r := range l {
		m, ok := r.(map[string]any)
		if !ok || m["enabled"] == false || m[flag] != true {
			continue
		}
		if ClientMatch(r) == "mac" {
			out.Macs = appendUnique(out.Macs, seenMac, cleanMacs(r))
		} else {
			out.IPs = appendUnique(out.IPs, seenIP, cleanSources(r))
		}
	}
	return out
}

// BypassSources:「不进内核」(黑名单)的终端。
func BypassSources(list any) Sources { return collectSources(list, "bypass") }

// AdmitSources:「只让这些终端进内核」(白名单)。只在 auto_redirect 下有效。
func AdmitSources(list any) Sources { return collectSources(list, "admit") }

// AdmitDNSDirect:「只让这些终端进内核」按 IP 的名单外终端,解析要给真实地址
// (入口把它们的查询转给内核专门的 DNS 入站)。opts 里 dnsMode 缺省 hijack、autoRedirect 缺省 false、splitDns 缺省 true。
func AdmitDNSDirect(list any, opts any) bool {
	dnsMode := any("hijack")
	if v := jsx.Get(opts, "dnsMode"); !jsx.IsUndefined(v) {
		dnsMode = v
	}
	autoRedirect := any(false)
	if v := jsx.Get(opts, "autoRedirect"); !jsx.IsUndefined(v) {
		autoRedirect = v
	}
	splitDNS := any(true)
	if v := jsx.Get(opts, "splitDns"); !jsx.IsUndefined(v) {
		splitDNS = v
	}
	return jsx.Truthy(autoRedirect) && jsx.Truthy(splitDNS) && (dnsMode == "dnsmasq" || dnsMode == "hijack") && len(AdmitSources(list).IPs) > 0
}

// NotShareInbound 是「入站不是共享网络」的子条件(sing-box 的 inbound 条件只能写正向列表,所以带 invert)。
func NotShareInbound(tags []string) map[string]any {
	in := make([]any, len(tags))
	for i, t := range tags {
		in[i] = t
	}
	return map[string]any{"inbound": in, "invert": true}
}

func hasSourceCondition(rule any) bool {
	m, ok := rule.(map[string]any)
	if !ok {
		return false
	}
	_, a := m["source_ip_cidr"]
	_, b := m["source_mac_address"]
	return a || b
}

// 普通规则拆开时算「条件」的字段(其余是动作:outbound / action / server / tag / strategy …)。
var shareGuardConditionKeys = map[string]bool{
	"source_ip_cidr": true, "source_mac_address": true, "domain": true, "domain_suffix": true, "domain_keyword": true,
	"domain_regex": true, "rule_set": true, "query_type": true, "ip_version": true, "network": true, "protocol": true,
	"port": true, "port_range": true, "ip_cidr": true, "ip_is_private": true, "inbound": true, "invert": true,
	"source_port": true, "source_port_range": true,
}

// GuardTerminalRules:按来源认终端的规则(终端分流、「不进内核」,路由和 DNS 两处)只管局域网终端经路由器上网的连接,
// 从共享网络入站进来的连接按路由器的分流规则走。普通规则拆成 logical AND(条件一份、动作留在外面),
// logical AND 直接追加。规则条数不变;没有共享网络入站(shareTags 里没有非空字符串)或 rules 不是数组时原样返回。
func GuardTerminalRules(rules any, shareTags any) any {
	tags := []string{}
	if l, ok := shareTags.([]any); ok {
		for _, t := range l {
			if s, ok := t.(string); ok && s != "" {
				tags = append(tags, s)
			}
		}
	}
	list, ok := rules.([]any)
	if !ok || len(tags) == 0 {
		return rules
	}
	out := make([]any, len(list))
	for i, r := range list {
		out[i] = guardRule(r, tags)
	}
	return out
}

func guardRule(r any, tags []string) any {
	rule, ok := r.(map[string]any)
	if !ok {
		return r
	}
	if rule["type"] == "logical" {
		subs, isArr := rule["rules"].([]any)
		if rule["mode"] != "and" || !isArr {
			return r
		}
		has := false
		for _, s := range subs {
			if hasSourceCondition(s) {
				has = true
				break
			}
		}
		if !has {
			return r
		}
		cp := make(map[string]any, len(rule))
		for k, v := range rule {
			cp[k] = v
		}
		cp["rules"] = append(append([]any{}, subs...), NotShareInbound(tags))
		return cp
	}
	if !hasSourceCondition(rule) {
		return r
	}
	cond := map[string]any{}
	tail := map[string]any{}
	for k, v := range rule {
		if shareGuardConditionKeys[k] {
			cond[k] = v
		} else {
			tail[k] = v
		}
	}
	// {type:'logical', mode:'and', rules:[…], ...tail}:tail 里同名的键会盖掉前面的(JS 展开顺序)
	out := map[string]any{"type": "logical", "mode": "and", "rules": []any{cond, NotShareInbound(tags)}}
	for k, v := range tail {
		out[k] = v
	}
	return out
}
