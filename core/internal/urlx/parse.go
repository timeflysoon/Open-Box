package urlx

import (
	"fmt"
	"strconv"
	"strings"
)

// URL 是 new URL(x) 里 node-dns 这类调用方要读的几个字段(都是 WHATWG 序列化后的写法)。
// 只对「协议 + //」形式的 http / https / ws / wss / ftp 和非特殊协议有意义;
// file 和没有 // 的非特殊协议(路径不透明)只填 Scheme 和 Hostname。
type URL struct {
	Scheme   string
	Username string
	Password string
	Hostname string
	Port     string // 缺省端口(https 的 443 之类)和没写端口都是空串
	Pathname string
	Search   string // 空查询("?")也是空串
	Hash     string // 空片段("#")也是空串
}

var defaultPorts = map[string]int{"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21}

// Parse 相当于 new URL(input) 读出各字段;ok=false 表示 new URL 会抛错。
func Parse(input string) (URL, bool) {
	host, ok := Hostname(input)
	if !ok {
		return URL{}, false
	}
	scheme, special, rest, opaque, _ := prep(input)
	u := URL{Scheme: scheme, Hostname: host}
	if opaque || scheme == "file" {
		return u, true
	}
	end := len(rest)
	for j, r := range rest {
		if r == '/' || r == '?' || r == '#' || (special && r == '\\') {
			end = j
			break
		}
	}
	authority, tail := rest[:end], rest[end:]
	if k := strings.LastIndex(authority, "@"); k >= 0 {
		user, pass, _ := strings.Cut(authority[:k], ":")
		u.Username, u.Password = pctEncode(user, userinfoSet), pctEncode(pass, userinfoSet)
		authority = authority[k+1:]
	}
	inBracket := false
	for j := 0; j < len(authority); j++ {
		switch authority[j] {
		case '[':
			inBracket = true
		case ']':
			inBracket = false
		case ':':
			if !inBracket {
				if digits := strings.TrimLeft(authority[j+1:], "0"); digits != "" {
					n, _ := strconv.Atoi(digits)
					if d, has := defaultPorts[scheme]; !has || d != n {
						u.Port = strconv.Itoa(n)
					}
				} else if authority[j+1:] != "" {
					// 全是 0:端口 0
					if d, has := defaultPorts[scheme]; !has || d != 0 {
						u.Port = "0"
					}
				}
				j = len(authority)
			}
		}
	}
	// 片段、查询、路径
	if i := strings.IndexByte(tail, '#'); i >= 0 {
		if frag := tail[i+1:]; frag != "" {
			u.Hash = "#" + pctEncode(frag, fragmentSet)
		}
		tail = tail[:i]
	}
	if i := strings.IndexByte(tail, '?'); i >= 0 {
		if q := tail[i+1:]; q != "" {
			set := querySet
			if special {
				set = specialQuerySet
			}
			u.Search = "?" + pctEncode(q, set)
		}
		tail = tail[:i]
	}
	u.Pathname = serializePath(tail, special)
	return u, true
}

func serializePath(p string, special bool) string {
	if p == "" {
		if special {
			return "/"
		}
		return ""
	}
	if special {
		p = strings.ReplaceAll(p, `\`, "/")
	}
	segs := strings.Split(p[1:], "/") // p 以 / 开头(特殊协议的反斜杠已换成 /)
	var out []string
	for i, seg := range segs {
		last := i == len(segs)-1
		switch lowerDots(seg) {
		case "..":
			popped := len(out) > 0
			if popped {
				out = out[:len(out)-1]
			}
			// 特殊协议末尾的 .. 总补一个空段;非特殊协议只有真弹出过才补(Node 实测:foo://h/.. 的路径是空)
			if last && (special || popped) {
				out = append(out, "")
			}
		case ".":
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, pctEncode(seg, pathSet))
		}
	}
	if len(out) == 0 {
		return "" // 段列表为空序列化成空串(只会出现在非特殊协议)
	}
	return "/" + strings.Join(out, "/")
}

// lowerDots 把 "." / "%2e" 的各种写法归成 "." 或 ".."(其余原样返回)。
func lowerDots(seg string) string {
	l := strings.ToLower(seg)
	switch l {
	case ".", "%2e":
		return "."
	case "..", ".%2e", "%2e.", "%2e%2e":
		return ".."
	}
	return seg
}

type encodeSet func(b byte) bool

func inSet(chars string) encodeSet {
	return func(b byte) bool { return strings.IndexByte(chars, b) >= 0 }
}

var (
	fragmentSet     = inSet(" \"<>`")
	querySet        = inSet(" \"#<>")
	specialQuerySet = inSet(" \"#<>'")
	pathSet         = inSet(" \"#<>?`{}")
	userinfoSet     = inSet(" \"#<>?`{}/:;=@[\\]^|")
)

func pctEncode(s string, set encodeSet) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x20 || c > 0x7e || set(c) {
			fmt.Fprintf(&b, "%%%02X", c)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}
