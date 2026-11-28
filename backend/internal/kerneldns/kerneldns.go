// Package kerneldns 把内核日志流里一次 DNS 查询的过程整理成 terminal-test 的 kernelDns:命中哪条 DNS 规则、
// 交给哪个解析器、经哪个节点发出、上游回了什么。是从内核日志里截下来的实录,不是推算。
// 自己的设计,依据前端 OpenboxTerminalKernelDns 的字段注释,日志的写法取自 sing-box 的源码
// (dns/router.go、dns/client_log.go)和对真实内核 1.14.4 的实测(见测试里的样例行,都是真实内核打出来的;规则序号 1.13 与 1.14 写法不同,现按 1.14);没有参照上游。
//
// 依赖内核版本:日志里的规则序号、各句话的写法都是 sing-box 自己的。认不出的写法一律返回 seen=false 并说明,不猜;
// 换内核大版本后要重新对一遍(kerneldns_real_test.go 用真实内核核对,有可执行文件时跑)。
package kerneldns

import (
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"

	"github.com/timeflysoon/Open-Box/backend/internal/dnsrewrite"
	"github.com/timeflysoon/Open-Box/backend/internal/singbox"
)

// Server 是配置里的一台 DNS 服务器(字段对应前端 kernelDns.server)。
type Server struct {
	Tag    string
	Type   string
	Server string
	Port   int // 0 = 配置没写
	Detour string
}

// Config 是判断要用的配置部分。
type Config struct {
	Servers   map[string]Server
	Final     string            // dns.final;没写时是第一台服务器
	RuleCount int               // dns.rules 的条数,用来核对日志里的规则序号
	Outbounds map[string]string // 出站 tag → 类型,用来判断 detour 是不是直连
	// Proxies 是内核此刻的代理列表(可选,由调用方从内核的 /proxies 取)。给了就把 chain 补全成
	// 「detour → 站点集 → 节点组 → 节点」,没给就只给 detour(与以前一样)。
	Proxies []singbox.KernelProxy
	// MihomoConfigured 是按已部署 mihomo 配置推算出的 DNS 走向(内核是 mihomo、日志截不出追踪记录时用)。
	// nil = 没有推算结果。
	MihomoConfigured map[string]any
	// ProbeFakeIP 是本次探测是否拿到了 FakeIP 占位地址;nil = 没判断。
	ProbeFakeIP *bool
}

// maxChain 是跟着「当前选中」往下走的最大层数,防止内核里出现环。
const maxChain = 8

// Chain 把 chain 补全:从 detour 出发沿内核此刻的「当前选中」一路走到末尾。
// Detour 为空时返回空;没有代理列表(读不到内核)时只回 detour,不猜。
func (c *Config) Chain(detour string) []string {
	if detour == "" {
		return []string{}
	}
	chain := []string{detour}
	if c == nil || len(c.Proxies) == 0 {
		return chain
	}
	now := make(map[string]string, len(c.Proxies))
	for _, p := range c.Proxies {
		now[p.Name] = p.Now
	}
	cur := detour
	for i := 0; i < maxChain; i++ {
		next, ok := now[cur]
		if !ok || next == "" {
			break
		}
		chain = append(chain, next)
		cur = next
	}
	return chain
}

// ConfigFrom 从完整的 sing-box 配置(已解码成 map)里取出 DNS 部分。
func ConfigFrom(cfg map[string]any) *Config {
	c := &Config{Servers: map[string]Server{}, Outbounds: map[string]string{}}
	dns, _ := cfg["dns"].(map[string]any)
	rules, _ := dns["rules"].([]any)
	c.RuleCount = len(rules)
	c.Final, _ = dns["final"].(string)
	servers, _ := dns["servers"].([]any)
	for _, e := range servers {
		m, _ := e.(map[string]any)
		tag, _ := m["tag"].(string)
		if tag == "" {
			continue
		}
		s := Server{Tag: tag}
		s.Type, _ = m["type"].(string)
		s.Server, _ = m["server"].(string)
		s.Detour, _ = m["detour"].(string)
		switch p := m["server_port"].(type) {
		case float64:
			s.Port = int(p)
		case int:
			s.Port = p
		}
		c.Servers[tag] = s
		if c.Final == "" {
			c.Final = tag
		}
	}
	outs, _ := cfg["outbounds"].([]any)
	for _, e := range outs {
		m, _ := e.(map[string]any)
		tag, _ := m["tag"].(string)
		typ, _ := m["type"].(string)
		if tag != "" {
			c.Outbounds[tag] = typ
		}
	}
	return c
}

