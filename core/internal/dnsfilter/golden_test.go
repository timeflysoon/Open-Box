package dnsfilter

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type goldenCase struct {
	Args  []any  `json:"args"`
	Want  any    `json:"want"`
	Error string `json:"error"`
}

// 金标准来自旧版 Node 实现(见 testdata/gen-dnsfilter-golden.mjs)。
func TestGoldenAgainstOldNode(t *testing.T) {
	b, err := os.ReadFile("../../testdata/dnsfilter_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	bad, ready, off, notReady := 0, 0, 0, 0
	for i, c := range g.Cases {
		res, err := Build(c.Args[0], c.Args[1], c.Args[2])
		if c.Error != "" {
			notReady++
			if err == nil || err.Error() != c.Error {
				bad++
				t.Errorf("#%d 应报错 %q,实际 err=%v 值=%v", i, c.Error, err, res)
			}
			continue
		}
		if err != nil {
			bad++
			t.Errorf("#%d 不应报错,实际 %v", i, err)
			continue
		}
		gb, _ := json.Marshal(res)
		var got any
		_ = json.Unmarshal(gb, &got)
		if !reflect.DeepEqual(got, c.Want) {
			if bad++; bad <= 6 {
				in, _ := json.Marshal(c.Args)
				wb, _ := json.Marshal(c.Want)
				t.Errorf("#%d 输出不一致\n输入: %.400s\n有: %.500s\n要: %.500s", i, in, gb, wb)
			}
		}
		if len(res.Rules) > 0 {
			ready++
		} else {
			off++
		}
	}
	if bad > 0 {
		t.Fatalf("共 %d 条不一致(总 %d 条)", bad, len(g.Cases))
	}
	t.Logf("%d 条全部一致:产出规则 %d、空结果 %d、报「未准备好」%d", len(g.Cases), ready, off, notReady)
	if ready < 150 || notReady < 40 {
		t.Fatalf("语料覆盖不足:有规则 %d、报错 %d", ready, notReady)
	}
}
