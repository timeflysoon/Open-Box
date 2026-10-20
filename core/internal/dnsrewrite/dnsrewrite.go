// Package dnsrewrite 处理 DNS 重写(设置 → 后端 → DNS 劫持 下面那张卡):
// 把一个域名的解析答案改成别的域名、或固定的 IPv4 / IPv6
// (对应旧 Node 的 engine/dns-rewrite.mjs,只含生成 sing-box 配置要用的那部分)。
package dnsrewrite

import (
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/timeflysoon/Open-Box/core/internal/ipx"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

const (
	Tag  = "dns-rewrite"
	Port = 7854
)

var trailingDotsRe = regexp.MustCompile(`\.+$`)

func labelOK(l string) bool {
	if len(l) < 1 || len(l) > 63 || strings.HasPrefix(l, "-") || strings.HasSuffix(l, "-") {
		return false
	}
	for i := 0; i < len(l); i++ {
		c := l[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func toStr(raw any) string {
	if jsx.Nullish(raw) {
		return ""
	}
	return jsx.ToString(raw)
}

// NormalizeDomain:小写、去首尾空白、去末尾的点;非法返回 ""。allowWildcard 时接受前导 "*."。
func NormalizeDomain(raw any, allowWildcard bool) string {
	d := trailingDotsRe.ReplaceAllString(strings.ToLower(jsx.Trim(toStr(raw))), "")
	wildcard := false
	if allowWildcard && strings.HasPrefix(d, "*.") {
		wildcard, d = true, d[2:]
	}
	if d == "" || len(utf16.Encode([]rune(d))) > 253 || strings.Contains(d, "*") {
		return ""
	}
	for _, l := range strings.Split(d, ".") {
		if !labelOK(l) {
			return ""
		}
	}
	if wildcard {
		return "*." + d
	}
	return d
}

func isWildcardSource(s string) bool { return strings.HasPrefix(s, "*.") }

func normalizeAddress(raw any) string {
	a := strings.ToLower(jsx.Trim(toStr(raw)))
	if ipx.IsIP(a) != 0 {
		return a
	}
	return ""
}

// Rule 是整理后的一条重写规则。
type Rule struct {
	ID        string   `json:"id"`
	Enabled   bool     `json:"enabled"`
	Source    string   `json:"source"`
	Domain    string   `json:"domain"`
	Addresses []string `json:"addresses"`
	Note      string   `json:"note"`
}

func sliceUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

func normalizeRule(raw any, index int) Rule {
	addresses := []string{}
	if a, ok := jsx.Get(raw, "addresses").([]any); ok {
		for _, x := range a {
			v := normalizeAddress(x)
			if v == "" {
				continue
			}
			dup := false
			for _, e := range addresses {
				if e == v {
					dup = true
				}
			}
			if !dup {
				addresses = append(addresses, v)
			}
		}
	}
	domain := NormalizeDomain(jsx.Get(raw, "domain"), false)
	r := Rule{Source: NormalizeDomain(jsx.Get(raw, "source"), true), Domain: domain, Addresses: addresses}
	if id, ok := jsx.NonEmpty(jsx.Get(raw, "id")); ok {
		r.ID = id
	} else {
		r.ID = "rw-" + jsx.NumberToString(float64(index+1))
	}
	en, isBool := jsx.Get(raw, "enabled").(bool)
	r.Enabled = !(isBool && !en)
	// 域名型和 IP 型只能二选一:两个都填了按域名型算
	if domain != "" {
		r.Addresses = []string{}
	}
	if note, ok := jsx.Get(raw, "note").(string); ok {
		r.Note = sliceUTF16(jsx.Trim(note), 200)
	}
	return r
}

// Rewrite 是档案 dns 段里的重写配置的内部形状。
type Rewrite struct {
	Enabled     bool   `json:"enabled"`
	Initialized bool   `json:"initialized"`
	Rules       []Rule `json:"rules"`
}

func isObject(v any) bool {
	switch v.(type) {
	case map[string]any, []any:
		return true
	}
	return false
}

// NormalizeDnsRewrite:缺字段 = 还没初始化(和显式的空列表分开)。
func NormalizeDnsRewrite(dns any) Rewrite {
	rw := jsx.Get(dns, "rewrite")
	if !isObject(rw) {
		rw = nil
	}
	out := Rewrite{Rules: []Rule{}}
	en, isBool := jsx.Get(rw, "enabled").(bool)
	out.Enabled = !(isBool && !en)
	out.Initialized = jsx.Truthy(jsx.Get(rw, "initialized"))
	if rules, ok := jsx.Get(rw, "rules").([]any); ok {
		for i, raw := range rules {
			r := normalizeRule(raw, i)
			if r.Source != "" && (r.Domain != "" || len(r.Addresses) > 0) {
				out.Rules = append(out.Rules, r)
			}
		}
	}
	return out
}

func enabledRules(rules []Rule) []Rule {
	out := []Rule{}
	for _, r := range rules {
		if r.Enabled && r.Source != "" && (r.Domain != "" || len(r.Addresses) > 0) {
			out = append(out, r)
		}
	}
	return out
}

// RewriteDnsRules 生成 dns.rules 最前面那几条「这些域名交给 dns-rewrite 服务器」:
// 精确域名照写;泛域名写根域的后缀(dnsmasq 的 server=/x/ 本来就连根域一起转)。
func RewriteDnsRules(rules []Rule) []any {
	exact, suffix := []any{}, []any{}
	for _, r := range enabledRules(rules) {
		if isWildcardSource(r.Source) {
			suffix = append(suffix, "."+r.Source[2:])
		} else {
			exact = append(exact, r.Source)
		}
	}
	out := []any{}
	if len(exact) > 0 {
		out = append(out, map[string]any{"domain": exact, "server": Tag})
	}
	if len(suffix) > 0 {
		out = append(out, map[string]any{"domain_suffix": suffix, "server": Tag})
	}
	return out
}

// RewriteDnsServer 是面板进程在 127.0.0.1:7854 上开的那个小 DNS 服务。
func RewriteDnsServer() map[string]any {
	return map[string]any{"type": "udp", "tag": Tag, "server": "127.0.0.1", "server_port": float64(Port)}
}

// NormalizeRuleForTest 暴露单条规则的归一化,供对照测试使用。
func NormalizeRuleForTest(raw any, index int) Rule { return normalizeRule(raw, index) }
