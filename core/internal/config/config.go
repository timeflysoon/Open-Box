// Package config 实现 sing-box 配置生成(对应上游 engine/config.mjs 的 buildConfigDetailed)。
package config

import (
	"encoding/json"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// Methods 是本包负责的方法名。
var Methods = []string{"configDetailed"}

// Register 注册本包的全部方法。
func Register(r *protocol.Registry) {
	r.Register("configDetailed", hConfigDetailed)
}

// configDetailed({nodes, profile, userGroups, ...}) → {config, dnsRuleOwners, directHosts, failover}
func hConfigDetailed(_ *protocol.Context, args []json.RawMessage) (any, error) {
	var in any
	if ok, err := protocol.Arg(args, 0, &in); err != nil {
		return nil, err
	} else if !ok {
		in = map[string]any{}
	}
	return BuildDetailed(in)
}
