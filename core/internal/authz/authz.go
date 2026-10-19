// Package authz 提供 Node 的 /api/openbox/activation 与 /license 接口所调用的方法。
// 本核心没有激活机制:相关功能一律处于解锁状态,license 字段被忽略。
//
// 注意:返回值里除下面这几个字段外,面板是否还用到别的字段,尚未对照上游行为确认。
package authz

import (
	"encoding/json"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// Register 注册本包的方法。
func Register(r *protocol.Registry) {
	r.Register("checkActivationCode", checkActivationCode)
	r.Register("activationState", activationState)
	r.Register("authorizationState", authorizationState)
}

// checkActivationCode 任何激活码都视为有效。
func checkActivationCode(*protocol.Context, []json.RawMessage) (any, error) {
	return true, nil
}

type activation struct {
	Activated bool   `json:"activated"`
	Left      string `json:"left"`
	Right     string `json:"right"`
	UpdatedAt int64  `json:"updatedAt"`
}

// activationState 的参数是 Node 存的原始字符串(可能为 null);永远返回已激活,
// 并把存下来的 left/right/updatedAt 原样带回。
func activationState(_ *protocol.Context, args []json.RawMessage) (any, error) {
	st := activation{Activated: true}
	var raw *string
	if _, err := protocol.Arg(args, 0, &raw); err == nil && raw != nil {
		var stored struct {
			Left      string `json:"left"`
			Right     string `json:"right"`
			UpdatedAt int64  `json:"updatedAt"`
		}
		if json.Unmarshal([]byte(*raw), &stored) == nil {
			st.Left, st.Right, st.UpdatedAt = stored.Left, stored.Right, stored.UpdatedAt
		}
	}
	return st, nil
}

type license struct {
	Valid  bool   `json:"valid"`
	Reason string `json:"reason"`
}

// authorizationState 任何令牌(包括空)都视为有效。
func authorizationState(*protocol.Context, []json.RawMessage) (any, error) {
	return struct {
		License license `json:"license"`
	}{license{Valid: true}}, nil
}
