package routing

import (
	"math"
	"regexp"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// 对应上游 engine/dns-upstream.mjs(基线 v0.1.318 快照)。档案里的两个 DNS 上游(dns.direct / dns.proxy)和各自的
// 协议、端口、备用上游:
//   - 地址只收 IPv4 / IPv6 或「上游 DNS」记号 wan,不收域名(带域名的上游还得另找一个 DNS 去解析它)
//   - 协议只有 udp / tcp;端口默认 53,等于 53 时生成配置不写 server_port
//
// 这里只移植 configDetailed 用得到的部分。下面这些只有面板的 Node 进程用,不属于 core,没有移植:
// regionDnsDefaults / regionDnsError(地区页签与档案校验)、directResolverServers(面板自己做直连解析)、
// isProxyResolverTag / applyProxyUpstreamRoutes(部署后处理)、dnsPolicyClasses(部署流程)。

const (
	DefaultDNSPort        = 53
	DefaultDirectUpstream = "223.5.5.5"
	DefaultProxyUpstream  = "1.1.1.1"
	// MaxDNSExtras:每一侧最多几个备用上游(和主上游一起并发竞速)。
	MaxDNSExtras = 3
	// WanUpstream:「上游 DNS」记号——路由器系统此刻的上游 DNS(部署时读 resolv.conf.auto)。固定直连、固定 UDP 53。
	WanUpstream = "wan"
)

// JS 的 \d 只认 ASCII 数字,Go 的 \d 同样;字符类一律写死 ASCII,避免 (?i) 带进 Unicode 折叠(ſ、K 等)。
var (
	dnsIPv4Re   = regexp.MustCompile(`^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$`)
	dnsIPv6Re   = regexp.MustCompile(`^[0-9a-fA-F:]+$`)
	dnsSchemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.\-]*://`)
)

func isWanUpstream(v any) bool { s, ok := v.(string); return ok && s == WanUpstream }

// dnsRegionOf:路由器在哪(档案 dns.region)。没有这个键的(老设备、全新安装)按中国大陆算。
func dnsRegionOf(profile any) string {
	if jsx.Get(jsx.Get(profile, "dns"), "region") == "intl" {
		return "intl"
	}
	return "cn"
}

// wanFallbackUpstream:读不到系统的上游 DNS 时「上游 DNS」退回哪台。
func wanFallbackUpstream(region string) string {
	if region == "intl" {
		return DefaultProxyUpstream
	}
	return DefaultDirectUpstream
}

func isValidDNSUpstream(value any) bool {
	s, ok := value.(string)
	if !ok {
		return false
	}
	host := jsx.Trim(s)
	if host == "" {
		return false
	}
	if dnsIPv4Re.MatchString(host) {
		return host != "0.0.0.0"
	}
	if !strings.Contains(host, ":") {
		return false
	}
	return dnsIPv6Re.MatchString(host) && host != "::" && len(strings.Split(host, "::")) <= 2 && len(strings.Split(host, ":")) <= 8
}

// normalizeDNSUpstream:"https://1.1.1.1/dns-query" → "1.1.1.1";"[2001:db8::1]" → "2001:db8::1";裸地址原样(去空白)。
// 折不出合法 IP(包括域名)就返回空串,调用方自己决定兜底值。
func normalizeDNSUpstream(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	host := jsx.Trim(s)
	if dnsSchemeRe.MatchString(host) {
		h, ok := urlHostname(host) // new URL(host).hostname;抛错 → ''
		if !ok {
			return ""
		}
		host = h
	}
	host = strings.TrimPrefix(host, "[") // host.replace(/^\[|\]$/g, '')
	host = strings.TrimSuffix(host, "]")
	if isValidDNSUpstream(host) {
		return host // 注意:不再 trim——和 JS 一样,方括号里的空白会被原样带出去
	}
	return ""
}

func isDNSProtocol(v any) bool { s, ok := v.(string); return ok && (s == "udp" || s == "tcp") }

func isValidDNSPort(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || f < 1 || f > 65535 {
		return 0, false
	}
	return int(f), true
}

func dnsPortOr(v any) int {
	if p, ok := isValidDNSPort(v); ok {
		return p
	}
	return DefaultDNSPort
}

func dnsProtocolOr(v any, fallback string) string {
	if isDNSProtocol(v) {
		return v.(string)
	}
	return fallback
}

// upstream 是档案里的一条上游整理后的样子。Server 是 any:「上游 DNS」取的是部署时读到的系统上游,JS 里不做类型检查,
// 测试里喂过非字符串,保持原样带出去。
type upstream struct {
	Protocol string
	Server   any
	Port     int
	Wan      bool
}

