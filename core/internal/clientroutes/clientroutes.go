// Package clientroutes 整理「终端分流」:按局域网来源 IP / 网段指定出口
// (对应旧 Node 的 engine/client-routes.mjs)。
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

// Route 是整理后的一条终端分流。
type Route struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Sources  []string `json:"sources"`
	Outbound string   `json:"outbound"`
	Bypass   bool     `json:"bypass,omitempty"`
	// 指针:bypass 的路由即使 MAC 列表为空也要输出 "macs":[],非 bypass 的路由则整个字段不出现
	Macs *[]string `json:"macs,omitempty"`
}

// NormalizeClientRoutes:只留启用的、来源合法的;bypass=true 时按 MAC 在入口放行,
// 没有 auto_redirect 时退回「直连」出站(outbound 写成内置直连的 tag)。
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
		sources := []string{}
		if a, ok := jsx.Get(r, "sources").([]any); ok {
			for _, s := range a {
				if c := NormalizeCidr(s); c != "" {
					sources = append(sources, c)
				}
			}
		}
		bypass := jsx.Get(r, "bypass") == true
		macs := []string{}
		if bypass {
			seen := map[string]bool{}
			if a, ok := jsx.Get(r, "macs").([]any); ok {
				for _, m := range a {
					if v := NormalizeMac(m); v != "" && !seen[v] {
						seen[v] = true
						macs = append(macs, v)
					}
				}
			}
		}
		var outbound string
		trimmed, isStr := jsx.Get(r, "outbound").(string)
		if isStr {
			trimmed = jsx.Trim(trimmed)
		}
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
		if len(sources) == 0 || outbound == "" {
			continue
		}
		route := Route{ID: orEmpty(jsx.Get(r, "id")), Name: orEmpty(jsx.Get(r, "name")), Sources: sources, Outbound: outbound}
		if bypass {
			route.Bypass, route.Macs = true, &macs
		}
		out = append(out, route)
	}
	return out
}
