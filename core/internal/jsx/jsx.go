// Package jsx 复刻旧 Node 实现里用到的那一小部分 JS 动态语义:
// 入参来自 JSON 解码(any),判断方式要和 JS 逐条一致。
//
// 值的对应:null=nil,undefined=Undefined(缺失的键),布尔=bool,数字=float64,
// 字符串=string,数组=[]any,对象=map[string]any。
package jsx

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

type undefinedT struct{}

// Undefined 表示 JS 的 undefined(对象里缺失的键)。和 nil(JSON 的 null)是两回事:
// Number(null) 是 0,Number(undefined) 是 NaN。
var Undefined any = undefinedT{}

func IsUndefined(v any) bool { _, ok := v.(undefinedT); return ok }

// Get 相当于 raw?.key:raw 不是对象或键不存在时得到 Undefined。
func Get(raw any, key string) any {
	if m, ok := raw.(map[string]any); ok {
		if v, has := m[key]; has {
			return v
		}
	}
	return Undefined
}

// IsSpace 与 ECMAScript 的 WhiteSpace + LineTerminator 一致(trim 和正则 \s 用的同一批)。
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func Trim(s string) string { return strings.TrimFunc(s, IsSpace) }

// NonEmpty 相当于 isNonEmptyString:是字符串且 trim 后非空,返回 trim 后的值。
func NonEmpty(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	t := Trim(s)
	return t, t != ""
}

// Truthy 相当于 JS 的真值判断。
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil, undefinedT:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// Round 相当于 Math.round(向 +∞ 取整,.5 往上):和 math.Round(远离 0)在负数 .5 上不同。
func Round(n float64) float64 {
	f := math.Floor(n)
	if n-f >= 0.5 {
		return f + 1
	}
	return f
}

// ToString 只覆盖 ToNumber 需要的那部分(数组会被拼成字符串再转数字)。
func ToString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case undefinedT:
		return "undefined"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return NumberToString(x)
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e == nil || IsUndefined(e) {
				continue
			}
			parts[i] = ToString(e)
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

var (
	decimalRe = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)
	radixRe   = regexp.MustCompile(`^0([xXoObB])([0-9a-fA-F]+)$`)
)

// ToNumber 相当于 Number(v)。
func ToNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case undefinedT:
		return math.NaN()
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return stringToNumber(x)
	case []any:
		return stringToNumber(ToString(x))
	}
	return math.NaN()
}

func stringToNumber(s string) float64 {
	t := Trim(s)
	if t == "" {
		return 0
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if m := radixRe.FindStringSubmatch(t); m != nil {
		base := map[string]int{"x": 16, "o": 8, "b": 2}[strings.ToLower(m[1])]
		n, err := strconv.ParseUint(m[2], base, 64)
		if err != nil {
			// 超出 64 位的整数:用浮点累加(精度和 JS 一样会丢)
			f := 0.0
			for _, c := range m[2] {
				d, e := strconv.ParseUint(string(c), base, 8)
				if e != nil {
					return math.NaN()
				}
				f = f*float64(base) + float64(d)
			}
			return f
		}
		return float64(n)
	}
	if !decimalRe.MatchString(t) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

// IsFinite 相当于 Number.isFinite(已经是数字的值)。
func IsFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// NumberToString 相当于 String(number):整数不带指数(String(100000000) 是 "100000000"),
// 指数只在绝对值 >= 1e21 或 < 1e-6 时出现,写法是 "1e+21" / "1e-7"(指数不补零)。
func NumberToString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	if abs := math.Abs(f); abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		i := strings.IndexByte(s, 'e')
		mant, exp := s[:i], s[i+1:]
		digits := strings.TrimLeft(exp[1:], "0")
		if digits == "" {
			digits = "0"
		}
		return mant + "e" + exp[:1] + digits
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// Nullish 相当于 v == null(null 或 undefined),用于 ?? 运算符。
func Nullish(v any) bool { return v == nil || IsUndefined(v) }
