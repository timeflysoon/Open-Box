// Package dnsfilter 把 DNS 域名过滤的「已编译产物」翻译成 sing-box DNS 规则
// (对应旧 Node engine/dns-filter.mjs 的 buildFilterConfig)。
//
// 名单的下载、解析、编译(parseDnsFilter、filterKey 等)都留在 Node 里,核心只做最后这一步。
// 旧版自己用 sha256(JSON.stringify(settings)) 算期望 key;新版由 Node 把算好的 key
// 作为 filterExpectedKey 传进来(见 index.mjs 里 configDetailed 的包装),
// 核心只需要比较,不用复刻 JS 的 JSON.stringify 键序。
package dnsfilter

import (
	"errors"
	"fmt"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// ErrNotReady 在过滤已开启、但名单产物缺失或与当前设置对不上时返回。
var ErrNotReady = errors.New("域名过滤名单尚未准备好,请更新名单后应用 DNS 设置")

// Result 对应旧版的 { rules, sets };两个切片一律非 nil。
type Result struct {
	Rules []any `json:"rules"`
	Sets  []any `json:"sets"`
}

// list 取产物里的数组字段:缺失(undefined)按空数组;其余必须是数组。
func list(artifact any, key string) ([]any, error) {
	v := jsx.Get(artifact, key)
	if jsx.IsUndefined(v) {
		return []any{}, nil
	}
	l, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("域名过滤产物的 %s 不是数组", key)
	}
	return l, nil
}

func and(rules []any) map[string]any {
	if len(rules) == 1 {
		if m, ok := rules[0].(map[string]any); ok {
			out := make(map[string]any, len(m)+2)
			for k, v := range m {
				out[k] = v
			}
			return out
		}
	}
	return map[string]any{"type": "logical", "mode": "and", "rules": rules}
}

// Build 相当于 buildFilterConfig(profile, artifact);expectedKey 即 filterExpectedKey。
func Build(profile, artifact, expectedKey any) (Result, error) {
	enabled := jsx.Get(jsx.Get(jsx.Get(profile, "dns"), "filter"), "enabled")
	if !jsx.Truthy(enabled) {
		return Result{Rules: []any{}, Sets: []any{}}, nil
	}
	key, keyOK := jsx.Get(artifact, "key").(string)
	want, wantOK := expectedKey.(string)
	if !jsx.Truthy(artifact) || !keyOK || !wantOK || key != want {
		return Result{}, ErrNotReady
	}

	sets, err := list(artifact, "sets")
	if err != nil {
		return Result{}, err
	}
	blocks, err := list(artifact, "blocks")
	if err != nil {
		return Result{}, err
	}
	allow, err := list(artifact, "allow")
	if err != nil {
		return Result{}, err
	}
	allowImportant, err := list(artifact, "allowImportant")
	if err != nil {
		return Result{}, err
	}
	userAllow, err := list(artifact, "userAllow")
	if err != nil {
		return Result{}, err
	}

	rules := []any{}
	for _, important := range []bool{true, false} {
		for _, b := range blocks {
			if imp, _ := jsx.Get(b, "important").(bool); imp != important || !isBool(jsx.Get(b, "important")) {
				continue
			}
			excluded := make([]any, 0, len(userAllow)+len(allowImportant)+len(allow))
			excluded = append(excluded, userAllow...)
			excluded = append(excluded, allowImportant...)
			if !important {
				excluded = append(excluded, allow...)
			}
			parts := []any{map[string]any{"rule_set": []any{jsx.Get(b, "tag")}}}
			if len(excluded) > 0 {
				parts = append(parts, map[string]any{"rule_set": excluded, "invert": true})
			}
			rule := and(parts)
			rule["action"] = "predefined"
			rule["rcode"] = "NXDOMAIN"
			rules = append(rules, rule)
		}
	}
	return Result{Rules: rules, Sets: sets}, nil
}

func isBool(v any) bool { _, ok := v.(bool); return ok }
