// Package emit 把订阅解析出来的节点翻译成 sing-box 的出站 / endpoint
// (对应上游 engine/node-fields.mjs、emit-outbound.mjs、emit-endpoint.mjs,v0.1.318)。
//
// 输出用 map[string]any:很多字段(headers 等)是原样透传的动态结构,sing-box 也不在乎键的顺序。
// JS 里值为 undefined 的键在序列化时会消失,这里用 set 达到同样的效果;null 则保留。
package emit

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

const vlessFlowVision = "xtls-rprx-vision"

var shortIDRe = regexp.MustCompile(`^[0-9a-fA-F]{1,16}$`)

// set 相当于 obj[k] = v 再序列化:值是 undefined 就不写。
func set(m map[string]any, k string, v any) {
	if !jsx.IsUndefined(v) {
		m[k] = v
	}
}

// str 相当于 String(v)。
func str(v any) string { return jsx.ToString(v) }

// normalizeVlessFlow:sing-box 只支持 xtls-rprx-vision;none / 空 / 其他废弃写法都丢掉(节点照常保留)。
func normalizeVlessFlow(flow any) any {
	var v string
	if !jsx.Nullish(flow) {
		v = jsx.Trim(str(flow))
	}
	if v == "" || v == "none" {
		return jsx.Undefined
	}
	if strings.HasPrefix(v, vlessFlowVision) {
		return vlessFlowVision
	}
	return jsx.Undefined
}

// normalizeUtlsFingerprint:mihomo 的 unsafe 兼容值内核不认,换成 chrome;其他值原样(包括非字符串)。
func normalizeUtlsFingerprint(fp any) any {
	if jsx.Nullish(fp) {
		return fp
	}
	if strings.ToLower(jsx.Trim(str(fp))) == "unsafe" {
		return "chrome"
	}
	return fp
}

// normalizeRealityShortID:十六进制、最长 16 位。空 / null / "null" / 非十六进制一律不写。
func normalizeRealityShortID(v any) any {
	if jsx.Nullish(v) {
		return jsx.Undefined
	}
	s := jsx.Trim(str(v))
	if s == "" || s == "null" || s == "undefined" {
		return jsx.Undefined
	}
	if shortIDRe.MatchString(s) {
		return s
	}
	return jsx.Undefined
}

// JS 里 \s 的范围(和 String.prototype.trim 一致),Go 的 \s 只有 ASCII。
const jsSpace = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var (
	hopSplitRe = regexp.MustCompile(`[,，;` + jsSpace + `]+`)
	hopPartRe  = regexp.MustCompile(`^(\d{1,5})(?:[` + jsSpace + `]*[-:~][` + jsSpace + `]*(\d{1,5}))?$`)
	hopIntRe   = regexp.MustCompile(`^\d+$`)
	hopDurRe   = regexp.MustCompile(`^\d+(ms|s|m|h)$`)
)

// normalizeHopPorts:hysteria2 端口跳跃。来源写法 "20000-40000,50000" 之类,内核要 ["20000:40000","50000:50000"];
// 有一段看不懂就整个不要(空),只有一个端口不算跳跃。返回的切片一律非 nil。
func normalizeHopPorts(value any) []any {
	var parts []string
	if a, ok := value.([]any); ok {
		for _, e := range a {
			if t := jsx.Trim(str(e)); t != "" {
				parts = append(parts, t)
			}
		}
	} else {
		text := ""
		if !jsx.Nullish(value) {
			text = str(value)
		}
		for _, e := range hopSplitRe.Split(text, -1) {
			if t := jsx.Trim(e); t != "" {
				parts = append(parts, t)
			}
		}
	}
	out := []any{}
	var firstA, firstB int
	for i, part := range parts {
		m := hopPartRe.FindStringSubmatch(part)
		if m == nil {
			return []any{}
		}
		a, _ := strconv.Atoi(m[1])
		b := a
		if m[2] != "" {
			b, _ = strconv.Atoi(m[2])
		}
		if a < 1 || b > 65535 || a > b {
			return []any{}
		}
		if i == 0 {
			firstA, firstB = a, b
		}
		out = append(out, strconv.Itoa(a)+":"+strconv.Itoa(b))
	}
	if len(out) == 1 && firstA == firstB {
		return []any{}
	}
	return out
}

// normalizeHopInterval:秒数(不小于 5)或带单位的时长;不合法返回空串。
func normalizeHopInterval(value any) string {
	if jsx.Nullish(value) || value == "" {
		return ""
	}
	text := jsx.Trim(str(value))
	if hopIntRe.MatchString(text) {
		n := jsx.ToNumber(text)
		if n >= 5 {
			return jsx.NumberToString(n) + "s"
		}
		return ""
	}
	if hopDurRe.MatchString(text) {
		return text
	}
	return ""
}
