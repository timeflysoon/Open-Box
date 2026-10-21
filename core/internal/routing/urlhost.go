package routing

import (
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/timeflysoon/Open-Box/core/internal/idna"
	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// 复刻旧 dns.mjs 的 extractHost:带协议头的写法取 new URL(x).hostname,其余原样返回。
// Go 的 net/url 和 WHATWG URL 在主机部分差别很大,所以这里按 WHATWG 的主机解析规则自己实现。
// 已知差异:域名转 ASCII 沿用 internal/idna(没有完整 UTS46,见那里的说明)。

var schemeHeadRe = regexp.MustCompile(`(?i)^[a-z]+://`)

func extractHost(v any) any {
	s := jsx.ToString(v)
	if !schemeHeadRe.MatchString(s) {
		return v
	}
	if h, ok := urlHostname(s); ok {
		return h
	}
	return v // new URL 抛错 → catch 后原样返回
}

func isSpecialScheme(s string) bool {
	switch s {
	case "http", "https", "ws", "wss", "ftp", "file":
		return true
	}
	return false
}

// urlHostname 相当于 new URL(input).hostname(input 已经以「字母+://」开头);ok=false 表示 new URL 会抛错。
func urlHostname(input string) (string, bool) {
	// 去掉首尾的 C0 控制字符和空格,并删掉所有制表 / 换行
	input = strings.TrimFunc(input, func(r rune) bool { return r <= 0x20 })
	input = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, input)
	i := strings.Index(input, "://")
	if i < 0 {
		return "", false
	}
	scheme := strings.ToLower(input[:i])
	special := isSpecialScheme(scheme)
	rest := input[i+3:]
	if special && scheme != "file" {
		rest = strings.TrimLeft(rest, `/\`)
	}
	end := len(rest)
	for j, r := range rest {
		if r == '/' || r == '?' || r == '#' || (special && r == '\\') {
			end = j
			break
		}
	}
	authority := rest[:end]
	if scheme == "file" {
		// file: 没有用户名 / 端口:整段都是主机,里面的 @ 和 : 都是禁用字符
		if authority == "" {
			return "", true
		}
		h, ok := parseURLHost(authority, true)
		if h == "localhost" {
			h = ""
		}
		return h, ok
	}
	atSeen := false
	if k := strings.LastIndex(authority, "@"); k >= 0 {
		atSeen = true
		authority = authority[k+1:]
	}
	// 在方括号外找第一个冒号:前面是主机,后面是端口
	host, port, hasPort := authority, "", false
	inBracket := false
	for j := 0; j < len(authority); j++ {
		switch authority[j] {
		case '[':
			inBracket = true
		case ']':
			inBracket = false
		case ':':
			if !inBracket {
				host, port, hasPort = authority[:j], authority[j+1:], true
				j = len(authority)
			}
		}
	}
	if hasPort && host == "" {
		return "", false
	}
	if host == "" && (atSeen || (special && scheme != "file")) {
		return "", false
	}
	if hasPort && port != "" {
		for _, r := range port {
			if r < '0' || r > '9' {
				return "", false
			}
		}
		digits := strings.TrimLeft(port, "0")
		if len(digits) > 5 {
			return "", false
		}
		if digits != "" {
			if n, _ := strconv.Atoi(digits); n > 65535 {
				return "", false
			}
		}
	}
	if host == "" {
		return "", true
	}
	h, ok := parseURLHost(host, special)
	if !ok {
		return "", false
	}
	return h, true
}

func parseURLHost(host string, special bool) (string, bool) {
	if strings.HasPrefix(host, "[") {
		if !strings.HasSuffix(host, "]") {
			return "", false
		}
		return parseIPv6Host(host[1 : len(host)-1])
	}
	if !special {
		return parseOpaqueHost(host)
	}
	domain, ok := percentDecode(host)
	if !ok {
		return "", false
	}
	for _, r := range domain {
		// UTS46 里的禁用字符(最常见的几类):C1 控制字符、替换符、非字符
		if (r >= 0x80 && r <= 0x9f) || r == 0xFFFD || r == 0xFFFE || r == 0xFFFF {
			return "", false
		}
	}
	ascii, ok := idna.ToASCII(strings.ToLower(strings.ReplaceAll(uts46Lite(domain), "\u0130", "i\u0307")))
	if !ok || ascii == "" {
		return "", false
	}
	for _, r := range ascii {
		if r <= 0x20 || r == 0x7f || r == '%' || strings.ContainsRune("#/:<>?@[\\]^|", r) {
			return "", false
		}
	}
	if endsInNumber(ascii) {
		return parseIPv4Host(ascii)
	}
	return ascii, true
}

func percentDecode(s string) (string, bool) {
	var b []byte
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			n, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			b = append(b, byte(n))
			i += 2
			continue
		}
		b = append(b, s[i])
	}
	return strings.ToValidUTF8(string(b), "\uFFFD"), true
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func parseOpaqueHost(host string) (string, bool) {
	for _, r := range host {
		if r == 0 || r == '\t' || r == '\n' || r == '\r' || r == ' ' || strings.ContainsRune("#/:<>?@[\\]^|", r) {
			return "", false
		}
	}
	var b strings.Builder
	for _, r := range host {
		if r < 0x20 || r > 0x7e {
			var buf [4]byte
			n := utf8.EncodeRune(buf[:], r)
			for _, c := range buf[:n] {
				fmt.Fprintf(&b, "%%%02X", c)
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String(), true
}

func parseIPv6Host(inner string) (string, bool) {
	if strings.Contains(inner, "%") {
		return "", false
	}
	a, err := netip.ParseAddr(inner)
	if err != nil || a.Is4() {
		return "", false
	}
	b := a.As16()
	var pieces [8]uint16
	for i := range pieces {
		pieces[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
	}
	// 压缩最长的连续零段(长度 ≥ 2,并列取靠前的)
	bestStart, bestLen := -1, 0
	for i := 0; i < 8; {
		if pieces[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && pieces[j] == 0 {
			j++
		}
		if j-i > bestLen && j-i >= 2 {
			bestStart, bestLen = i, j-i
		}
		i = j
	}
	var sb strings.Builder
	sb.WriteByte('[')
	for i := 0; i < 8; i++ {
		if i == bestStart {
			if i == 0 {
				sb.WriteString("::")
			} else {
				sb.WriteString(":")
			}
			i += bestLen - 1
			continue
		}
		sb.WriteString(strconv.FormatUint(uint64(pieces[i]), 16))
		if i != 7 {
			sb.WriteByte(':')
		}
	}
	sb.WriteByte(']')
	return sb.String(), true
}

func parseIPv4Number(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	base := 10
	if len(s) >= 2 && (s[:2] == "0x" || s[:2] == "0X") {
		s, base = s[2:], 16
	} else if len(s) >= 2 && s[0] == '0' {
		s, base = s[1:], 8
	}
	if s == "" {
		return 0, true
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := false
		switch base {
		case 10:
			ok = c >= '0' && c <= '9'
		case 8:
			ok = c >= '0' && c <= '7'
		default:
			ok = isHex(c)
		}
		if !ok {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(s, base, 64)
	if err != nil {
		return 1 << 62, true // 溢出:一定大于任何合法上限
	}
	return n, true
}

func endsInNumber(domain string) bool {
	parts := strings.Split(domain, ".")
	if parts[len(parts)-1] == "" {
		if len(parts) == 1 {
			return false
		}
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	if last != "" {
		allDigits := true
		for i := 0; i < len(last); i++ {
			if last[i] < '0' || last[i] > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			return true
		}
	}
	_, ok := parseIPv4Number(last)
	return ok
}

func parseIPv4Host(domain string) (string, bool) {
	parts := strings.Split(domain, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", false
	}
	nums := make([]uint64, len(parts))
	for i, p := range parts {
		n, ok := parseIPv4Number(p)
		if !ok {
			return "", false
		}
		nums[i] = n
	}
	for _, n := range nums[:len(nums)-1] {
		if n > 255 {
			return "", false
		}
	}
	limit := uint64(1) << (8 * uint(5-len(nums)))
	last := nums[len(nums)-1]
	if last >= limit {
		return "", false
	}
	ipv4 := last
	for i, n := range nums[:len(nums)-1] {
		ipv4 += n << (8 * uint(3-i))
	}
	return fmt.Sprintf("%d.%d.%d.%d", ipv4>>24&255, ipv4>>16&255, ipv4>>8&255, ipv4&255), true
}

// uts46Lite 补 UTS46 映射里最常见的几条(完整的 NFKC 仍是已知差异):
// 全角 ASCII → 半角,全角 / 表意 / 半角句号 → '.',不换行空格 → 空格(随后被禁用字符检查挡掉)。
func uts46Lite(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			return r - 0xFEE0
		case r == 0x3002 || r == 0xFF61:
			return '.'
		case r == 0x00A0:
			return ' '
		}
		return r
	}, s)
}
