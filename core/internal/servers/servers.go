// Package servers 把档案里的「共享网络」服务器(profile.servers)翻译成 sing-box 入站
// (对应旧 Node 的 engine/servers.mjs)。入站 tag 固定为 share-<id>。
package servers

import (
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

const TLSServerName = "open-box.local"

func set(m map[string]any, k string, v any) {
	if !jsx.IsUndefined(v) {
		m[k] = v
	}
}

func str(v any) string { return jsx.ToString(v) }

func serverTag(s any) string { return "share-" + str(jsx.Get(s, "id")) }

// enabledServers 相当于 servers.filter(s => s && s.enabled !== false)。
func enabledServers(servers any) []any {
	arr, ok := servers.([]any)
	if !ok {
		return nil
	}
	out := []any{}
	for _, s := range arr {
		if !jsx.Truthy(s) {
			continue
		}
		if en, isBool := jsx.Get(s, "enabled").(bool); isBool && !en {
			continue
		}
		out = append(out, s)
	}
	return out
}

// BuildServerInbounds:TUIC、Hysteria2 必须 TLS,VLESS 可选;证书路径由调用方给(sing-box 自己签的)。
// mixed 是 SOCKS5 + HTTP 共用一个端口,只给局域网用。options 里只用 certPath / keyPath。
func BuildServerInbounds(servers any, options any) []any {
	certPath, keyPath := jsx.Get(options, "certPath"), jsx.Get(options, "keyPath")
	tls := func() map[string]any {
		t := map[string]any{"enabled": true, "server_name": TLSServerName}
		set(t, "certificate_path", certPath)
		set(t, "key_path", keyPath)
		return t
	}
	out := []any{}
	for _, s := range enabledServers(servers) {
		in := map[string]any{"tag": serverTag(s), "listen": "::"}
		set(in, "listen_port", jsx.Get(s, "port"))
		get := func(k string) any { return jsx.Get(s, k) }
		switch get("protocol") {
		case "shadowsocks":
			in["type"] = "shadowsocks"
			set(in, "method", get("method"))
			set(in, "password", get("password"))
		case "vless":
			in["type"] = "vless"
			u := map[string]any{}
			set(u, "uuid", get("uuid"))
			in["users"] = []any{u}
			if get("tls") == true {
				in["tls"] = tls()
			}
		case "tuic":
			in["type"] = "tuic"
			u := map[string]any{}
			set(u, "uuid", get("uuid"))
			set(u, "password", get("password"))
			in["users"] = []any{u}
			in["congestion_control"] = "bbr"
			t := tls()
			t["alpn"] = []any{"h3"}
			in["tls"] = t
		case "hysteria2":
			in["type"] = "hysteria2"
			u := map[string]any{}
			set(u, "password", get("password"))
			in["users"] = []any{u}
			t := tls()
			t["alpn"] = []any{"h3"}
			in["tls"] = t
			if jsx.Truthy(get("obfs")) {
				in["obfs"] = map[string]any{"type": "salamander", "password": get("obfs")}
			}
		case "mixed":
			// 没填用户名就是不认证(sing-box 的 users 留空即可)
			in["type"] = "mixed"
			if jsx.Truthy(get("username")) {
				pw := get("password")
				if !jsx.Truthy(pw) {
					pw = ""
				}
				in["users"] = []any{map[string]any{"username": get("username"), "password": pw}}
			}
		default:
			continue
		}
		out = append(out, in)
	}
	return out
}
