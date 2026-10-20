// Package emit 把订阅解析出来的节点翻译成 sing-box 的出站 / endpoint
// (对应旧 Node 的 engine/node-fields.mjs、emit-outbound.mjs、emit-endpoint.mjs)。
//
// 输出用 map[string]any:很多字段(headers 等)是原样透传的动态结构,sing-box 也不在乎键的顺序。
// JS 里值为 undefined 的键在序列化时会消失,这里用 set 达到同样的效果;null 则保留。
package emit

import (
	"regexp"
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
