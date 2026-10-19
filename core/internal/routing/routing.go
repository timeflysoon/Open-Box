// Package routing 实现分流模型相关方法(对应旧 Node 的 engine/routing-model.mjs)。
package routing

import (
	"encoding/json"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// Methods 是本包负责的方法名。
var Methods = []string{
	"normalizePolicy", "normalizeRouting", "routingFingerprint", "migrateStoredRouting",
	"classes", "forwardPlan", "entryPlan", "bypassPlan",
}

// Register 注册本包的全部方法;还没移植的先占位。
func Register(r *protocol.Registry) {
	done := map[string]protocol.Handler{
		"normalizePolicy":      hNormalizePolicy,
		"normalizeRouting":     hNormalizeRouting,
		"routingFingerprint":   hRoutingFingerprint,
		"migrateStoredRouting": hMigrateStoredRouting,
		"classes":              hClasses,
		"forwardPlan":          hForwardPlan,
		"bypassPlan":           hBypassPlan,
	}
	for _, m := range Methods {
		if h, ok := done[m]; ok {
			r.Register(m, h)
		} else {
			r.Register(m, protocol.NotImplemented(m))
		}
	}
}

func arg(args []json.RawMessage, i int) (any, error) {
	var v any
	_, err := protocol.Arg(args, i, &v)
	return v, err
}

// normalizePolicy(raw, index = 0)
func hNormalizePolicy(_ *protocol.Context, args []json.RawMessage) (any, error) {
	raw, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	index := 0
	if n, err := arg(args, 1); err == nil {
		if f, ok := n.(float64); ok {
			index = int(f)
		}
	}
	return normalizePolicy(raw, index), nil
}

// normalizeRouting(routing)
func hNormalizeRouting(_ *protocol.Context, args []json.RawMessage) (any, error) {
	raw, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	return normalizeRouting(raw), nil
}

// routingFingerprint(routing)
func hRoutingFingerprint(_ *protocol.Context, args []json.RawMessage) (any, error) {
	raw, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	return routingFingerprint(raw), nil
}
