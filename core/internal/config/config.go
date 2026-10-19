// Package config 实现 sing-box 配置生成(对应旧 Node 的 engine/config.mjs)。
package config

import "github.com/timeflysoon/Open-Box/core/internal/protocol"

// Methods 是本包负责的方法名。
var Methods = []string{"configDetailed"}

// Register 注册本包的全部方法(目前都是占位)。
func Register(r *protocol.Registry) {
	for _, m := range Methods {
		r.Register(m, protocol.NotImplemented(m))
	}
}
