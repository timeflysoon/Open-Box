// Package protocol 实现面板 Node 服务端与 openbox-core 之间的 stdin/stdout JSON 协议。
//
// Node 每次调用都 spawnSync 启动本程序(不带参数):
//
//	stdin : {"protocol":1,"method":"...","args":[...],"license":"...","geoTags":[...]}
//	stdout: {"protocol":1,"ok":true,"value":...} 或 {"protocol":1,"ok":false,"error":"..."}
//
// 约束:退出码必须是 0,失败只能用 ok:false 表达;输入上限 32 MiB,输出上限 64 MiB。
// license 字段被有意忽略(没有激活机制)。
package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

const (
	Version        = 1
	Implementation = "go-native"
	MaxInputBytes  = 32 << 20
	MaxOutputBytes = 64 << 20
)

// BuildID 由构建脚本注入:
// -ldflags "-X github.com/timeflysoon/Open-Box/core/internal/protocol.BuildID=<64位hex>"。
// Node 端写死了期望值,hello 返回的必须与它完全相同,否则面板拒绝使用核心。
var BuildID = "dev"

// Request 是 Node 发来的请求。license 字段不声明,解码时自然被忽略。
type Request struct {
	Protocol int               `json:"protocol"`
	Method   string            `json:"method"`
	Args     []json.RawMessage `json:"args"`
	GeoTags  *[]string         `json:"geoTags,omitempty"`
}

// Response 是返回给 Node 的响应。
type Response struct {
	Protocol int             `json:"protocol"`
	OK       bool            `json:"ok"`
	Value    json.RawMessage `json:"value,omitempty"`
	Error    string          `json:"error,omitempty"`
}

// Context 携带每次请求附带的环境信息。
type Context struct {
	// HasGeoTags 为 false 表示 Node 没带 geoTags。
	HasGeoTags bool
	// GeoTags 是 geodata 清单里的 geoip-xx / geosite-xx 名单。
	GeoTags []string
}

// Handler 处理一个方法。返回的 value 会被序列化进 value 字段,error 变成 ok:false。
type Handler func(c *Context, args []json.RawMessage) (any, error)

// Registry 是方法名到处理函数的映射。
type Registry struct {
	handlers map[string]Handler
}

// NewRegistry 创建注册表,并内置 hello 握手。
func NewRegistry() *Registry {
	r := &Registry{handlers: map[string]Handler{}}
	r.Register("hello", func(*Context, []json.RawMessage) (any, error) {
		return struct {
			Implementation string `json:"implementation"`
			Protocol       int    `json:"protocol"`
			BuildID        string `json:"buildID"`
		}{Implementation, Version, BuildID}, nil
	})
	return r
}

// Register 注册方法;重名直接 panic(启动期编程错误)。
func (r *Registry) Register(name string, h Handler) {
	if _, dup := r.handlers[name]; dup {
		panic("protocol: 重复注册方法 " + name)
	}
	r.handlers[name] = h
}

// Methods 返回已注册的方法名(排序后),供测试和诊断用。
func (r *Registry) Methods() []string {
	out := make([]string, 0, len(r.handlers))
	for k := range r.handlers {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// NotImplemented 返回一个只报"尚未实现"的占位处理函数。
func NotImplemented(name string) Handler {
	return func(*Context, []json.RawMessage) (any, error) {
		return nil, fmt.Errorf("方法 %s 尚未实现", name)
	}
}

// Arg 把第 i 个参数解码到 v;参数缺失时 v 保持零值并返回 false。
func Arg(args []json.RawMessage, i int, v any) (bool, error) {
	if i >= len(args) {
		return false, nil
	}
	if err := json.Unmarshal(args[i], v); err != nil {
		return true, fmt.Errorf("第 %d 个参数无效: %w", i+1, err)
	}
	return true, nil
}

// Serve 读取一个请求、分发、写出一个响应。无论发生什么都不会 panic。
func Serve(in io.Reader, out io.Writer, reg *Registry) {
	write(out, handle(in, reg))
}

func handle(in io.Reader, reg *Registry) (resp Response) {
	defer func() {
		if p := recover(); p != nil {
			resp = fail(fmt.Sprintf("核心内部错误: %v", p))
		}
	}()

	raw, err := io.ReadAll(io.LimitReader(in, MaxInputBytes+1))
	if err != nil {
		return fail("读取输入失败: " + err.Error())
	}
	if len(raw) > MaxInputBytes {
		return fail("输入超过 32 MiB")
	}
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		return fail("请求不是有效的 JSON: " + err.Error())
	}
	if req.Protocol != Version {
		return fail(fmt.Sprintf("不支持的协议版本 %d(需要 %d)", req.Protocol, Version))
	}
	h, ok := reg.handlers[req.Method]
	if !ok {
		return fail("未知方法: " + req.Method)
	}
	c := &Context{}
	if req.GeoTags != nil {
		c.HasGeoTags, c.GeoTags = true, *req.GeoTags
	}
	val, err := h(c, req.Args)
	if err != nil {
		return fail(err.Error())
	}
	b, err := marshal(val)
	if err != nil {
		return fail("结果序列化失败: " + err.Error())
	}
	return Response{Protocol: Version, OK: true, Value: b}
}

func fail(msg string) Response { return Response{Protocol: Version, Error: msg} }

// marshal 序列化且不转义 < > &(与 JS 的 JSON.stringify 输出一致)。
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func write(out io.Writer, resp Response) {
	b, err := marshal(resp)
	if err != nil || len(b) > MaxOutputBytes {
		msg := "输出超过 64 MiB"
		if err != nil {
			msg = "响应序列化失败: " + err.Error()
		}
		b, _ = marshal(fail(msg))
	}
	_, _ = out.Write(append(b, '\n'))
}
