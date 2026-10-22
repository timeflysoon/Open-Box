package routing

import "strings"

// 规则集标签的翻译与 sing-box 1.14 的规则拆分,对应旧 Node 的
// routing-model.mjs 里 routeRulesetTags / dnsRulesetTags / policyOutboundOptions / splitRuleSetConditions。
// (collectRuleListUrls 只在 Node 端部署流程里用,不属于 configDetailed,不在这里。)

const ruleListIPSuffix = "-ip"

func ruleListIPTag(tag string) string { return tag + ruleListIPSuffix }

// ruleShape:一条规则集链接编成的两份 .srs 里,哪份存在(域名 / IP)。
type ruleShape struct{ domain, ip bool }

// ruleLists 是部署时的形状表 { [list-xxxxxxxx]: { domain, ip } }。
// 只收「值为真」的项——旧版 `ruleLists && ruleLists[tag]` 对假值(null / false / 0 / "")一律当没有形状信息。
type ruleLists map[string]ruleShape

func parseRuleLists(v any) ruleLists {
	out := ruleLists{}
	m, ok := asObject(v)
	if !ok {
		return out
	}
	for tag, shape := range m {
		if !jsTruthy(shape) {
			continue
		}
		out[tag] = ruleShape{
			domain: jsTruthy(get(shape, "domain")),
			ip:     jsTruthy(get(shape, "ip")),
		}
	}
	return out
}

// routeRulesetTags:路由规则引用哪几份 .srs。有形状就按形状(两份都引用存在的那些),没有就按老样子引用一份。
func routeRulesetTags(rulesets []string, l ruleLists) []string {
	out := []string{}
	for _, tag := range rulesets {
		if !isRuleListTag(tag) {
			out = append(out, tag)
			continue
		}
		shape, has := l[tag]
		if !has {
			out = append(out, tag)
			continue
		}
		if shape.domain {
			out = append(out, tag)
		}
		if shape.ip {
			out = append(out, ruleListIPTag(tag))
		}
	}
	return out
}

// dnsRulesetTags:DNS 规则只要纯域名的规则集。geoip-* 和规则集链接的 IP 那份不能进来
// (含 IP 的规则集会让每个路过的域名先被这条规则的服务器白查一遍)。
func dnsRulesetTags(rulesets []string, l ruleLists) []string {
	out := []string{}
	for _, tag := range rulesets {
		if isGeoipTag(tag) {
			continue
		}
		if isRuleListTag(tag) {
			if shape, has := l[tag]; has && !shape.domain {
				continue
			}
		}
		out = append(out, tag)
	}
	return out
}

// policyOutboundOptions:站点集 selector 的成员表——节点管理里启用着的条目,按那里的顺序。
// 一个都不剩时回落成直连(空成员的组会让内核 FATAL)。
func policyOutboundOptions(groupTags []string, b builtinTags) []string {
	list := []string{}
	for _, tag := range groupTags {
		switch tag {
		case b.direct:
			if !b.directEnabled {
				continue
			}
		case b.block:
			if !b.blockEnabled {
				continue
			}
		}
		list = append(list, tag)
	}
	if len(list) == 0 {
		return []string{b.direct}
	}
	return list
}

var ruleDestKeys = []string{"domain", "domain_suffix", "domain_keyword", "domain_regex", "ip_cidr"}

// splitRuleSetConditions:规则集和域名 / IP 条件拆成紧邻的两条(sing-box 1.14 起二者是「与」,
// Open-Box 一直按「任一命中」理解)。只有规则集、或只有域名 / IP 条件的不拆。
func splitRuleSetConditions(rule map[string]any) []map[string]any {
	if _, has := rule["rule_set"]; !has || !jsTruthy(rule["rule_set"]) {
		return []map[string]any{rule}
	}
	var destKeys []string
	for _, k := range ruleDestKeys {
		if _, has := rule[k]; has {
			destKeys = append(destKeys, k)
		}
	}
	if len(destKeys) == 0 {
		return []map[string]any{rule}
	}
	rest := make(map[string]any, len(rule))
	for k, v := range rule {
		rest[k] = v
	}
	delete(rest, "rule_set")
	for _, k := range destKeys {
		delete(rest, k)
	}
	withSet := map[string]any{"rule_set": rule["rule_set"]}
	for k, v := range rest {
		withSet[k] = v
	}
	withDest := map[string]any{}
	for _, k := range destKeys {
		withDest[k] = rule[k]
	}
	for k, v := range rest {
		withDest[k] = v
	}
	return []map[string]any{withSet, withDest}
}

// DomainPresentRegex:「连接有域名」的判定(内核里 = metadata.Domain 或 Destination.Fqdn 有值)。HTTP 的 Host 直接写 IP 时
// 嗅探出来的是 IP 字面量,不算域名:要求至少一个字母、且没有冒号(IPv4 字面量没有字母,IPv6 字面量有冒号;域名到这里已经转成小写)。
const DomainPresentRegex = "^[^:]*[a-z][^:]*$"

// noDomainGuard:「连接没有域名」这个前提,放进 logical AND 里和 IP 条件并列(IP 只管 IP、域名只管域名)。
func noDomainGuard() map[string]any {
	return map[string]any{"domain_regex": []string{DomainPresentRegex}, "invert": true}
}

// isIPRuleSetTag:geoip-* 和规则集链接编出来的 IP 那份看目标 IP,其余(geosite-*、规则集链接的域名那份、形状未知的规则集链接)看域名。
func isIPRuleSetTag(tag string) bool {
	return isGeoipTag(tag) || (isRuleListTag(tag) && strings.HasSuffix(tag, ruleListIPSuffix))
}

// policyRouteMatches:站点集的匹配条件分成「看域名」「看 IP」两份,各是一条还没拆规则集的路由规则条件;没有就是 nil。
func policyRouteMatches(p Policy, l ruleLists) (domain, ip map[string]any) {
	tags := routeRulesetTags(p.Rulesets, l)
	var domainTags, ipTags []string
	for _, t := range tags {
		if isIPRuleSetTag(t) {
			ipTags = append(ipTags, t)
		} else {
			domainTags = append(domainTags, t)
		}
	}
	d := map[string]any{}
	if len(domainTags) > 0 {
		d["rule_set"] = domainTags
	}
	if len(p.Domain) > 0 {
		d["domain"] = p.Domain
	}
	if len(p.DomainSuffix) > 0 {
		d["domain_suffix"] = p.DomainSuffix
	}
	if len(p.DomainKeyword) > 0 {
		d["domain_keyword"] = p.DomainKeyword
	}
	i := map[string]any{}
	if len(ipTags) > 0 {
		i["rule_set"] = ipTags
	}
	if len(p.IPCidr) > 0 {
		i["ip_cidr"] = p.IPCidr
	}
	if len(d) > 0 {
		domain = d
	}
	if len(i) > 0 {
		ip = i
	}
	return
}
