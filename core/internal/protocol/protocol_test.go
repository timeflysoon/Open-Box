package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func run(t *testing.T, reg *Registry, in string) map[string]any {
	t.Helper()
	var out bytes.Buffer
	Serve(strings.NewReader(in), &out, reg)
	var m map[string]any
	if err := json.Unmarshal(out.Bytes(), &m); err != nil {
		t.Fatalf("输出不是 JSON: %v\n%s", err, out.String())
	}
	if m["protocol"] != float64(1) {
		t.Fatalf("protocol 不是 1: %v", m)
	}
	return m
}

func TestHello(t *testing.T) {
	old := BuildID
	BuildID = "abc"
	defer func() { BuildID = old }()
	m := run(t, NewRegistry(), `{"protocol":1,"method":"hello","args":[]}`)
	v := m["value"].(map[string]any)
	if m["ok"] != true || v["implementation"] != "go-native" || v["protocol"] != float64(1) || v["buildID"] != "abc" {
		t.Fatalf("握手不对: %v", m)
	}
}

func TestErrorsAreOkFalse(t *testing.T) {
	reg := NewRegistry()
	reg.Register("boom", func(*Context, []json.RawMessage) (any, error) { return nil, errors.New("坏了") })
	reg.Register("panic", func(*Context, []json.RawMessage) (any, error) { panic("炸了") })
	for name, in := range map[string]string{
		"坏JSON":     `{`,
		"协议不符":      `{"protocol":2,"method":"hello"}`,
		"未知方法":      `{"protocol":1,"method":"nope"}`,
		"处理函数报错":    `{"protocol":1,"method":"boom"}`,
		"处理函数panic": `{"protocol":1,"method":"panic"}`,
		"空输入":       ``,
	} {
		m := run(t, reg, in)
		if m["ok"] != false || m["error"] == "" || m["error"] == nil {
			t.Errorf("%s: 应为 ok:false 且带 error: %v", name, m)
		}
	}
}

func TestLicenseIgnoredAndGeoTags(t *testing.T) {
	reg := NewRegistry()
	var got *Context
	reg.Register("probe", func(c *Context, _ []json.RawMessage) (any, error) { got = c; return nil, nil })
	m := run(t, reg, `{"protocol":1,"method":"probe","args":[],"license":"x","geoTags":["geoip-cn","geosite-cn"]}`)
	if m["ok"] != true || !got.HasGeoTags || len(got.GeoTags) != 2 {
		t.Fatalf("geoTags 没传到: %v %+v", m, got)
	}
	if v, present := m["value"]; !present || v != nil {
		t.Fatalf("返回 nil 时 value 应为 null 而不是缺失: %v", m)
	}
	run(t, reg, `{"protocol":1,"method":"probe","args":[]}`)
	if got.HasGeoTags {
		t.Fatal("没带 geoTags 时 HasGeoTags 应为 false")
	}
}

func TestFalseValueKept(t *testing.T) {
	reg := NewRegistry()
	reg.Register("no", func(*Context, []json.RawMessage) (any, error) { return false, nil })
	m := run(t, reg, `{"protocol":1,"method":"no"}`)
	if v, present := m["value"]; !present || v != false {
		t.Fatalf("false 不能被省略: %v", m)
	}
}

func TestNoHTMLEscape(t *testing.T) {
	reg := NewRegistry()
	reg.Register("s", func(*Context, []json.RawMessage) (any, error) { return "a<b>&c", nil })
	var out bytes.Buffer
	Serve(strings.NewReader(`{"protocol":1,"method":"s"}`), &out, reg)
	if !strings.Contains(out.String(), `"a<b>&c"`) {
		t.Fatalf("不应转义 HTML 字符: %s", out.String())
	}
}

func TestInputTooLarge(t *testing.T) {
	big := `{"protocol":1,"method":"hello","args":["` + strings.Repeat("x", MaxInputBytes) + `"]}`
	m := run(t, NewRegistry(), big)
	if m["ok"] != false {
		t.Fatal("超过 32 MiB 应失败")
	}
}
