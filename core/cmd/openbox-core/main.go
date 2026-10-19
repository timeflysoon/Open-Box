// openbox-core:无状态的 stdin/stdout JSON 计算核心,由面板 Node 服务端按需拉起。
package main

import (
	"os"

	"github.com/timeflysoon/Open-Box/core/internal/authz"
	"github.com/timeflysoon/Open-Box/core/internal/config"
	"github.com/timeflysoon/Open-Box/core/internal/groups"
	"github.com/timeflysoon/Open-Box/core/internal/protocol"
	"github.com/timeflysoon/Open-Box/core/internal/routing"
)

func newRegistry() *protocol.Registry {
	r := protocol.NewRegistry()
	routing.Register(r)
	groups.Register(r)
	config.Register(r)
	authz.Register(r)
	return r
}

func main() {
	// 退出码恒为 0:任何失败都已在 Serve 里变成 ok:false。
	protocol.Serve(os.Stdin, os.Stdout, newRegistry())
}
