package routing

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// 迁移的性质(用金标准语料里的 normalizeRouting 输入逐条检查):
//  1. 迁移前后 normalizeRouting 读出来的结果相同(行为不变)
//  2. 迁完之后不再有旧字段
//  3. 幂等:再迁一次 changed 为 false
//  4. changed 为 false 时 routing 原样不动
func TestMigrateStoredRoutingProperties(t *testing.T) {
	b, err := os.ReadFile("../../testdata/routing_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	changedCount := 0
	for i, c := range g.Cases {
		if c.Fn != "normalizeRouting" {
			continue
		}
		var in any
		if len(c.Args) > 0 {
			if err := json.Unmarshal(c.Args[0], &in); err != nil {
				t.Fatal(err)
			}
		}
		changed, out := migrateStoredRouting(in)
		// 经过一次 JSON 往返,模拟 Node 把结果存回去再读出来
		var stored any
		bs, _ := json.Marshal(out)
		_ = json.Unmarshal(bs, &stored)

		if !reflect.DeepEqual(normalizeRouting(in), normalizeRouting(stored)) {
			a, _ := json.Marshal(in)
			t.Fatalf("#%d 迁移改变了读出来的结果\n输入: %s", i, a)
		}
		if !changed {
			if !reflect.DeepEqual(in, out) {
				t.Fatalf("#%d changed=false 但 routing 被改了", i)
			}
			continue
		}
		changedCount++
		if m, ok := stored.(map[string]any); ok {
			for _, k := range legacyRoutingKeys {
				if _, present := m[k]; present {
					t.Fatalf("#%d 迁完仍有旧字段 %s", i, k)
				}
			}
		}
		if again, _ := migrateStoredRouting(stored); again {
			a, _ := json.Marshal(in)
			t.Fatalf("#%d 迁移不幂等\n输入: %s", i, a)
		}
	}
	if changedCount < 50 {
		t.Fatalf("语料里走到迁移的太少(%d),测试没有覆盖力", changedCount)
	}
	t.Logf("%d 条触发迁移,性质全部成立", changedCount)
}

func TestMigrateStoredRoutingShape(t *testing.T) {
	var in any
	_ = json.Unmarshal([]byte(`{"categories":[{"ruleset":"geosite-netflix","target":"美国"}],"directRulesets":["geosite-cn"],"fallback":"direct","adBlock":true,"policies":[]}`), &in)
	changed, out := migrateStoredRouting(in)
	m := out.(map[string]any)
	if !changed || m["adBlock"] != true {
		t.Fatalf("应迁移且保留 adBlock: %v", out)
	}
	pols := m["policies"].([]any)
	if len(pols) != 1 || pols[0].(map[string]any)["name"] != "geosite-netflix" {
		t.Fatalf("categories 没被翻译成站点集: %v", pols)
	}
	if c, same := migrateStoredRouting(map[string]any{"policies": []any{}}); c || same == nil {
		t.Fatal("没有旧字段时不应改动")
	}
}
