package clientroutes

import "testing"

// admit 的路由在 NormalizeClientRoutes 里直接跳过,金标准碰不到 ClientMatch 对 admit 的推算,这里手写补上。
func TestClientMatch(t *testing.T) {
	macs := []any{"aa:bb:cc:dd:ee:ff"}
	cases := []struct {
		name string
		in   map[string]any
		want string
	}{
		{"显式 ip 优先于 macs", map[string]any{"match": "ip", "bypass": true, "macs": macs}, "ip"},
		{"显式 mac 优先", map[string]any{"match": "mac"}, "mac"},
		{"老档案 bypass 带 macs 算 mac", map[string]any{"bypass": true, "macs": macs}, "mac"},
		{"老档案 admit 带 macs 算 mac", map[string]any{"admit": true, "macs": macs}, "mac"},
		{"老档案 admit 没有 macs 算 ip", map[string]any{"admit": true, "macs": []any{}}, "ip"},
		{"普通规则带 macs 仍算 ip", map[string]any{"macs": macs}, "ip"},
		{"match 写错当没写", map[string]any{"match": "x", "admit": true, "macs": macs}, "mac"},
	}
	for _, c := range cases {
		if got := ClientMatch(c.in); got != c.want {
			t.Errorf("%s: 得到 %s 要 %s", c.name, got, c.want)
		}
	}
}
