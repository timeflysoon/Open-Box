package kerneldns

import "testing"

func profileWith(rules []any, enabled bool) map[string]any {
	return map[string]any{"dns": map[string]any{
		"domainUpstreams": map[string]any{"enabled": enabled, "rules": rules},
	}}
}

func rule(matchType string, domains []any, server string) map[string]any {
	return map[string]any{"enabled": true, "matchType": matchType, "domains": domains,
		"server": server, "protocol": "udp", "port": float64(53)}
}

// 按档案推算 mihomo 下「指定域名 DNS」的走向:命中时给出规则键与上游地址,未命中返回 nil。
func TestMihomoConfigured(t *testing.T) {
	p := profileWith([]any{
		rule("domain", []any{"exact.test"}, "1.1.1.1"),
		rule("domainSuffix", []any{"suffix.test"}, "8.8.8.8"),
	}, true)

	got := MihomoConfigured(p, "exact.test")
	if got == nil || got["ruleKey"] != "DOMAIN,exact.test" {
		t.Fatalf("完全匹配没命中: %+v", got)
	}
	srv := got["server"].(map[string]any)
	if srv["server"] != "1.1.1.1" || srv["type"] != "UDP" {
		t.Fatalf("上游地址或类型不对: %+v", srv)
	}

	// 后缀匹配含自身,也含子域
	for _, d := range []string{"suffix.test", "a.b.suffix.test"} {
		g := MihomoConfigured(p, d)
		if g == nil || g["ruleKey"] != "DOMAIN-SUFFIX,suffix.test" {
			t.Fatalf("%s 后缀匹配没命中: %+v", d, g)
		}
	}
	// 不能误命中
	if g := MihomoConfigured(p, "notsuffix.test"); g != nil {
		t.Fatalf("不该命中: %+v", g)
	}

	// 总开关关着 / 没有配置 / 空域名 都返回 nil
	if g := MihomoConfigured(profileWith(nil, false), "exact.test"); g != nil {
		t.Fatalf("总开关关着不该推算: %+v", g)
	}
	if g := MihomoConfigured(map[string]any{}, "exact.test"); g != nil {
		t.Fatalf("没有档案不该推算: %+v", g)
	}
	if g := MihomoConfigured(p, ""); g != nil {
		t.Fatalf("空域名不该推算: %+v", g)
	}
}

// FakeIP 判断:默认占位段内为真,真实地址为假,非法输入为假。
func TestIsFakeIP(t *testing.T) {
	cases := map[string]bool{"198.18.0.13": true, "198.19.255.1": true, "223.109.82.212": false, "": false, "not-ip": false}
	for addr, want := range cases {
		if got := IsFakeIP(addr); got != want {
			t.Fatalf("IsFakeIP(%q)=%v, 想要 %v", addr, got, want)
		}
	}
}
