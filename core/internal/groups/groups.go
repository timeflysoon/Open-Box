// Package groups 实现节点分组相关方法(对应旧 Node 的 engine/groups.mjs、user-groups.mjs)。
package groups

import "github.com/timeflysoon/Open-Box/core/internal/protocol"

// Methods 是本包负责的方法名。
var Methods = []string{"normalizeGroups", "builtinTags", "emitGroups"}

// Register 注册本包的全部方法(目前都是占位)。
func Register(r *protocol.Registry) {
	for _, m := range Methods {
		r.Register(m, protocol.NotImplemented(m))
	}
}
