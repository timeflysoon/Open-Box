package groups

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// JS 里 \s 的范围(和 String.prototype.trim 一致),Go 的 \s 只有 ASCII。
const jsSpace = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var expectedPartRe = regexp.MustCompile(`^(\d{3})(?:[` + jsSpace + `]*-[` + jsSpace + `]*(\d{3}))?$`)

// NormalizeExpectedStatus:测速「可接受状态码」(内核 tcp19,engine/test-url.mjs 的 normalizeExpectedStatus)。
// 空 / "*" / 没写 = 什么应答都算通,返回 ("", true);写法不对返回 ("", false)(JS 里是 null);
// 合法则回规范写法,如 "200-299/302"。调用方一律用 `?? ”`,所以只看第一个返回值也行。
func NormalizeExpectedStatus(raw any) (string, bool) {
	if jsx.Nullish(raw) {
		return "", true
	}
	s, ok := raw.(string)
	if !ok {
		return "", false
	}
	text := jsx.Trim(s)
	if text == "" || text == "*" {
		return "", true
	}
	parts := []string{}
	for _, p := range strings.FieldsFunc(text, func(r rune) bool { return r == '/' || r == ',' }) {
		if t := jsx.Trim(p); t != "" {
			parts = append(parts, t)
		}
	}
	if len(parts) == 0 {
		return "", false
	}
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		m := expectedPartRe.FindStringSubmatch(part)
		if m == nil {
			return "", false
		}
		from, _ := strconv.Atoi(m[1])
		to := from
		if m[2] != "" {
			to, _ = strconv.Atoi(m[2])
		}
		if from < 100 || to > 599 || to < from {
			return "", false
		}
		if from == to {
			out = append(out, strconv.Itoa(from))
		} else {
			out = append(out, strconv.Itoa(from)+"-"+strconv.Itoa(to))
		}
	}
	return strings.Join(out, "/"), true
}
