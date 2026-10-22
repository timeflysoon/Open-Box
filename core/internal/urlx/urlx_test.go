package urlx

import (
	"encoding/json"
	"os"
	"testing"
)

// 金标准来自 Node 内置的 new URL(x).hostname(见 testdata/gen-urlx-golden.mjs)。
// 语料避开了需要 UTS46 映射表 / 双向规则的写法(已知差异,见 README)。
func TestHostnameGolden(t *testing.T) {
	b, err := os.ReadFile("../../testdata/urlx_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Wide  bool `json:"wide"`
		Cases []struct {
			In   string  `json:"in"`
			Want *string `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if g.Wide {
		t.Fatal("提交的金标准不该是 --wide 生成的")
	}
	bad, accepted := 0, 0
	for i, c := range g.Cases {
		h, ok := Hostname(c.In)
		if ok {
			accepted++
		}
		if (c.Want == nil) == ok || (c.Want != nil && *c.Want != h) {
			if bad++; bad <= 10 {
				w := "<抛错>"
				if c.Want != nil {
					w = *c.Want
				}
				t.Errorf("#%d %q: 有 %q(ok=%v) 要 %q", i, c.In, h, ok, w)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("共 %d 条不一致(总 %d 条)", bad, len(g.Cases))
	}
	if accepted < 500 {
		t.Fatalf("语料太偏:只有 %d 条能解析出主机", accepted)
	}
	t.Logf("%d 条全部一致(其中 %d 条解析成功)", len(g.Cases), accepted)
}

// 手写的关键用例:即使金标准被重新生成,这些写法也不能退化。
func TestHostnameKnown(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"http://0x7f.1/", "127.0.0.1", true},
		{"http://127.1:80/", "127.0.0.1", true},
		{"http://1.2.3/", "1.2.0.3", true},
		{"http://4294967296/", "", false},
		{"http:\\\\back.example.com\\path", "back.example.com", true},
		{"https:noslash.example.com/x", "noslash.example.com", true},
		{"https://[2001:db8:0:0:0:0:0:1]:8443/", "[2001:db8::1]", true},
		{"https://xn--.example.com/", "", false},
		{"https://xn--a.example.com/", "", false},
		{"https://xn--fiq228c.example.com/", "xn--fiq228c.example.com", true},
		{"https://h.example.com:99999/", "", false},
		{"file://a:", "", true},
		{"foo:opaque", "", true},
		{"foo://Opaque.Example/x", "Opaque.Example", true},
		{"example.com/path", "", false},
		// 制表 / 换行在任何位置都被删掉
		{"https://tab\t.example.com/", "tab.example.com", true},
		{"ht\ttp://nl.example.com/", "nl.example.com", true},
		{"https://new\nline.example.com/", "newline.example.com", true},
		// IPv6 压缩:取最长的零段,并列取靠前的
		{"https://[1:0:0:2:0:0:3:4]/", "[1::2:0:0:3:4]", true},
		{"https://[0:0:1:0:0:2:0:0]/", "[::1:0:0:2:0:0]", true},
		{"https://[1:0:0:0:2:0:0:3]/", "[1::2:0:0:3]", true},
		// 非特殊协议:有端口没有主机也抛错
		{"foo://:80/", "", false},
		{"foo://:/", "", false},
		// xn-- 标签:含非 ASCII、punycode 溢出 / 非法都抛错
		{"https://xn--ß.com/", "", false},
		{"https://xn--a,ß.com/", "", false},
		{"https://xn--99999999999999999999.com/", "", false},
		{"https://xn--zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.com/", "", false},
	}
	for _, c := range cases {
		h, ok := Hostname(c.in)
		if h != c.want || ok != c.ok {
			t.Errorf("%q: 有 %q ok=%v,要 %q ok=%v", c.in, h, ok, c.want, c.ok)
		}
	}
}
