// Package ipx 是 IP / CIDR 相关的小工具:
//   - IsIPv4 / IsIPv6 / IsIP:逐字移植 Node 内置 net.isIPv4 / isIPv6 / isIP 的正则
//   - ParseCidr / CidrsOverlap / SubtractCidrs:对应旧 Node 的 system/local-subnets.mjs
package ipx

import (
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

const (
	v4Seg = `(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])`
	v4Str = `(?:` + v4Seg + `\.){3}` + v4Seg
	v6Seg = `(?:[0-9a-fA-F]{1,4})`
)

var (
	ipv4Re = regexp.MustCompile(`^` + v4Str + `$`)
	// 与 Node lib/internal/net.js 的 IPv6Reg 一致(字符类里的 - 挪到末尾,含义相同)
	ipv6Re = regexp.MustCompile(`^(?:` +
		`(?:` + v6Seg + `:){7}(?:` + v6Seg + `|:)|` +
		`(?:` + v6Seg + `:){6}(?:` + v4Str + `|:` + v6Seg + `|:)|` +
		`(?:` + v6Seg + `:){5}(?::` + v4Str + `|(?::` + v6Seg + `){1,2}|:)|` +
		`(?:` + v6Seg + `:){4}(?:(?::` + v6Seg + `){0,1}:` + v4Str + `|(?::` + v6Seg + `){1,3}|:)|` +
		`(?:` + v6Seg + `:){3}(?:(?::` + v6Seg + `){0,2}:` + v4Str + `|(?::` + v6Seg + `){1,4}|:)|` +
		`(?:` + v6Seg + `:){2}(?:(?::` + v6Seg + `){0,3}:` + v4Str + `|(?::` + v6Seg + `){1,5}|:)|` +
		`(?:` + v6Seg + `:){1}(?:(?::` + v6Seg + `){0,4}:` + v4Str + `|(?::` + v6Seg + `){1,6}|:)|` +
		`(?::(?:(?::` + v6Seg + `){0,5}:` + v4Str + `|(?::` + v6Seg + `){1,7}|:))` +
		`)(?:%[0-9a-zA-Z.:-]{1,})?$`)
)

func IsIPv4(s string) bool { return ipv4Re.MatchString(s) }
func IsIPv6(s string) bool { return ipv6Re.MatchString(s) }

// IsIP 相当于 net.isIP:4 / 6 / 0。
func IsIP(s string) int {
	if IsIPv4(s) {
		return 4
	}
	if IsIPv6(s) {
		return 6
	}
	return 0
}

// ---------------------------------------------------------------------------
// CIDR 运算(对应 local-subnets.mjs)
// ---------------------------------------------------------------------------

const (
	v4Bits = 32
	v6Bits = 128
)

var (
	parseV4Re = regexp.MustCompile(`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$`)
	v6CharsRe = regexp.MustCompile(`^[0-9a-fA-F:.]+$`)
	v4TailRe  = regexp.MustCompile(`(\d+\.\d+\.\d+\.\d+)$`)
	hex16Re   = regexp.MustCompile(`^[0-9a-fA-F]{1,4}$`)
	cidrRe    = regexp.MustCompile(`^([^/]+)(?:/(\d{1,3}))?$`)
	one       = big.NewInt(1)
	zero      = big.NewInt(0)
	ffff      = big.NewInt(0xffff)
)

func parseV4(s string) (*big.Int, bool) {
	m := parseV4Re.FindStringSubmatch(s)
	if m == nil {
		return nil, false
	}
	n := new(big.Int)
	for i := 1; i <= 4; i++ {
		o, _ := strconv.Atoi(m[i])
		if o > 255 {
			return nil, false
		}
		n.Lsh(n, 8)
		n.Or(n, big.NewInt(int64(o)))
	}
	return n, true
}

func parseV6(s string) (*big.Int, bool) {
	if !v6CharsRe.MatchString(s) || !strings.Contains(s, ":") {
		return nil, false
	}
	text := s
	// 末尾可能是 IPv4 写法(::ffff:1.2.3.4),先换成两组 hex
	if m := v4TailRe.FindStringSubmatch(text); m != nil {
		n, ok := parseV4(m[1])
		if !ok {
			return nil, false
		}
		hi := new(big.Int).And(new(big.Int).Rsh(n, 16), ffff)
		lo := new(big.Int).And(n, ffff)
		text = text[:len(text)-len(m[1])] + hi.Text(16) + ":" + lo.Text(16)
	}
	halves := strings.Split(text, "::")
	if len(halves) > 2 {
		return nil, false
	}
	var head, tail []string
	if halves[0] != "" {
		head = strings.Split(halves[0], ":")
	}
	if len(halves) == 2 && halves[1] != "" {
		tail = strings.Split(halves[1], ":")
	}
	if len(halves) == 1 && len(head) != 8 {
		return nil, false
	}
	missing := 8 - len(head) - len(tail)
	if missing < 0 || (len(halves) == 2 && missing < 1) {
		return nil, false
	}
	groups := append([]string{}, head...)
	if len(halves) == 2 {
		for i := 0; i < missing; i++ {
			groups = append(groups, "0")
		}
	}
	groups = append(groups, tail...)
	if len(groups) != 8 {
		return nil, false
	}
	n := new(big.Int)
	for _, g := range groups {
		if !hex16Re.MatchString(g) {
			return nil, false
		}
		v, _ := strconv.ParseInt(g, 16, 32)
		n.Lsh(n, 16)
		n.Or(n, big.NewInt(v))
	}
	return n, true
}

func formatV4(n *big.Int) string {
	parts := make([]string, 4)
	for i, shift := range []uint{24, 16, 8, 0} {
		parts[i] = new(big.Int).And(new(big.Int).Rsh(n, shift), big.NewInt(0xff)).String()
	}
	return strings.Join(parts, ".")
}

func formatV6(n *big.Int) string {
	groups := make([]string, 8)
	for i := 0; i < 8; i++ {
		shift := uint((7 - i) * 16)
		groups[i] = new(big.Int).And(new(big.Int).Rsh(n, shift), ffff).Text(16)
	}
	// 压缩最长的一段连续 0
	bestStart, bestLen := -1, 0
	for i := 0; i < 8; i++ {
		if groups[i] != "0" {
			continue
		}
		j := i
		for j < 8 && groups[j] == "0" {
			j++
		}
		if j-i > bestLen {
			bestStart, bestLen = i, j-i
		}
		i = j
	}
	if bestLen < 2 {
		return strings.Join(groups, ":")
	}
	return strings.Join(groups[:bestStart], ":") + "::" + strings.Join(groups[bestStart+bestLen:], ":")
}

// Cidr 是解析后的网段:net 已按掩码取整。
type Cidr struct {
	Family int
	Net    *big.Int
	Prefix int
}

// ParseCidr 解析 'a.b.c.d/n' / 'x::y/n'(没写前缀按单个地址);不合法返回 ok=false。
// 入参相当于 String(cidr || ”),所以任意 JSON 值都可以传。
func ParseCidr(v any) (Cidr, bool) {
	text := ""
	if jsx.Truthy(v) {
		text = jsx.ToString(v)
	}
	m := cidrRe.FindStringSubmatch(jsx.Trim(text))
	if m == nil {
		return Cidr{}, false
	}
	family := 0
	var addr *big.Int
	if a, ok := parseV4(m[1]); ok {
		family, addr = 4, a
	} else if a, ok := parseV6(m[1]); ok {
		family, addr = 6, a
	}
	if family == 0 {
		return Cidr{}, false
	}
	bits := v4Bits
	if family == 6 {
		bits = v6Bits
	}
	prefix := bits
	if m[2] != "" {
		prefix, _ = strconv.Atoi(m[2])
	}
	if prefix < 0 || prefix > bits {
		return Cidr{}, false
	}
	mask := new(big.Int)
	if prefix != 0 {
		full := new(big.Int).Sub(new(big.Int).Lsh(one, uint(bits)), one)
		low := new(big.Int).Sub(new(big.Int).Lsh(one, uint(bits-prefix)), one)
		mask.Xor(full, low)
	}
	return Cidr{family, new(big.Int).And(addr, mask), prefix}, true
}

func (c Cidr) String() string {
	if c.Family == 4 {
		return fmt.Sprintf("%s/%d", formatV4(c.Net), c.Prefix)
	}
	return fmt.Sprintf("%s/%d", formatV6(c.Net), c.Prefix)
}

func (c Cidr) bits() int {
	if c.Family == 4 {
		return v4Bits
	}
	return v6Bits
}

func (c Cidr) size() *big.Int { return new(big.Int).Lsh(one, uint(c.bits()-c.Prefix)) }

func (c Cidr) end() *big.Int {
	e := new(big.Int).Add(c.Net, c.size())
	return e.Sub(e, one)
}

func overlaps(a, b Cidr) bool {
	return a.Family == b.Family && a.Net.Cmp(b.end()) <= 0 && b.Net.Cmp(a.end()) <= 0
}

func covers(outer, inner Cidr) bool {
	return outer.Family == inner.Family && outer.Net.Cmp(inner.Net) <= 0 && inner.end().Cmp(outer.end()) <= 0
}

// CidrsOverlap:两个网段有没有交集(任一方向包含、或部分重叠都算)。
func CidrsOverlap(a, b any) bool {
	x, ok1 := ParseCidr(a)
	y, ok2 := ParseCidr(b)
	return ok1 && ok2 && overlaps(x, y)
}

// CidrContains:cidr 是否完全包含 ip(ip 也可以是网段)。
func CidrContains(cidr, ip any) bool {
	c, ok1 := ParseCidr(cidr)
	p, ok2 := ParseCidr(ip)
	return ok1 && ok2 && covers(c, p)
}

// SubtractCidrs:bases 里挖掉 holes,结果仍是一组 CIDR(按需二分,直到与所有洞都不相交)。
func SubtractCidrs(bases, holes []any) []string {
	hs := []Cidr{}
	for _, h := range holes {
		if c, ok := ParseCidr(h); ok {
			hs = append(hs, c)
		}
	}
	out := []Cidr{}
	var walk func(c Cidr)
	walk = func(c Cidr) {
		hit := false
		for _, h := range hs {
			if overlaps(c, h) {
				hit = true
				break
			}
		}
		if !hit {
			out = append(out, c)
			return
		}
		for _, h := range hs {
			if overlaps(c, h) && covers(h, c) {
				return
			}
		}
		if c.Prefix >= c.bits() {
			return
		}
		half := new(big.Int).Rsh(c.size(), 1)
		walk(Cidr{c.Family, c.Net, c.Prefix + 1})
		walk(Cidr{c.Family, new(big.Int).Add(c.Net, half), c.Prefix + 1})
	}
	for _, b := range bases {
		if c, ok := ParseCidr(b); ok {
			walk(c)
		}
	}
	res := make([]string, len(out))
	for i, c := range out {
		res[i] = c.String()
	}
	return res
}

var _ = zero
