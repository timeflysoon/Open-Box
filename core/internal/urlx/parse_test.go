package urlx

import (
	"encoding/json"
	"os"
	"testing"
)

type partsFile struct {
	Cases []struct {
		In   string                                                                               `json:"in"`
		Want *struct{ Scheme, Username, Password, Hostname, Port, Pathname, Search, Hash string } `json:"want"`
	} `json:"cases"`
}

func checkParts(t *testing.T, path string) (total, bad int) {
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var g partsFile
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Cases {
		u, ok := Parse(c.In)
		var exp URL
		if c.Want != nil {
			exp = URL(*c.Want)
		}
		if ok != (c.Want != nil) || (ok && u != exp) {
			if bad++; bad <= 10 {
				t.Errorf("%q\n  go   %+v ok=%v\n  node %+v ok=%v", c.In, u, ok, exp, c.Want != nil)
			}
		}
	}
	return len(g.Cases), bad
}

// 金标准来自 Node 的 new URL(x) 各字段(见 testdata/gen-urlx-parts-golden.mjs)。
func TestParseGolden(t *testing.T) {
	total, bad := checkParts(t, "../../testdata/urlx_parts_golden.json")
	if bad > 0 {
		t.Fatalf("%d 条里 %d 条不一致", total, bad)
	}
	t.Logf("%d 条全部一致", total)
}

// 临时大语料差分:PARTS=/path/to.json go test -run TestParseBig
func TestParseBig(t *testing.T) {
	p := os.Getenv("PARTS")
	if p == "" {
		t.Skip("没设 PARTS")
	}
	total, bad := checkParts(t, p)
	t.Logf("%d total %d bad", total, bad)
	if bad > 0 {
		t.Fail()
	}
}

func TestParseKnown(t *testing.T) {
	cases := []struct {
		in string
		u  URL
	}{
		{"https://dns.example.net:2096/secret/path?x=1", URL{Scheme: "https", Hostname: "dns.example.net", Port: "2096", Pathname: "/secret/path", Search: "?x=1"}},
		{"https://dns.example.net:443/dns-query", URL{Scheme: "https", Hostname: "dns.example.net", Pathname: "/dns-query"}},
		{"https://h/a/../b/./c", URL{Scheme: "https", Hostname: "h", Pathname: "/b/c"}},
		{"https://h/a b?q=a b#", URL{Scheme: "https", Hostname: "h", Pathname: "/a%20b", Search: "?q=a%20b"}},
		{"https://u:p@h/#f", URL{Scheme: "https", Username: "u", Password: "p", Hostname: "h", Pathname: "/", Hash: "#f"}},
		{"https://[2001:db8::1]:8443", URL{Scheme: "https", Hostname: "[2001:db8::1]", Port: "8443", Pathname: "/"}},
		{"foo://h/..", URL{Scheme: "foo", Hostname: "h"}},
		{"foo://h/a/..", URL{Scheme: "foo", Hostname: "h", Pathname: "/"}},
	}
	for _, c := range cases {
		u, ok := Parse(c.in)
		if !ok || u != c.u {
			t.Errorf("%q: 有 %+v ok=%v,要 %+v", c.in, u, ok, c.u)
		}
	}
}
