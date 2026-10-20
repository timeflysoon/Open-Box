package emit

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type goldenCase struct {
	Fn    string          `json:"fn"`
	Node  json.RawMessage `json:"node"`
	Want  any             `json:"want"`
	Error string          `json:"error"`
}

// 金标准来自旧版 Node 实现(见 testdata/gen-emit-golden.mjs):同一个节点,Go 的输出(或报错)必须一致。
func TestGoldenAgainstOldNode(t *testing.T) {
	b, err := os.ReadFile("../../testdata/emit_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	bad := 0
	for i, c := range g.Cases {
		var node any
		if err := json.Unmarshal(c.Node, &node); err != nil {
			t.Fatal(err)
		}
		var got map[string]any
		var gerr error
		switch c.Fn {
		case "emitOutbound":
			got, gerr = EmitOutbound(node)
		case "emitEndpoint":
			got, gerr = EmitEndpoint(node)
		default:
			t.Fatalf("未知 fn %s", c.Fn)
		}
		fail := func(msg string) {
			if bad++; bad <= 5 {
				gb, _ := json.Marshal(got)
				wb, _ := json.Marshal(c.Want)
				t.Errorf("#%d %s %s\n输入: %s\n有: %s (err=%v)\n要: %s (err=%q)", i, c.Fn, msg, c.Node, gb, gerr, wb, c.Error)
			}
		}
		if c.Error != "" {
			if gerr == nil || gerr.Error() != c.Error {
				fail("报错不一致")
			}
			continue
		}
		if gerr != nil {
			fail("不该报错")
			continue
		}
		// 经 JSON 往返,和 Node 通过协议拿到的数据形态一致
		gb, _ := json.Marshal(got)
		var gotAny any
		_ = json.Unmarshal(gb, &gotAny)
		if !reflect.DeepEqual(gotAny, c.Want) {
			fail("输出不一致")
		}
	}
	if bad > 0 {
		t.Fatalf("共 %d 条不一致(总 %d 条)", bad, len(g.Cases))
	}
	t.Logf("%d 条金标准全部一致", len(g.Cases))
}
