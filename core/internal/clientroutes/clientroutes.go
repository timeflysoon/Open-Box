// Package clientroutes 整理「终端分流」:按局域网来源 IP / 网段指定出口
// (对应上游 engine/client-routes.mjs,v0.1.318)。
package clientroutes

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/ipx"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

var (
	digitsRe = regexp.MustCompile(`^\d+$`)
	macRe    = regexp.MustCompile(`^([0-9a-f]{2}:){5}[0-9a-f]{2}$`)
)

// 带 zone 的链路本地地址(fe80::1%eth0)不当普通网段:规则里写它没有意义,内核也不收。
func isIPv6(s string) bool { return ipx.IsIPv6(s) && !strings.Contains(s, "%") }

func orEmpty(raw any) string {
	if jsx.Truthy(raw) {
		return jsx.ToString(raw)
	}
	return ""
}

// NormalizeCidr 合法就返回规范化后的 CIDR(裸 IP 补成 /32、/128),不合法返回空串。
func NormalizeCidr(raw any) string {
	s := jsx.Trim(orEmpty(raw))
	if s == "" {
		return ""
	}
	parts := strings.Split(s, "/")
	if len(parts) > 2 {
		return ""
	}
	addr := parts[0]
	var limit float64
	var bare string
	switch {
	case ipx.IsIPv4(addr):
		limit, bare = 32, "/32"
	case isIPv6(addr):
		limit, bare = 128, "/128"
	default:
		return ""
	}
	if len(parts) == 1 {
		return addr + bare
	}
	prefix := parts[1]
	if !digitsRe.MatchString(prefix) {
		return ""
	}
	n, _ := strconv.ParseFloat(prefix, 64)
	if n < 0 || n > limit {
		return ""
	}
	return addr + "/" + strconv.Itoa(int(n))
}

// NormalizeMac:六组十六进制,冒号或横线分隔,归一成小写冒号写法;不合法返回空串。
func NormalizeMac(raw any) string {
	s := strings.ReplaceAll(strings.ToLower(jsx.Trim(orEmpty(raw))), "-", ":")
	if macRe.MatchString(s) {
		return s
	}
	return ""
}

// Route 是整理后的一条终端分流。字段顺序就是 JSON 键序(对应 JS 里 { id, name, match, outbound, bypass?, sources, macs? })。
type Route struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Match    string `json:"match"` // "ip" 或 "mac"
	Outbound string `json:"outbound"`
	Bypass   bool   `json:"bypass,omitempty"`
	// ip 模式:来源网段(去重、非空);mac 模式:空数组(不能省略)
	Sources []string `json:"sources"`
	// 只在 mac 模式出现,去重、非空;ip 模式整个字段不出现
	Macs []string `json:"macs,omitempty"`
}

// ClientMatch:一条终端规则按什么认终端。显式写了 match(ip / mac)就用它;老档案没有这个字段,
// 「不进内核」(bypass)和「只让这些进内核」(admit)当时必须填 MAC,macs 非空算 mac,其余算 ip。
func ClientMatch(r any) string {
	m := jsx.Get(r, "match")
	if m == "ip" || m == "mac" {
		return m.(string)
	}
	if (jsx.Get(r, "bypass") == true || jsx.Get(r, "admit") == true) && jsx.Get(r, "macs") != nil {
		if a, ok := jsx.Get(r, "macs").([]any); ok && len(a) > 0 {
			return "mac"
		}
	}
	return "ip"
}

func cleanSources(r any) []string {
	out := []string{}
	seen := map[string]bool{}
	if a, ok := jsx.Get(r, "sources").([]any); ok {
		for _, s := range a {
			if c := NormalizeCidr(s); c != "" && !seen[c] {
				seen[c] = true
				out = append(out, c)
			}
		}
	}
	return out
}

