package groups

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

type goldenCase struct {
	Fn   string            `json:"fn"`
	Args []json.RawMessage `json:"args"`
	Want any               `json:"want"`
}

func call(t *testing.T, reg *protocol.Registry, req []byte) any {
	t.Helper()
	var out bytes.Buffer
	protocol.Serve(bytes.NewReader(req), &out, reg)
	var resp struct {
		OK    bool   `json:"ok"`
		Value any    `json:"value"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("响应不是 JSON: %v\n%s", err, out.String())
	}
	if !resp.OK {
		t.Fatalf("调用失败: %s", resp.Error)
	}
	return resp.Value
}

// 金标准来自旧版 Node 实现(见 testdata/gen-groups-golden.mjs)。
func TestGoldenAgainstOldNode(t *testing.T) {
	b, err := os.ReadFile("../../testdata/groups_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	reg := protocol.NewRegistry()
	Register(reg)
	bad := 0
	for i, c := range g.Cases {
		req, _ := json.Marshal(map[string]any{"protocol": 1, "method": c.Fn, "args": c.Args})
		got := call(t, reg, req)
		if !reflect.DeepEqual(got, c.Want) {
			if bad++; bad <= 4 {
				gb, _ := json.Marshal(got)
				wb, _ := json.Marshal(c.Want)
				in, _ := json.Marshal(c.Args)
				t.Errorf("#%d %s 输出不一致\n输入: %s\n有: %s\n要: %s", i, c.Fn, in, gb, wb)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("共 %d 条不一致(总 %d 条)", bad, len(g.Cases))
	}
	t.Logf("%d 条金标准全部一致", len(g.Cases))
}

// 更严格:逐字节比较 JSON 文本(包括键的顺序),Node 存档 / 展示时看到的顺序和旧实现一致。
func TestGoldenKeyOrderByteExact(t *testing.T) {
	b, err := os.ReadFile("../../testdata/groups_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []struct {
			Fn   string            `json:"fn"`
			Args []json.RawMessage `json:"args"`
			Want json.RawMessage   `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	reg := protocol.NewRegistry()
	Register(reg)
	bad := 0
	for i, c := range g.Cases {
		req, _ := json.Marshal(map[string]any{"protocol": 1, "method": c.Fn, "args": c.Args})
		var out bytes.Buffer
		protocol.Serve(bytes.NewReader(req), &out, reg)
		var resp struct {
			Value json.RawMessage `json:"value"`
		}
		_ = json.Unmarshal(out.Bytes(), &resp)
		var got, want bytes.Buffer
		_ = json.Compact(&got, resp.Value)
		_ = json.Compact(&want, c.Want)
		if got.String() != want.String() {
			if bad++; bad <= 3 {
				in, _ := json.Marshal(c.Args)
				t.Errorf("#%d %s 文本不一致\n输入: %.400s\n有: %.600s\n要: %.600s", i, c.Fn, in, got.String(), want.String())
			}
		}
	}
	if bad > 0 {
		t.Fatalf("共 %d 条文本不一致(总 %d 条)", bad, len(g.Cases))
	}
}
