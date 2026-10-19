package routing

import (
	"fmt"
	"math"
	"strings"
)

// 本文件是对 JS 动态语义的一小层模拟:入参来自 JSON 解码(any),
// 字符串/数组/对象的判断方式要和旧 Node 实现(routing-model.mjs)逐条一致。

// isJSSpace 与 ECMAScript 的 WhiteSpace + LineTerminator 一致(String.prototype.trim 和正则 \s 用的同一批)。
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// get 相当于 raw?.key:raw 不是对象时得到 nil(JS 的 undefined)。
func get(raw any, key string) any {
	if m, ok := raw.(map[string]any); ok {
		return m[key]
	}
	return nil
}

func asObject(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func asArray(v any) ([]any, bool) {
	a, ok := v.([]any)
	return a, ok
}

// nonEmpty 相当于 isNonEmptyString:是字符串且 trim 后非空,返回 trim 后的值。
func nonEmpty(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	t := jsTrim(s)
	return t, t != ""
}

// strList 相当于 strList():数组里的非空字符串,逐个 trim;其他一律丢掉。结果永不为 nil。
func strList(v any) []string {
	out := []string{}
	if a, ok := asArray(v); ok {
		for _, e := range a {
			if s, ok := nonEmpty(e); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

// notFalse 相当于 `v !== false`。
func notFalse(v any) bool {
	b, ok := v.(bool)
	return !(ok && !b)
}

// isInteger 相当于 Number.isInteger(v);负零按 0 处理(JSON.stringify(-0) 就是 "0")。
func isInteger(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return 0, false
	}
	if f == 0 {
		return 0, true
	}
	return f, true
}

func inList(s string, list []string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// dedupe 相当于 [...new Set(list)]:保持首次出现的顺序。
func dedupe(list []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(list))
	for _, s := range list {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func toAny(list []string) []any {
	out := make([]any, len(list))
	for i, s := range list {
		out[i] = s
	}
	return out
}

func idx(format string, n int) string { return fmt.Sprintf(format, n) }