func cleanMacs(r any) []string {
	out := []string{}
	seen := map[string]bool{}
	if a, ok := jsx.Get(r, "macs").([]any); ok {
		for _, m := range a {
			if v := NormalizeMac(m); v != "" && !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	return out
}

// NormalizeClientRoutes:只留启用的、来源合法的;admit(只让这些进内核)不是分流规则,在这里直接跳过;
// bypass=true 时出口取内置直连的 tag。mac 模式没有合法 MAC、ip 模式没有合法网段的整条丢弃。
func NormalizeClientRoutes(list any, directTag any) []Route {
	arr, ok := list.([]any)
	if !ok {
		return []Route{}
	}
	out := []Route{}
	for _, r := range arr {
		if _, isObj := r.(map[string]any); !isObj {
			if _, isArr := r.([]any); !isArr {
				continue // 非对象(含 null)
			}
		}
		if en, isBool := jsx.Get(r, "enabled").(bool); isBool && !en {
			continue
		}
		if jsx.Get(r, "admit") == true {
			continue
		}
		match := ClientMatch(r)
		bypass := jsx.Get(r, "bypass") == true
		trimmed, isStr := jsx.Get(r, "outbound").(string)
		if isStr {
			trimmed = jsx.Trim(trimmed)
		}
		var outbound string
		if bypass {
			switch {
			case jsx.Truthy(directTag):
				outbound = jsx.ToString(directTag)
			case isStr && trimmed != "":
				outbound = trimmed
			default:
				outbound = "direct"
			}
		} else if isStr {
			outbound = trimmed
		}
		if outbound == "" {
			continue
		}
		route := Route{ID: orEmpty(jsx.Get(r, "id")), Name: orEmpty(jsx.Get(r, "name")), Match: match, Outbound: outbound, Bypass: bypass}
		if match == "mac" {
			macs := cleanMacs(r)
			if len(macs) == 0 {
				continue
			}
			route.Sources, route.Macs = []string{}, macs
		} else {
			sources := cleanSources(r)
			if len(sources) == 0 {
				continue
			}
			route.Sources = sources
		}
		out = append(out, route)
	}
	return out
}

// SourceMatch:一条整理过的终端规则在路由 / DNS 规则里的来源条件。按 IP 的写 source_ip_cidr,
// 按 MAC 的写 source_mac_address(sing-box 1.14,内核按邻居表 / DHCP 租约认 MAC);没有终端的返回 nil。
func SourceMatch(cr Route) map[string]any {
	if cr.Match == "mac" {
		if len(cr.Macs) > 0 {
			return map[string]any{"source_mac_address": cr.Macs}
		}
		return nil
	}
	if len(cr.Sources) > 0 {
		return map[string]any{"source_ip_cidr": cr.Sources}
	}
	return nil
}

// IsDirectClientRoute:终端分流里出口是「直连」的终端(不含「不进内核」那种):连接进了内核也是直连。
func IsDirectClientRoute(cr Route, directTag string) bool {
	return !cr.Bypass && directTag != "" && cr.Outbound == directTag
}

// IsProxyClientRoute:终端分流里出口是节点 / 节点组的终端(不是直连、拒绝,也不是「不进内核」)。
func IsProxyClientRoute(cr Route, directTag, blockTag string) bool {
	return !cr.Bypass && cr.Outbound != "" && cr.Outbound != directTag && cr.Outbound != blockTag
}

// TerminalDNSOptions 对应 terminalDnsRedirected 的第二个参数。缺省值(JS 解构默认值):dnsMode 'hijack'、
// autoRedirect false、directBypass true、splitDns true。Go 这边没有「缺省」,调用方按上面的默认值填。
type TerminalDNSOptions struct {
	DNSMode      string
	AutoRedirect bool
	DirectBypass bool
	SplitDNS     bool
	DirectTag    string
	BlockTag     string
}

// TerminalDNSRedirected:哪些终端的 DNS 要由内核按终端答——入口把它们的查询转给内核的 DNS 入站,
// 内核才看得到是哪台终端在查。要按终端答的有三类:
//   - 「不进内核」的终端;
//   - 出口是「直连」、会在首包预判时放行的终端(「直连不进内核」开着、有 nft 重定向)——只有 dnsmasq 模式要转,
//     劫持模式下它们的查询内核本来就接得到;
//   - dnsmasq 模式下出口是节点 / 节点组的终端(整台进内核,解析也跟着它的出口)。
//
// 拒绝的终端整台进内核,dnsmasq 模式下解析仍按域名规则答。没开分流解析(dns.split)时所有查询都是直连解析,不用转。
func TerminalDNSRedirected(cr Route, o TerminalDNSOptions) bool {
	if !o.AutoRedirect || !o.SplitDNS {
		return false
	}
	if o.DNSMode != "dnsmasq" && o.DNSMode != "hijack" {
		return false
	}
	if cr.Bypass {
		return true
	}
	if o.DNSMode != "dnsmasq" {
		return false
	}
	if IsProxyClientRoute(cr, o.DirectTag, o.BlockTag) {
		return true
	}
	return o.DirectBypass && IsDirectClientRoute(cr, o.DirectTag)
}
