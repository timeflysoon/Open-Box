// Package idna 提供「小写 + 逐标签 punycode」的域名转 ASCII。
//
// 已知差异:Node 的 domainToASCII 是完整的 UTS46(字符映射、NFC 规范化、禁用字符检查),
// 这里只做逐标签 punycode。中文 / 日文 / 西里尔字母 / emoji 这类常见写法结果一致;
// 全角字母、ß、需要规范化的组合字符这类极少见的写法会不同。
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
			continue
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
