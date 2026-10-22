package idna

import "strings"

// punycodeDecode 是 RFC 3492 的解码(输入不含 xn-- 前缀);非法输入返回 ok=false。
func punycodeDecode(s string) ([]rune, bool) {
	const (
		base, tMin, tMax, skew, damp = 36, 1, 26, 38, 700
		initialBias, initialN        = 72, 128
	)
	var out []rune
	b := strings.LastIndexByte(s, '-')
	if b > 0 {
		for i := 0; i < b; i++ {
			if s[i] >= 0x80 {
				return nil, false
			}
			out = append(out, rune(s[i]))
		}
		s = s[b+1:]
	} else if b == 0 {
		s = s[1:]
	}
	n, i, bias := initialN, 0, initialBias
	for pos := 0; pos < len(s); {
		oldi, w := i, 1
		for k := base; ; k += base {
			if pos >= len(s) {
				return nil, false
			}
			c := s[pos]
			pos++
			var d int
			switch {
			case c >= '0' && c <= '9':
				d = int(c-'0') + 26
			case c >= 'a' && c <= 'z':
				d = int(c - 'a')
			case c >= 'A' && c <= 'Z':
				d = int(c - 'A')
			default:
				return nil, false
			}
			if d > (0x7fffffff-i)/w {
				return nil, false
			}
			i += d * w
			t := k - bias
			if t < tMin {
				t = tMin
			} else if t > tMax {
				t = tMax
			}
			if d < t {
				break
			}
			if w > 0x7fffffff/(base-t) {
				return nil, false
			}
			w *= base - t
		}
		count := len(out) + 1
		delta := i - oldi
		if oldi == 0 {
			delta /= damp
		} else {
			delta /= 2
		}
		delta += delta / count
		k := 0
		for delta > ((base-tMin)*tMax)/2 {
			delta /= base - tMin
			k += base
		}
		bias = k + (base-tMin+1)*delta/(delta+skew)
		n += i / count
		i %= count
		if n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF) {
			return nil, false
		}
		out = append(out, 0)
		copy(out[i+1:], out[i:])
		out[i] = rune(n)
		i++
	}
	return out, true
}

// validACELabel 检查以 xn-- 开头的纯 ASCII 标签:必须是合法 punycode,解出来非空,且至少含一个非 ASCII 字符。
func validACELabel(l string) bool {
	dec, ok := punycodeDecode(l[4:])
	if !ok || len(dec) == 0 {
		return false
	}
	nonASCII := false
	for _, r := range dec {
		// 解出来的字符不能是 UTS46 的禁用字符(最常见的几类:C1 控制字符、替换符、非字符)
		if (r >= 0x80 && r <= 0x9f) || r == 0xFFFD || r == 0xFFFE || r == 0xFFFF {
			return false
		}
		if r > 0x7f {
			nonASCII = true
		}
	}
	return nonASCII
}