// serverKey 对应 JS Set 的 SameValueZero:同一台上游去重用。
func serverKey(v any) string {
	switch x := v.(type) {
	case string:
		return "s:" + x
	case float64:
		return "n:" + jsx.NumberToString(x)
	}
	return "o:" + jsx.ToString(v)
}

// wanServer:「上游 DNS」此刻是哪台——部署时读到的系统上游 DNS 的第一台,读不到按地区退回。
func wanServer(profile any, systemDNS []any) any {
	for _, v := range systemDNS {
		if jsx.Truthy(v) {
			return v
		}
	}
	return wanFallbackUpstream(dnsRegionOf(profile))
}

// upstreamOf:档案里的一条上游 → upstream。上游 DNS 固定 UDP 53(协议跟着上游,档案里存的协议不看),wan 标出来
// (代理侧不给它写 detour);地址折不出合法 IP 的(手改库)按 invalid 退:直连侧退成上游 DNS,代理侧退成 1.1.1.1。
func upstreamOf(profile, raw, protocol, port any, fallbackProtocol, invalid string, systemDNS []any) upstream {
	server := ""
	if !isWanUpstream(raw) {
		server = normalizeDNSUpstream(raw)
	}
	if server == "" && (isWanUpstream(raw) || invalid == WanUpstream) {
		return upstream{Protocol: "udp", Server: wanServer(profile, systemDNS), Port: DefaultDNSPort, Wan: true}
	}
	if server == "" {
		server = invalid
	}
	return upstream{Protocol: dnsProtocolOr(protocol, fallbackProtocol), Server: server, Port: dnsPortOr(port)}
}

// directUpstream:直连侧实际用哪台。默认是上游 DNS。
func directUpstream(profile any, systemDNS []any) upstream {
	dns := jsx.Get(profile, "dns")
	return upstreamOf(profile, jsx.Get(dns, "direct"), jsx.Get(dns, "directProtocol"), jsx.Get(dns, "directPort"), "udp", WanUpstream, systemDNS)
}

// proxyUpstream:代理侧上游,协议默认 tcp(UDP 经代理常被截断 / 丢包),地址不合法退成 1.1.1.1。
func proxyUpstream(profile any, systemDNS []any) upstream {
	dns := jsx.Get(profile, "dns")
	return upstreamOf(profile, jsx.Get(dns, "proxy"), jsx.Get(dns, "proxyProtocol"), jsx.Get(dns, "proxyPort"), "tcp", DefaultProxyUpstream, systemDNS)
}

// extraUpstreams:备用上游(档案 dns.directExtras / dns.proxyExtras),和主上游并发竞速。
// 先截前 MaxDNSExtras 个再筛,和主上游(或别的备用)落到同一台的去掉。
func extraUpstreams(profile, list any, primary upstream, fallbackProtocol string, systemDNS []any) []upstream {
	out := []upstream{}
	arr, ok := list.([]any)
	if !ok {
		return out
	}
	if len(arr) > MaxDNSExtras {
		arr = arr[:MaxDNSExtras]
	}
	seen := map[string]bool{serverKey(primary.Server): true}
	for _, item := range arr {
		if !jsx.Truthy(item) {
			continue
		}
		server := jsx.Get(item, "server")
		if !(isWanUpstream(server) || normalizeDNSUpstream(server) != "") {
			continue
		}
		up := upstreamOf(profile, server, jsx.Get(item, "protocol"), jsx.Get(item, "port"), fallbackProtocol, WanUpstream, systemDNS)
		k := serverKey(up.Server)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, up)
	}
	return out
}

func directExtraUpstreams(profile any, systemDNS []any) []upstream {
	return extraUpstreams(profile, jsx.Get(jsx.Get(profile, "dns"), "directExtras"), directUpstream(profile, systemDNS), "udp", systemDNS)
}

func proxyExtraUpstreams(profile any, systemDNS []any) []upstream {
	return extraUpstreams(profile, jsx.Get(jsx.Get(profile, "dns"), "proxyExtras"), proxyUpstream(profile, systemDNS), "tcp", systemDNS)
}

// dnsServerEntry:生成配置里的一条 DNS server(sing-box 1.12+ 的 server 对象)。端口是默认 53 就不写 server_port。
func dnsServerEntry(up upstream, tag, detour string) map[string]any {
	m := map[string]any{"type": up.Protocol, "tag": tag, "server": up.Server}
	if up.Port != DefaultDNSPort {
		m["server_port"] = up.Port
	}
	if detour != "" {
		m["detour"] = detour
	}
	return m
}