// Query 是一次查询(一个 A 或一个 AAAA)的整理结果。
type Query struct {
	Source   string // 查询是从哪个来源地址进内核的(内核 DNS 入站看到的)
	Matched  bool   // 有没有命中 DNS 规则(没有 = 走兜底解析器)
	RuleIdx  int    // 0 起的规则序号,Matched 时才有意义
	RuleText string // 命中规则的条件原文(内核日志里的写法,例如 domain_suffix=a.test)
	Action   string // 动作原文,例如 route(dns_direct) / reject / predefined(NXDOMAIN)
	Server   *Server
	Result   string // exchanged / cached / failed / rejected / action / pending
	Rcode    string
	TTL      *int
	Answers  []string
	MS       *int
	Error    string
	Outbound string // 日志里实际拨号的出站(节点)tag
	OutType  string // 它的类型
}

// Result 是 Analyze 的结果。
type Result struct {
	Seen   bool
	Reason string // Seen=false:no-log / not-seen
	Err    string // Seen=false 且 Reason=no-log 时的说明
	Q      *Query
	V6     *Query // 同一个域名还有 AAAA 查询时
	cfg    *Config
}

var (
	lineRe     = regexp.MustCompile(`^\[(\d+) ([^\]]*)\] (.*)$`)
	exchangeRe = regexp.MustCompile(`^exchange (\S+) IN (A|AAAA)$`)
	matchRe    = regexp.MustCompile(`^match\[(\d+)\] (?:(.*) )?=> (.*)$`)
	resultRe   = regexp.MustCompile(`^(exchanged|cached) (\S+) ([A-Z0-9_]+) (\d+)$`)
	answerRe   = regexp.MustCompile(`^(?:exchanged|cached) (?:A|AAAA) \S+ \d+ IN (?:A|AAAA) (\S+)$`)
	failedRe   = regexp.MustCompile(`^exchange failed for (\S+) IN (?:A|AAAA): (.*)$`)
	rejectedRe = regexp.MustCompile(`^response rejected for `)
	fromRe     = regexp.MustCompile(`^inbound (?:packet )?connection from (\S+)$`)
	dialRe     = regexp.MustCompile(`^outbound (?:packet )?connection to `)
	outTagRe   = regexp.MustCompile(`^outbound/([^\[]+)\[(.*)\]$`)
	routeRe    = regexp.MustCompile(`^route\(([^,)]*)`)
)

type line struct {
	level string
	id    string
	dur   string
	tag   string
	msg   string
}

func parse(e singbox.LogEntry) (line, bool) {
	m := lineRe.FindStringSubmatch(e.Payload)
	if m == nil {
		return line{}, false
	}
	l := line{level: e.Level, id: m[1], dur: m[2]}
	rest := m[3]
	if i := strings.Index(rest, ": "); i >= 0 {
		l.tag, l.msg = rest[:i], rest[i+2:]
	} else {
		l.msg = rest
	}
	return l, true
}

// durMS 把内核的耗时写法(12ms / 1.50s / 2m3s)换成毫秒;认不出返回 nil。
func durMS(s string) *int {
	switch {
	case strings.HasSuffix(s, "ms"):
		if n, err := strconv.Atoi(strings.TrimSuffix(s, "ms")); err == nil {
			return &n
		}
	case strings.HasSuffix(s, "s") && !strings.Contains(s, "m"):
		if f, err := strconv.ParseFloat(strings.TrimSuffix(s, "s"), 64); err == nil {
			n := int(f*1000 + 0.5)
			return &n
		}
	}
	return nil
}

