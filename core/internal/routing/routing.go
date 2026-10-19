// Package routing 实现分流模型相关方法(对应旧 Node 的 engine/routing-model.mjs)。
package routing

import "github.com/timeflysoon/Open-Box/core/internal/protocol"

// Methods 是本包负责的方法名。
var Methods = []string{
	"normalizePolicy", "normalizeRouting", "routingFingerprint", "migrateStoredRouting",
	"classes", "forwardPlan", "entryPlan", "bypassPlan",
}

// Register 注册本包的全部方法(目前都是占位,逐个移植后替换)。
func Register(r *protocol.Registry) {
	for _, m := range Methods {
		r.Register(m, protocol.NotImplemented(m))
	}
}
