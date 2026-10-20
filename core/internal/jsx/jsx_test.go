package jsx

import (
	"math"
	"testing"
)

func TestToNumber(t *testing.T) {
	nan := math.NaN()
	for _, c := range []struct {
		in   any
		want float64
	}{
		{nil, 0}, {Undefined, nan}, {true, 1}, {false, 0}, {5.0, 5}, {"", 0}, {"  7 ", 7}, {"1e2", 100}, {".5", 0.5}, {"5.", 5},
		{"0x10", 16}, {"0b101", 5}, {"0o17", 15}, {"abc", nan}, {"1_0", nan}, {"-0x1", nan}, {"Infinity", math.Inf(1)},
		{[]any{}, 0}, {[]any{"5"}, 5}, {[]any{1.0, 2.0}, nan}, {[]any{nil}, 0}, {map[string]any{}, nan},
	} {
		got := ToNumber(c.in)
		if math.IsNaN(c.want) != math.IsNaN(got) || (!math.IsNaN(got) && got != c.want) {
			t.Errorf("ToNumber(%#v)=%v 要 %v", c.in, got, c.want)
		}
	}
}

func TestRound(t *testing.T) {
	for in, want := range map[float64]float64{2.5: 3, -2.5: -2, 0.49999999999999994: 0, -0.4: 0, 1.4: 1, -1.5: -1} {
		if got := Round(in); got != want && !(got == 0 && want == 0) {
			t.Errorf("Round(%v)=%v 要 %v", in, got, want)
		}
	}
}
