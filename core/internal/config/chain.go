package config

import (
	"github.com/timeflysoon/Open-Box/core/internal/groups"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// 对应基线 engine/chain-proxy.mjs 的 resolveChainNodes。
// 和基线的分工不同:链接解析(parseChainNode / chainNodes)留在 Node 里做,新版 Node 把解析好的候选节点
// 当 chainNodes 传进来;这里只做「进内核前的核对」(重名 / 上游 / 环)。

// resolveChainNodes 返回通过核对的链式节点(保持输入顺序)。
func resolveChainNodes(candidatesRaw any, nodes any, userGroups any) ([]any, error) {
	candidates := []any{}
	if l, ok := candidatesRaw.([]any); ok {
		for _, c := range l {
			if _, isObj := c.(map[string]any); isObj {
				candidates = append(candidates, c)
			}
		}
	}
	nodeList, _ := nodes.([]any)
	groupList, _ := userGroups.([]any)
	if groupList == nil {
		groupList = []any{}
	}
	strOf := func(v any, key string) string {
		s, _ := jsx.Get(v, key).(string)
		return s
	}
	builtin := groups.BuiltinTags(groupList)

	baseTags := map[string]bool{}
	for _, n := range nodeList {
		if t := strOf(n, "tag"); t != "" {
			baseTags[t] = true
		}
	}
	for _, g := range groupList {
		if t := strOf(g, "name"); t != "" {
			baseTags[t] = true
		}
	}
	for _, t := range []string{builtin.Direct, builtin.Block} {
		if t != "" {
			baseTags[t] = true
		}
	}
	kept := candidates[:0:0]
	for _, c := range candidates {
		if baseTags[strOf(c, "tag")] { // duplicate
			continue
		}
		kept = append(kept, c)
	}
	candidates = kept

	// 每轮剔掉一个坏的,上界在开始前定死(基线 2026-09-22 的教训)
	maxRounds := len(candidates) + 1
	for round := 0; round <= maxRounds; round++ {
		all := append(append([]any{}, nodeList...), candidates...)
		res, err := groups.EmitUserGroups(groupList, all, map[string]any{})
		if err != nil {
			return nil, err
		}
		edges := map[string][]string{}
		for _, o := range res.Outbounds {
			if o.Outbounds != nil {
				edges[o.Tag] = o.Outbounds
			}
		}
		for _, c := range candidates {
			edges[strOf(c, "tag")] = []string{strOf(c, "detour")}
		}
		nodeTags := map[string]bool{}
		for _, n := range all {
			if n != nil && jsx.Get(n, "type") != "wireguard" {
				if t, ok := jsx.Get(n, "tag").(string); ok {
					nodeTags[t] = true
				}
			}
		}
		groupTags := map[string]bool{}
		for _, t := range res.PublicTags {
			groupTags[t] = true
		}
		var reaches func(from, target string, seen map[string]bool) bool
		reaches = func(from, target string, seen map[string]bool) bool {
			for _, next := range edges[from] {
				if next == target {
					return true
				}
				if seen[next] {
					continue
				}
				seen[next] = true
				if reaches(next, target, seen) {
					return true
				}
			}
			return false
		}
		bad := -1
		for i, c := range candidates {
			tag, detour := strOf(c, "tag"), strOf(c, "detour")
			okUpstream := detour != tag && detour != builtin.Direct && detour != builtin.Block && (nodeTags[detour] || groupTags[detour])
			if !okUpstream || reaches(tag, tag, map[string]bool{}) {
				bad = i
				break
			}
		}
		if bad < 0 {
			break
		}
		candidates = append(append([]any{}, candidates[:bad]...), candidates[bad+1:]...)
	}
	return candidates, nil
}