func normDomain(s string) string { return strings.ToLower(strings.TrimSuffix(s, ".")) }

// Analyze 在 entries(订阅期间收到的日志行)里找域名 domain 的 A 查询(没有 A 就找 AAAA),整理出它的过程。
// 同一个域名在订阅期间被问了几次(重试、别的终端)时取最后一次。cfg 为 nil 时不补服务器信息。
func Analyze(entries []singbox.LogEntry, domain string, cfg *Config) Result {
	domain = normDomain(domain)
	order := []string{}
	byID := map[string][]line{}
	lastA, lastAAAA := "", ""
	for _, e := range entries {
		l, ok := parse(e)
		if !ok {
			continue
		}
		if _, seen := byID[l.id]; !seen {
			order = append(order, l.id)
		}
		byID[l.id] = append(byID[l.id], l)
		if l.tag == "dns" {
			if m := exchangeRe.FindStringSubmatch(l.msg); m != nil && normDomain(m[1]) == domain {
				if m[2] == "A" {
					lastA = l.id
				} else {
					lastAAAA = l.id
				}
			}
		}
	}
	r := Result{cfg: cfg}
	primary, v6 := lastA, lastAAAA
	if primary == "" {
		primary, v6 = lastAAAA, ""
	}
	if primary == "" {
		r.Reason = "not-seen"
		return r
	}
	q, err := summarize(byID[primary], cfg)
	if err != "" {
		r.Reason, r.Err = "no-log", err
		return r
	}
	r.Seen, r.Q = true, q
	if v6 != "" {
		if q6, err := summarize(byID[v6], cfg); err == "" {
			r.V6 = q6
		}
	}
	return r
}

func summarize(lines []line, cfg *Config) (*Query, string) {
	q := &Query{}
	var resultDur, lastDur string
	var matchN = -1
	var matchSeen bool
	for _, l := range lines {
		lastDur = l.dur
		switch {
		case strings.HasPrefix(l.tag, "inbound/"):
			if m := fromRe.FindStringSubmatch(l.msg); m != nil && q.Source == "" {
				q.Source = m[1]
			}
		case strings.HasPrefix(l.tag, "outbound/"):
			if dialRe.MatchString(l.msg) {
				if m := outTagRe.FindStringSubmatch(l.tag); m != nil {
					q.OutType, q.Outbound = m[1], m[2]
				}
			}
		case l.tag == "dns":
			if m := matchRe.FindStringSubmatch(l.msg); m != nil {
				n, _ := strconv.Atoi(m[1])
				matchN, matchSeen = n, true
				q.RuleText, q.Action = m[2], m[3]
			} else if m := resultRe.FindStringSubmatch(l.msg); m != nil {
				q.Result, q.Rcode = m[1], m[3]
				t, _ := strconv.Atoi(m[4])
				q.TTL = &t
				resultDur = l.dur
			} else if m := answerRe.FindStringSubmatch(l.msg); m != nil {
				q.Answers = append(q.Answers, m[1])
			} else if m := failedRe.FindStringSubmatch(l.msg); m != nil {
				q.Result, q.Error = "failed", m[2]
				resultDur = l.dur
			} else if rejectedRe.MatchString(l.msg) {
				q.Result = "rejected"
				resultDur = l.dur
			}
		}
	}
	if matchSeen {
		// 内核 1.14 的 DNS 日志里 match[N] 的 N 就是 dns.rules 里 0 起的下标(1.13 是 2*i+1,已不再支持:
		// 项目固定用 1.14.x,两种写法的奇数序号无法分辨,混着认会把一条规则说成另一条);
		// 超出规则条数就不猜,说明白,免得把一条规则说成另一条
		if matchN < 0 || (cfg != nil && cfg.RuleCount > 0 && matchN >= cfg.RuleCount) {
			return nil, fmt.Sprintf("日志里的规则序号 %d 认不出(内核日志的写法和预期的不一样,可能换了内核版本)", matchN)
		}
		q.Matched, q.RuleIdx = true, matchN
	}
	if q.Result == "" {
		if strings.HasPrefix(q.Action, "reject") || strings.HasPrefix(q.Action, "predefined") {
			q.Result = "action"
			if strings.HasPrefix(q.Action, "predefined(") {
				q.Rcode = strings.SplitN(strings.TrimSuffix(strings.TrimPrefix(q.Action, "predefined("), ")"), ",", 2)[0]
			}
		} else {
			q.Result = "pending"
		}
	}
	if d := durMS(resultDur); d != nil {
		q.MS = d
	} else if q.Result != "pending" && q.Result != "action" {
		q.MS = durMS(lastDur)
	}
	// 解析器:命中 route(<tag>) 的那台;没命中任何规则用兜底
	tag := ""
	if m := routeRe.FindStringSubmatch(q.Action); m != nil {
		tag = m[1]
	} else if !q.Matched && cfg != nil {
		tag = cfg.Final
	}
	if tag != "" && cfg != nil {
		if s, ok := cfg.Servers[tag]; ok {
			q.Server = &s
		}
	}
	return q, ""
}

