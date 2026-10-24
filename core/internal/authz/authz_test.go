package authz

import (
	"encoding/json"
	"testing"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

func call(t *testing.T, name string, args ...string) any {
	t.Helper()
	r := protocol.NewRegistry()
	Register(r)
	// 通过协议入口调用,保证和 Node 的用法一致
	_ = r
	raws := make([]json.RawMessage, len(args))
	for i, a := range args {
		raws[i] = json.RawMessage(a)
	}
	var h protocol.Handler
	switch name {
	case "checkActivationCode":
		h = checkActivationCode
	case "activationState":
		h = activationState
	default:
		h = authorizationState
	}
	v, err := h(&protocol.Context{}, raws)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestUnlocked(t *testing.T) {
	if call(t, "checkActivationCode", `"anything"`) != true {
		t.Fatal("激活码应一律有效")
	}
	if st := call(t, "activationState", `null`).(activation); !st.Activated {
		t.Fatal("应永远已激活")
	}
	st := call(t, "activationState", `"{\"activated\":true,\"left\":\"L\",\"right\":\"R\",\"updatedAt\":5}"`).(activation)
	if st.Left != "L" || st.Right != "R" || st.UpdatedAt != 5 {
		t.Fatalf("应带回存下的标签: %+v", st)
	}
	b, _ := json.Marshal(call(t, "authorizationState", `""`))
	if string(b) != `{"license":{"features":[],"reason":"","valid":true},"permissions":{"license.status":true,"panel.activation":true,"router.config":true,"router.groups":true,"router.routing":true}}` {
		t.Fatalf("授权状态不对: %s", b)
	}
}
