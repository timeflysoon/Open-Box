package kerneldns

import (
	"net/netip"
	"strings"
)

// MihomoConfigured 按档案里「指定域名 DNS」(dns.domainUpstreams)推算一个域名的走向。
// 为什么从档案推、不去解析 mihomo.yaml:后端的 go.mod 是零依赖(不引 yaml 库),而 mihomo.yaml
// 本来就是由本模块按档案生成的,两者同源;档案才是这一项的输入,直接读它更准也更省事。
//
// 返回的 map 与上游 kernelDns.configured 同形(前端 routeTermKdnsMihomoLegacyConfigured 用它拼显示):
//
//	{"server": {"tag","type","server","port","detour"}, "ruleKey": "DOMAIN-SUFFIX,example.com", "fakeIp": bool}
//
// 没有命中任何规则时返回 nil(调用方据此不显示 configured,只说明这个内核不输出追踪记录)。
func MihomoConfigured(profile map[string]any, domain string) map[string]any {
	dns, _ := profile["dns"].(map[string]any)
	if dns == nil {
		return nil
	}
	du, _ := dns["domainUpstreams"].(map[string]any)
	if du == nil {
		return nil
	}
	// 总开关关着 = 这一项没生效,不推算
	if on, ok := du["enabled"].(bool); ok && !on {
		return nil
	}
	rules, _ := du["rules"].([]any)
	d := normalizeDomain(domain)
	if d == "" {
		return nil
	}
	for _, raw := range rules {
		r, _ := raw.(map[string]any)
		if r == nil {
			continue
		}
		if on, ok := r["enabled"].(bool); ok && !on {
			continue
		}
		matchType, _ := r["matchType"].(string)
		domains := domainList(r["domains"])
		key, hit := matchAny(matchType, domains, d)
		if !hit {
			continue
		}
		proto, _ := r["protocol"].(string)
		if proto == "" {
			proto = "udp"
		}
		server, _ := r["server"].(string)
		var port any
		switch p := r["port"].(type) {
		case float64:
			port = int(p)
		case int:
			port = p
		}
		out := map[string]any{
			"server": map[string]any{
				"tag":    "", // mihomo 的 DNS 上游没有 tag,留空由前端按地址显示
				"type":   strings.ToUpper(proto),
				"server": server,
				"port":   port,
				"detour": "", // 这项走直连,不经节点
			},
			"ruleKey": key,
		}
		// 上游对本项是否走 FakeIP 的判断:只有 fakeip 类上游才算,这里没有该形态,固定 false
		out["fakeIp"] = false
		return out
	}
	return nil
}

// normalizeDomain 规整域名:小写、去尾部点。
func normalizeDomain(d string) string {
	d = strings.TrimSpace(strings.ToLower(d))
	return strings.TrimSuffix(d, ".")
}

// domainList 把规则里的 domains 读成字符串列表。
func domainList(v any) []string {
	raw, _ := v.([]any)
	out := make([]string, 0, len(raw))
	for _, x := range raw {
		if s, ok := x.(string); ok {
			if s = normalizeDomain(s); s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

// matchAny 按 matchType 判断命中,返回命中的规则键(如 `DOMAIN-SUFFIX,example.com`)给界面显示。
// domain = 完全相等;domainSuffix = 后缀匹配(含自身)。
func matchAny(matchType string, domains []string, d string) (string, bool) {
	for _, want := range domains {
		switch matchType {
		case "domain":
			if d == want {
				return "DOMAIN," + want, true
			}
		case "domainSuffix":
			if d == want || strings.HasSuffix(d, "."+want) {
				return "DOMAIN-SUFFIX," + want, true
			}
		}
	}
	return "", false
}

// IsFakeIP 判断一个地址是否落在内核 FakeIP 的默认占位地址段(198.18.0.0/15)里。
// 上游用「探测拿到的地址是不是占位地址」来区分「实测返回 FakeIP」与「按配置推算」两种显示。
func IsFakeIP(addr string) bool {
	ip, err := netip.ParseAddr(addr)
	if err != nil {
		return false
	}
	return fakeRange.Contains(ip)
}