// fakeRange 是内核 FakeIP 默认用的占位地址段。
var fakeRange = netip.MustParsePrefix("198.18.0.0/15")

// Map 是 terminal-test 响应里 kernelDns 的样子(前端 OpenboxTerminalKernelDns)。
func (r Result) Map() map[string]any {
	if !r.Seen {
		m := map[string]any{"seen": false, "reason": r.Reason}
		if r.Err != "" {
			m["error"] = r.Err
		}
		return m
	}
	q := r.Q
	var server any
	if q.Server != nil {
		var port any
		if q.Server.Port != 0 {
			port = q.Server.Port
		}
		server = map[string]any{"tag": q.Server.Tag, "type": q.Server.Type, "server": q.Server.Server, "port": port, "detour": q.Server.Detour}
	}
	fakeLocal := q.Server != nil && q.Server.Type == "fakeip"
	fake := fakeLocal
	for _, a := range q.Answers {
		if ip, err := netip.ParseAddr(a); err == nil && fakeRange.Contains(ip) {
			fake = true
		}
	}
	via := false
	switch {
	case q.Outbound != "": // 日志里真的拨了出站:以它为准
		via = q.OutType != "direct"
	case q.Server != nil && q.Server.Detour != "" && r.cfg != nil:
		via = r.cfg.Outbounds[q.Server.Detour] != "direct"
	}
	var chain []string
	if via && q.Server != nil {
		chain = r.cfg.Chain(q.Server.Detour) // 有内核代理列表时补全成实际线路,没有就只给 detour
	}
	var ruleIdx any
	if q.Matched {
		ruleIdx = q.RuleIdx
	}
	m := map[string]any{
		"seen": true, "source": q.Source, "ruleIndex": ruleIdx, "ruleText": q.RuleText, "action": q.Action,
		"server": server, "viaProxy": via, "rewrite": q.Server != nil && q.Server.Tag == dnsrewrite.Tag,
		"outbound": q.Outbound, "chain": chain, "result": q.Result, "rcode": q.Rcode, "ttl": intOrNil(q.TTL),
		"answers": nonNil(q.Answers), "ms": intOrNil(q.MS), "error": q.Error, "fakeIp": fake, "fakeIpLocal": fakeLocal,
	}
	if r.V6 != nil {
		m["v6"] = map[string]any{"result": r.V6.Result, "rcode": r.V6.Rcode, "answers": nonNil(r.V6.Answers), "ms": intOrNil(r.V6.MS), "error": r.V6.Error}
	}
	return m
}

func intOrNil(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
