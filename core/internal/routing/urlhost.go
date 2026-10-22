package routing

import (
	"regexp"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
	"github.com/timeflysoon/Open-Box/core/internal/urlx"
)

// 复刻 dns.mjs 的 extractHost:带协议头的写法取 new URL(x).hostname,其余原样返回。
var schemeHeadRe = regexp.MustCompile(`(?i)^[a-z]+://`)

func extractHost(v any) any {
	s := jsx.ToString(v)
	if !schemeHeadRe.MatchString(s) {
		return v
	}
	if h, ok := urlx.Hostname(s); ok {
		return h
	}
	return v // new URL 抛错 → catch 后原样返回
}
