package emit

import (
	"fmt"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// withPrefix:Clash 的 wireguard 写裸 IP,sing-box 的 address 要带前缀(缺了直接 FATAL):单机地址是 /32、/128。
func withPrefix(a any) string {
	s := jsx.Trim(str(a))
	if s == "" || strings.Contains(s, "/") {
		return s
	}
	if strings.Contains(s, ":") {
		return s + "/128"
	}
	return s + "/32"
}

// EmitEndpoint 把 wireguard 节点翻译成 sing-box endpoint。
func EmitEndpoint(node any) (map[string]any, error) {
	if typ := jsx.Get(node, "type"); typ != "wireguard" {
		return nil, fmt.Errorf("emitEndpoint only supports wireguard, got: %s", str(typ))
	}
	f := jsx.Get(node, "fields")
	peer := map[string]any{"allowed_ips": []any{"0.0.0.0/0", "::/0"}}
	set(peer, "address", jsx.Get(node, "server"))
	set(peer, "port", jsx.Get(node, "server_port"))
	set(peer, "public_key", jsx.Get(f, "peer_public_key"))
	if v := jsx.Get(f, "pre_shared_key"); jsx.Truthy(v) {
		peer["pre_shared_key"] = v
	}
	addrs := []any{}
	if a, ok := jsx.Get(f, "local_address").([]any); ok {
		for _, x := range a {
			addrs = append(addrs, withPrefix(x))
		}
	}
	out := map[string]any{"type": "wireguard", "system": false, "address": addrs, "peers": []any{peer}}
	set(out, "tag", jsx.Get(node, "tag"))
	set(out, "private_key", jsx.Get(f, "private_key"))
	return out, nil
}
