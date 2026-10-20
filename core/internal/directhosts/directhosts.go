// Package directhosts 收集「订阅和节点站点直连」要用的主机:订阅链接的主机名、各节点的服务器地址,
// 一律直连,不看站点集(对应旧 Node 的 engine/direct-hosts.mjs)。域名进 domains,IP 进 cidrs(/32、/128)。
//
// 已知差异:Node 用 WHATWG 的 new URL(...).hostname;这里用 net/url 解析后再补上小写和中文域名转 punycode。
// 常见的 http(s)://host:port/path 写法一致;0x7f.1 这类 IPv4 简写、反斜杠当斜杠、% 编码的主机名不一致。
package directhosts

import (
	"net/netip"
	"net/url"
	"regexp"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/idna"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

var (
	v4Re     = regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}$`)
	v6Re     = regexp.MustCompile(`(?i)^[0-9a-f:.]+$`)
	domainRe = regexp.MustCompile(`^[a-z0-9.-]+$`)
)

type Hosts struct {
	Domains []string `json:"domains"`
	Cidrs   []string `json:"cidrs"`
}

type ordered struct {
	list []string
	set  map[string]bool
}

func (o *ordered) add(v string) {
	if !o.set[v] {
		o.set[v] = true
		o.list = append(o.list, v)
	}
}

// hostname 相当于 new URL(raw).hostname;不是合法 URL 返回 ok=false。
// WHATWG 会把主机名转小写、中文域名转 punycode、IPv6 写成压缩形式,这里补上这几步。
func hostname(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return "", false
	}
	h := strings.ToLower(u.Hostname())
	if strings.Contains(h, ":") && !strings.Contains(h, ".") {
		if a, err := netip.ParseAddr(h); err == nil && a.Is6() {
			return a.String(), true
		}
	}
	for _, r := range h {
		if r > 0x7e {
			if ascii, ok := idna.ToASCII(h); ok {
				h = ascii
			}
			break
		}
	}
	return h, true
}

func Collect(nodes, subscriptions any) Hosts {
	domains := &ordered{set: map[string]bool{}}
	cidrs := &ordered{set: map[string]bool{}}
	add := func(host any) {
		s := ""
		if jsx.Truthy(host) {
			s = jsx.ToString(host)
		}
		h := strings.ToLower(jsx.Trim(s))
		h = strings.TrimPrefix(h, "[")
		h = strings.TrimSuffix(h, "]")
		if h == "" || h == "localhost" {
			return
		}
		switch {
		case v4Re.MatchString(h):
			cidrs.add(h + "/32")
		case strings.Contains(h, ":") && v6Re.MatchString(h):
			cidrs.add(h + "/128")
		case domainRe.MatchString(h) && strings.Contains(h, "."):
			domains.add(h)
		}
	}
	if arr, ok := nodes.([]any); ok {
		for _, n := range arr {
			add(jsx.Get(n, "server"))
		}
	}
	if arr, ok := subscriptions.([]any); ok {
		for _, s := range arr {
			// 一条订阅可以有多个地址(urls);老记录只有 url
			urls := []any{jsx.Get(s, "url")}
			if l, ok := jsx.Get(s, "urls").([]any); ok && len(l) > 0 {
				urls = l
			}
			for _, raw := range urls {
				str, isStr := raw.(string)
				if !isStr {
					continue
				}
				rawURL := jsx.Trim(str)
				if rawURL == "" {
					continue
				}
				if h, ok := hostname(rawURL); ok {
					add(h)
				}
			}
		}
	}
	out := Hosts{Domains: domains.list, Cidrs: cidrs.list}
	if out.Domains == nil {
		out.Domains = []string{}
	}
	if out.Cidrs == nil {
		out.Cidrs = []string{}
	}
	return out
}
