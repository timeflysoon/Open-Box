// Package idna 提供「小写 + 逐标签 punycode」的域名转 ASCII。
//
// 已知差异:Node 的 domainToASCII 是完整的 UTS46,这里只做逐标签 punycode,并补了 xn-- 标签的校验
// (必须是合法 punycode、解出非空、不含最常见的几类禁用字符;解出来只有 ASCII 的如 xn--a- Node 照收;
// 含非 ASCII 字符的 xn-- 标签直接拒绝)。
// 没有的:需要字符映射表的写法(NFKC 兼容分解如 ﬁ → fi、² → 2,大小写折叠如 ǅ,忽略字符如软连字符 / 零宽字符,
// 全角句号以外的标点)和双向规则(同一标签里混希伯来 / 阿拉伯字母和拉丁字母要拒绝)。
// 中文 / 日文 / 西里尔字母 / emoji / 带音标的拉丁字母 / 全角字母这类常见写法与 Node 一致。
// 要补齐只能引入 Unicode 映射表(golang.org/x/net/idna + x/text 的 norm、bidi,约 4 MB 表数据),目前没做。
package idna

import (
	"strings"
	"unicode/utf8"
)

// ToASCII 逐标签做 punycode。含空白 / 控制字符的标签原样保留(后面的标签检查会把它挡掉)。
func ToASCII(d string) (string, bool) {
	labels := strings.Split(d, ".")
	for i, l := range labels {
		ascii := true
		for _, r := range l {
			if r > 0x7e {
				ascii = false
				break
			}
		}
		if ascii {
			if len(l) >= 4 && strings.EqualFold(l[:4], "xn--") && !validACELabel(l) {
				return "", false // UTS46:xn-- 标签必须能解码,且解出的字符里没有禁用字符
			}
			continue
		}
		if len(l) >= 4 && strings.EqualFold(l[:4], "xn--") {
			return "", false // UTS46:xn-- 开头的标签必须是纯 ASCII 的合法 punycode
		}
		enc, ok := punycodeEncode(l)
		if !ok {
			return "", false
		}
		labels[i] = "xn--" + enc
	}
	return strings.Join(labels, "."), true
}

// punycodeEncode 是 RFC 3492 的编码(不含 xn-- 前缀)。
func punycodeEncode(s string) (string, bool) {
	const (
		base, tMin, tMax, skew, damp = 36, 1, 26, 38, 700
		initialBias, initialN        = 72, 128
	)
	if !utf8.ValidString(s) {
		return "", false
	}
	runes := []rune(s)
	var out []byte
	for _, r := range runes {
		if r < 0x80 {
			out = append(out, byte(r))
		}
	}
	b := len(out)
	h := b
	if b > 0 {
		out = append(out, '-')
	}
	digit := func(d int) byte {
		if d < 26 {
			return byte('a' + d)
		}
		return byte('0' + d - 26)
	}
	adapt := func(delta, numPoints int, first bool) int {
		if first {
			delta /= damp
		} else {
			delta /= 2
		}
		delta += delta / numPoints
		k := 0
		for delta > ((base-tMin)*tMax)/2 {
			delta /= base - tMin
			k += base
		}
		return k + (base-tMin+1)*delta/(delta+skew)
	}
	n, delta, bias := initialN, 0, initialBias
	for h < len(runes) {
		m := int(^uint32(0) >> 1)
		for _, r := range runes {
			if int(r) >= n && int(r) < m {
				m = int(r)
			}
		}
		if m-n > (int(^uint32(0)>>1)-delta)/(h+1) {
			return "", false
		}
		delta += (m - n) * (h + 1)
		n = m
		for _, r := range runes {
			c := int(r)
			if c < n {
				delta++
			}
			if c == n {
				q := delta
				for k := base; ; k += base {
					t := k - bias
					if t < tMin {
						t = tMin
					} else if t > tMax {
						t = tMax
					}
					if q < t {
						break
					}
					out = append(out, digit(t+(q-t)%(base-t)))
					q = (q - t) / (base - t)
				}
				out = append(out, digit(q))
				bias = adapt(delta, h+1, h == b)
				delta = 0
				h++
			}
		}
		delta++
		n++
	}
	return string(out), true
}
