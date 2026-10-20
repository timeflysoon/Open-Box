package groups

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// 对应旧 Node 的 rename.mjs 里 normalizeForMatch / keywordMatches,以及 duration.mjs 的 parseDuration。

func isRegionalIndicator(r rune) bool { return r >= 0x1F1E6 && r <= 0x1F1FF }

// normalizeForMatch:国旗 emoji(两个区域指示符)还原成两个 ASCII 字母,两侧补空格保住 token 边界,再转小写。
// 已知差异:JS 的 toLowerCase 有「词尾 Σ→ς」「İ→i̇」这类特殊规则,这里用 Go 的简单映射;
// 只影响含这些字符的节点名,不影响常见的中英文 / 国旗写法。
func normalizeForMatch(text string) string {
	runes := []rune(text)
	var b strings.Builder
	for i := 0; i < len(runes); i++ {
		if isRegionalIndicator(runes[i]) && i+1 < len(runes) && isRegionalIndicator(runes[i+1]) {
			b.WriteByte(' ')
			b.WriteRune(runes[i] - 0x1F1E6 + 'a')
			b.WriteRune(runes[i+1] - 0x1F1E6 + 'a')
			b.WriteByte(' ')
			i++
			continue
		}
		b.WriteRune(runes[i])
	}
	return strings.ToLower(b.String())
}

func isAZ(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

func isShortASCIICode(s string) bool {
	if len(s) < 2 || len(s) > 3 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isAZ(s[i]) {
			return false
		}
	}
	return true
}

// keywordMatches:纯 ASCII 的 2~3 位短码(us / hk / jp)要求前后不是字母(可以紧跟数字:HK01);
// cn 是例外地不匹配 cn2 这种「CN2 线路」(后面是 2 且 2 后面不是数字)。其余关键词按子串匹配。
func keywordMatches(lower, kw string) bool {
	needle := jsx.Trim(normalizeForMatch(kw))
	if needle == "" {
		return false
	}
	if !isShortASCIICode(needle) {
		return strings.Contains(lower, needle)
	}
	n := len(needle)
	for i := 0; i+n <= len(lower); i++ {
		if !strings.EqualFold(lower[i:i+n], needle) {
			continue
		}
		if i > 0 && isAZ(lower[i-1]) {
			continue
		}
		j := i + n
		if needle == "cn" && j < len(lower) && lower[j] == '2' && !(j+1 < len(lower) && lower[j+1] >= '0' && lower[j+1] <= '9') {
			continue
		}
		if j < len(lower) && isAZ(lower[j]) {
			continue
		}
		return true
	}
	return false
}

var (
	allDigitsRe = regexp.MustCompile(`^\d+$`)
	durationRe  = regexp.MustCompile(`(\d+(?:\.\d+)?)(ms|h|m|s)`)
)

// parseDuration:sing-box 的时长写法 5m / 1h30m / 90s / 250ms,纯数字当秒,解析不出来返回 0。单位是毫秒。
func parseDuration(raw string) float64 {
	text := jsx.Trim(raw)
	if text == "" {
		return 0
	}
	if allDigitsRe.MatchString(text) {
		n, _ := strconv.ParseFloat(text, 64)
		return n * 1000
	}
	total := 0.0
	matched := false
	for _, m := range durationRe.FindAllStringSubmatch(text, -1) {
		matched = true
		n, _ := strconv.ParseFloat(m[1], 64)
		switch m[2] {
		case "h":
			total += n * 3600000
		case "m":
			total += n * 60000
		case "s":
			total += n * 1000
		default:
			total += n
		}
	}
	if !matched {
		return 0
	}
	return total
}
