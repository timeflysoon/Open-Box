package emit

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

var earlyDataRe = regexp.MustCompile(`^(.*?)\?ed=(\d+)$`)

// objKeys 相当于 Object.keys(v).length,并告诉调用方 v 是不是对象(typeof 'object' 且非 null;数组也算)。
func objKeys(v any) (n int, isObject bool) {
	switch x := v.(type) {
	case map[string]any:
		return len(x), true
	case []any:
		return len(x), true
	}
	return 0, false
}

// hostList:逗号分隔的字符串或数组 → trim 后去空的字符串数组;空则 undefined。
func hostList(v any) any {
	if jsx.Nullish(v) {
		return jsx.Undefined
	}
	var items []string
	if a, ok := v.([]any); ok {
		for _, e := range a {
			items = append(items, str(e))
		}
	} else {
		items = strings.Split(str(v), ",")
	}
	out := []any{}
	for _, s := range items {
		if t := jsx.Trim(s); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return jsx.Undefined
	}
	return out
}

// headersWithoutHost:去掉 Host 头(大小写不敏感)后的 headers;为空则 undefined。
func headersWithoutHost(headers any) any {
	rest := map[string]any{}
	switch h := headers.(type) {
	case map[string]any:
		for k, v := range h {
			if strings.ToLower(k) != "host" {
				rest[k] = v
			}
		}
	case []any: // Object.entries(数组) 的键是下标
		for i, v := range h {
			rest[strconv.Itoa(i)] = v
		}
	default:
		return jsx.Undefined
	}
	if len(rest) == 0 {
		return jsx.Undefined
	}
	return rest
}

func hostFromHeaders(headers any) any {
	m, ok := headers.(map[string]any)
	if !ok {
		return jsx.Undefined
	}
	if h := jsx.Get(m, "Host"); jsx.Truthy(h) {
		return h
	}
	return jsx.Get(m, "host")
}

// or 相当于 a || b(取第一个为真的,都不真取 b)。
func or(a, b any) any {
	if jsx.Truthy(a) {
		return a
	}
	return b
}

// BuildTransport:按传输层类型只输出内核认识的字段;不认识的类型(xhttp / kcp / splithttp 等)当 tcp 处理。
func BuildTransport(t any) (map[string]any, bool) {
	typ := jsx.Get(t, "type")
	if !jsx.Truthy(t) || !jsx.Truthy(typ) || typ == "tcp" {
		return nil, false
	}
	get := func(k string) any { return jsx.Get(t, k) }
	switch typ {
	case "ws":
		out := map[string]any{"type": "ws"}
		path := ""
		if jsx.Truthy(get("path")) {
			path = str(get("path"))
		}
		// v2rayN 把 early data 写在 path 的 query 里:/ws?ed=2048
		if m := earlyDataRe.FindStringSubmatch(path); m != nil {
			path = m[1]
			n, _ := strconv.ParseFloat(m[2], 64)
			out["max_early_data"] = n
			out["early_data_header_name"] = "Sec-WebSocket-Protocol"
		}
		if path != "" {
			out["path"] = path
		}
		if n, isObj := objKeys(get("headers")); isObj && n > 0 {
			out["headers"] = get("headers")
		}
		if jsx.Truthy(get("max_early_data")) {
			out["max_early_data"] = get("max_early_data")
		}
		if jsx.Truthy(get("early_data_header_name")) {
			out["early_data_header_name"] = get("early_data_header_name")
		}
		return out, true
	case "http":
		out := map[string]any{"type": "http"}
		host := get("host")
		if jsx.Nullish(host) {
			host = hostFromHeaders(get("headers"))
		}
		set(out, "host", hostList(host))
		if jsx.Truthy(get("path")) {
			out["path"] = get("path")
		}
		if jsx.Truthy(get("method")) {
			out["method"] = get("method")
		}
		set(out, "headers", headersWithoutHost(get("headers")))
		return out, true
	case "grpc":
		out := map[string]any{"type": "grpc"}
		// v2rayN 的 vmess 把 serviceName 放在 path 里
		if name := or(get("service_name"), get("path")); jsx.Truthy(name) {
			out["service_name"] = strings.TrimLeft(str(name), "/")
		}
		return out, true
	case "httpupgrade":
		out := map[string]any{"type": "httpupgrade"}
		host := get("host")
		if jsx.Nullish(host) {
			host = hostFromHeaders(get("headers"))
		}
		if jsx.Truthy(host) {
			if a, isArr := host.([]any); isArr {
				var first any = jsx.Undefined
				if len(a) > 0 {
					first = a[0]
				}
				out["host"] = str(first)
			} else {
				out["host"] = str(host)
			}
		}
		if jsx.Truthy(get("path")) {
			out["path"] = get("path")
		}
		set(out, "headers", headersWithoutHost(get("headers")))
		return out, true
	case "quic":
		return map[string]any{"type": "quic"}, true
	}
	return nil, false
}

