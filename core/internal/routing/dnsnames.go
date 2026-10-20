package routing

import (
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/timeflysoon/Open-Box/core/internal/idna"
)

// 对应旧 Node 的 engine/dns-names.mjs:能安全写进 dnsmasq `server=/域名/` 的域名。
//
// 已知差异:Node 用的 domainToASCII 是完整的 UTS46(字符映射、NFC 规范化、禁用字符检查),
// 这里只做「小写 + 逐标签 punycode」。中文 / 日文 / 西里尔字母 / emoji 这类常见写法结果一致;
// 全角字母、ß、需要规范化的组合字符这类极少见的写法会不同(Node 会映射,这里按原码点编码)。

var domainLabelRe = regexp.MustCompile(`^[a-z0-9-]{1,63}$`)

func domainLabelOK(l string) bool {
	return domainLabelRe.MatchString(strings.ToLower(l)) && !strings.HasPrefix(l, "-") && !strings.HasSuffix(l, "-")
}

func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// dnsmasqSafeDomain 返回规范化后的域名;不可写返回 ok=false。
func dnsmasqSafeDomain(raw string) (string, bool) {
	d := strings.ToLower(jsTrim(raw))
	d = strings.TrimPrefix(d, "*.")
	d = strings.TrimLeft(d, ".")
	d = strings.TrimRight(d, ".")
	if d == "" || jsLen(d) > 253 {
		return "", false
	}
	needASCII := false
	for _, r := range d {
		if r < 0x21 || r > 0x7e {
			needASCII = true
			break
		}
	}
	if needASCII {
		ascii, ok := idna.ToASCII(d)
		if !ok {
			return "", false
		}
		d = ascii
	}
	for _, l := range strings.Split(d, ".") {
		if !domainLabelOK(l) {
			return "", false
		}
	}
	return d, true
}
