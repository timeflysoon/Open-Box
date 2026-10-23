package config

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type buildCase struct {
	Args  json.RawMessage `json:"args"`
	Want  json.RawMessage `json:"want"`
	Error string          `json:"error"`
}

// 金标准:同一份入参喂基线 engine/config.mjs 的 buildConfigDetailed 得到的 {config, dnsRuleOwners, directHosts, failover}
// (gen-config-golden.mjs 生成)。
func TestBuildDetailedGolden(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/config_golden.json")
	if err != nil {
		t.Skip("没有金标准文件:", err)
	}
	var g struct {
		Cases []buildCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) == 0 {
		t.Fatal("金标准是空的")
	}
	bad, ran := 0, 0
	for i, c := range g.Cases {
		var args any
		if err := json.Unmarshal(c.Args, &args); err != nil {
			t.Fatal(err)
		}
		got, err := BuildDetailed(args)
		ran++
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				t.Errorf("case %d: 期望报错 %q,实际 %v", i, c.Error, err)
				bad++
			}
		} else {
			if err != nil {
				t.Errorf("case %d: 意外报错 %v", i, err)
				bad++
			} else {
				var want any
				_ = json.Unmarshal(c.Want, &want)
				if !reflect.DeepEqual(toAny(got), want) {
					bad++
					if bad <= 3 {
						t.Errorf("case %d: 输出不一致\n%s", i, firstDiff("", toAny(got), want))
					}
				}
			}
		}
		if bad > 25 {
			t.Fatalf("不一致太多,停止(已跑 %d 条)", ran)
		}
	}
	t.Logf("共 %d 条,不一致 %d", len(g.Cases), bad)
}

// firstDiff 找出第一处不一致的路径,方便定位。
func firstDiff(path string, got, want any) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return path + ": 类型不同"
		}
		for k := range w {
			if _, has := g[k]; !has {
				return path + "." + k + ": 缺少"
			}
			if d := firstDiff(path+"."+k, g[k], w[k]); d != "" {
				return d
			}
		}
		for k := range g {
			if _, has := w[k]; !has {
				return path + "." + k + ": 多余"
			}
		}
		return ""
	case []any:
		g, ok := got.([]any)
		if !ok {
			return path + ": 类型不同"
		}
		if len(g) != len(w) {
			gj, _ := json.Marshal(g)
			wj, _ := json.Marshal(w)
			return path + ": 长度 " + itoa(len(g)) + " vs " + itoa(len(w)) + "\n got " + string(gj) + "\nwant " + string(wj)
		}
		for i := range w {
			if d := firstDiff(path+"["+itoa(i)+"]", g[i], w[i]); d != "" {
				return d
			}
		}
		return ""
	}
	if !reflect.DeepEqual(got, want) {
		gj, _ := json.Marshal(got)
		wj, _ := json.Marshal(want)
		return path + ": got " + string(gj) + " want " + string(wj)
	}
	return ""
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