// BuildTls:quic=true 表示 tuic / hysteria2 这类基于 QUIC 的出站,内核在这条路径上不支持 uTLS,一律不写 utls。
// insecure 恒开(节点服务器证书归谁常常对不上),REALITY 例外(它用公钥验证)。
// http1:传输层是 ws / httpupgrade(HTTP/1.1 的 Upgrade)时写了 alpn 的一律换成只有 http/1.1(GitHub #374)。
func BuildTls(tls any, quic bool, http1 bool) (map[string]any, bool) {
	if !jsx.Truthy(tls) || !jsx.Truthy(jsx.Get(tls, "enabled")) {
		return nil, false
	}
	out := map[string]any{"enabled": true}
	if v := jsx.Get(tls, "server_name"); jsx.Truthy(v) {
		out["server_name"] = v
	}
	if a, ok := jsx.Get(tls, "alpn").([]any); ok && len(a) > 0 {
		if http1 {
			out["alpn"] = []any{"http/1.1"}
		} else {
			out["alpn"] = a
		}
	}
	utls := jsx.Get(tls, "utls")
	utlsOn := jsx.Truthy(utls) && jsx.Truthy(jsx.Get(utls, "enabled"))
	fingerprint := func() any {
		return or(normalizeUtlsFingerprint(jsx.Get(utls, "fingerprint")), "chrome")
	}
	reality := jsx.Get(tls, "reality")
	if jsx.Truthy(reality) && jsx.Truthy(jsx.Get(reality, "enabled")) {
		r := map[string]any{"enabled": true}
		if v := jsx.Get(reality, "public_key"); jsx.Truthy(v) {
			r["public_key"] = v
		}
		set(r, "short_id", normalizeRealityShortID(jsx.Get(reality, "short_id")))
		out["reality"] = r
		// reality 硬约束:必须有 utls
		if utlsOn {
			out["utls"] = map[string]any{"enabled": true, "fingerprint": fingerprint()}
		} else {
			out["utls"] = map[string]any{"enabled": true, "fingerprint": "chrome"}
		}
		return out, true
	}
	if !quic && utlsOn {
		out["utls"] = map[string]any{"enabled": true, "fingerprint": fingerprint()}
	}
	out["insecure"] = true
	return out, true
}

func base(n any) map[string]any {
	m := map[string]any{}
	set(m, "tag", jsx.Get(n, "tag"))
	set(m, "server", jsx.Get(n, "server"))
	set(m, "server_port", jsx.Get(n, "server_port"))
	return m
}

func withBase(typ string, n any) map[string]any {
	m := base(n)
	m["type"] = typ
	return m
}

func withTransport(o map[string]any, f any) map[string]any {
	if t, ok := BuildTransport(jsx.Get(f, "transport")); ok {
		o["transport"] = t
	}
	return o
}

// 传输层先写好(withTransport)再写 TLS:按生成出来的传输类型判断要不要把 alpn 限成 http/1.1。
func withTls(o map[string]any, f any, quic bool) map[string]any {
	http1 := false
	if t, ok := o["transport"].(map[string]any); ok {
		http1 = t["type"] == "ws" || t["type"] == "httpupgrade"
	}
	if t, ok := BuildTls(jsx.Get(f, "tls"), quic, http1); ok {
		o["tls"] = t
	}
	return o
}

