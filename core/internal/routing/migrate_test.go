package routing

import (
	"encoding/json"
	"os"
	"testing"
)

// 迁移本身的对照在金标准里(migrateStoredRouting 的 994 条之内)。这里再检查几条性质(用金标准语料的输入):
//  1. 迁完之后不再有旧字段
//  2. 幂等:再迁一次 changed 为 false
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
		if c.Fn != "migrateStoredRouting" {
			continue
		}
		setAvailableGeoTags(c.Geo)
		var in any
		if len(c.Args) > 0 {
			if err := json.Unmarshal(c.Args[0], &in); err != nil {
				t.Fatal(err)
			}
		}
		out, changed, _ := migrateStoredRoutingObj(in)
		if !changed {
			continue
		}
		changedCount++
		var stored map[string]any
		bs, _ := json.Marshal(out)
		_ = json.Unmarshal(bs, &stored)
		for _, k := range legacyRoutingKeys {
			if _, present := stored[k]; present {
				t.Fatalf("#%d 迁完仍有旧字段 %s", i, k)
			}
		}
		if _, again, _ := migrateStoredRoutingObj(stored); again {
			a, _ := json.Marshal(in)
			t.Fatalf("#%d 迁移不幂等\n输入: %s", i, a)
		}
	}
	setAvailableGeoTags(nil)
	if changedCount < 50 {
		t.Fatalf("语料里走到迁移的太少(%d),测试没有覆盖力", changedCount)
	}
	t.Logf("%d 条触发迁移,性质全部成立", changedCount)
}
