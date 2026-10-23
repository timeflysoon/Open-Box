// Package groups 实现节点分组相关方法(对应旧 Node 的 engine/user-groups.mjs)。
package groups

import (
	"encoding/json"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// Methods 是本包负责的方法名。
var Methods = []string{"normalizeGroups", "builtinTags", "emitGroups"}

// Register 注册本包的全部方法。
func Register(r *protocol.Registry) {
	r.Register("normalizeGroups", hNormalizeGroups)
	r.Register("builtinTags", hBuiltinTags)
	r.Register("emitGroups", hEmitGroups)
}

func arg(args []json.RawMessage, i int) (any, error) {
	var v any
	_, err := protocol.Arg(args, i, &v)
	return v, err
}

// normalizeGroups(list)
func hNormalizeGroups(_ *protocol.Context, args []json.RawMessage) (any, error) {
	list, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	return NormalizeGroups(list), nil
}

// builtinTags(groups) → {direct, block, directEnabled, blockEnabled}
func hBuiltinTags(_ *protocol.Context, args []json.RawMessage) (any, error) {
	list, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	return builtinTags(NormalizeGroups(list)), nil
}

// emitGroups(groups, nodes, options)
func hEmitGroups(_ *protocol.Context, args []json.RawMessage) (any, error) {
	groups, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	nodes, err := arg(args, 1)
	if err != nil {
		return nil, err
	}
	options, err := arg(args, 2)
	if err != nil {
		return nil, err
	}
	return EmitUserGroups(groups, nodes, options)
}

// BuiltinTags 供 config 包使用:原始分组列表 → 内置直连 / 拒绝的当前名字(对应 builtinTags(list))。
func BuiltinTags(list any) Builtin { return builtinTags(NormalizeGroups(list)) }