// EmitOutbound 把一个节点翻译成 sing-box 出站。wireguard 是 endpoint,不走这里。
func EmitOutbound(node any) (map[string]any, error) {
	out, err := emitOutbound(node)
	if err != nil {
		return nil, err
	}
	// 链式代理:经上游那条线路去连这个节点(engine/chain-proxy.mjs)
	if d, ok := jsx.Get(node, "detour").(string); ok && d != "" {
		out["detour"] = d
	}
	return out, nil
}

func emitOutbound(node any) (map[string]any, error) {
	typ := jsx.Get(node, "type")
	if typ == "wireguard" {
		return nil, fmt.Errorf("wireguard must be emitted as an endpoint (use emitEndpoint)")
	}
	f := jsx.Get(node, "fields")
	fget := func(k string) any { return jsx.Get(f, k) }
	switch typ {
	case "shadowsocks":
		o := withBase("shadowsocks", node)
		set(o, "method", fget("method"))
		set(o, "password", fget("password"))
		if jsx.Truthy(fget("plugin")) {
			o["plugin"] = fget("plugin")
			if jsx.Truthy(fget("plugin_opts")) {
				o["plugin_opts"] = fget("plugin_opts")
			}
		}
		return o, nil
	case "vmess":
		o := withBase("vmess", node)
		set(o, "uuid", fget("uuid"))
		alter := fget("alter_id")
		if jsx.Nullish(alter) {
			alter = float64(0)
		}
		o["alter_id"] = alter
		o["security"] = or(fget("security"), "auto")
		return withTls(withTransport(o, f), f, false), nil
	case "vless":
		o := withBase("vless", node)
		set(o, "uuid", fget("uuid"))
		set(o, "flow", normalizeVlessFlow(fget("flow")))
		return withTls(withTransport(o, f), f, false), nil
	case "trojan":
		o := withBase("trojan", node)
		set(o, "password", fget("password"))
		return withTls(withTransport(o, f), f, false), nil
	case "anytls":
		o := withBase("anytls", node)
		set(o, "password", fget("password"))
		return withTls(o, f, false), nil
	case "hysteria2":
		o := withBase("hysteria2", node)
		set(o, "password", fget("password"))
		withTls(o, f, true)
		if jsx.Truthy(fget("obfs")) {
			o["obfs"] = fget("obfs")
		}
		// 端口跳跃(GitHub #171):写坏的整个不带
		if ports := normalizeHopPorts(fget("server_ports")); len(ports) > 0 {
			o["server_ports"] = ports
			if iv := normalizeHopInterval(fget("hop_interval")); iv != "" {
				o["hop_interval"] = iv
			}
		}
		// sing-box 1.14 起 hysteria2 默认模仿 Chrome 的 QUIC 握手指纹,服务端用 Ed25519 证书时会失败;
		// 订阅里没有这个信息,节点自带这个字段时原样带过去
		if fget("disable_chrome_parrot") == true || fget("disableChromeParrot") == true {
			o["disable_chrome_parrot"] = true
		}
		return o, nil
	case "socks":
		// socks 出站只有版本和账号密码:多写 tls / transport 内核会报 unknown field。version 缺省是 5。
		o := withBase("socks", node)
		if v := fget("version"); jsx.Truthy(v) && str(v) != "5" {
			o["version"] = str(v)
		}
		if v := fget("username"); jsx.Truthy(v) {
			o["username"] = str(v)
		}
		if v := fget("password"); jsx.Truthy(v) {
			o["password"] = str(v)
		}
		return o, nil
	case "http":
		// http 代理出站(住宅代理商的 http:// / https:// 账号):账号密码,https:// 的带 TLS
		o := withBase("http", node)
		if v := fget("username"); jsx.Truthy(v) {
			o["username"] = str(v)
		}
		if v := fget("password"); jsx.Truthy(v) {
			o["password"] = str(v)
		}
		return withTls(o, f, false), nil
	case "tuic":
		o := withBase("tuic", node)
		set(o, "uuid", fget("uuid"))
		set(o, "password", fget("password"))
		if jsx.Truthy(fget("congestion_control")) {
			o["congestion_control"] = fget("congestion_control")
		}
		return withTls(o, f, true), nil
	}
	return nil, fmt.Errorf("no outbound emitter for type: %s", str(typ))
}
