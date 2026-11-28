package system

import (
	"context"
	"testing"
)

// 策略路由检查:优先级别比 32765 小的「lookup main」算冲突,其余不算。
func TestProbeRoutingConflicts(t *testing.T) {
	run := func(_ context.Context, name string, args ...string) (RunResult, error) {
		if name == "ip" && len(args) == 2 && args[0] == "rule" && args[1] == "show" {
			return RunResult{Code: 0, Stdout: "" +
				"0:	from all lookup local\n" +
				"100:	from all lookup main\n" +
				"32766:	from all lookup main\n" +
				"32767:	from all lookup default\n"}, nil
		}
		return RunResult{}, nil
	}
	got := probeRoutingConflicts(context.Background(), run)
	if got == nil || !got.Checked {
		t.Fatalf("应该判断成功: %+v", got)
	}
	if len(got.Conflicts) != 1 || got.Conflicts[0].Priority != "100" {
		t.Fatalf("只该认出 100 这条: %+v", got.Conflicts)
	}
}

// 命令失败时不误报冲突,标记 Checked=false。
func TestProbeRoutingConflictsUnavailable(t *testing.T) {
	run := func(context.Context, string, ...string) (RunResult, error) {
		return RunResult{Code: 1}, nil
	}
	got := probeRoutingConflicts(context.Background(), run)
	if got == nil || got.Checked || len(got.Conflicts) != 0 {
		t.Fatalf("判断不了时不该报冲突: %+v", got)
	}
}

// 优先级解析:非数字不算冲突。
func TestIsSmallPriority(t *testing.T) {
	cases := map[string]bool{"100": true, "32765": false, "32766": false, "": false, "abc": false}
	for in, want := range cases {
		if got := isSmallPriority(in); got != want {
			t.Fatalf("isSmallPriority(%q)=%v, 想要 %v", in, got, want)
		}
	}
}
