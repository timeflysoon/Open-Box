package groups

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
)

// 对应旧 Node 的 engine/user-groups.mjs 里「分组归一化」的部分。

const (
	DefaultInterval    = "300s"
	DefaultTolerance   = 100.0
	DefaultIdleTimeout = "12h"
	DefaultTestURL     = "http://www.gstatic.com/generate_204"
	FailoverPrefix     = "__fo:"
	FailoverRejectTag  = FailoverPrefix + "reject"
	iconScaleLimit     = 20
	failoverMaxLanes   = 3
	builtinDirectID    = "builtin-direct"
	builtinBlockID     = "builtin-block"
)

var (
	groupTypes = []string{"urltest", "selector", "failover"}
	groupModes = []string{"static", "dynamic"}

	failoverIntervalMs = [2]float64{5000, 24 * 3600000}
	iconPrefixRe       = regexp.MustCompile(`(?i)^(globe|brand|misc):`)
	countryCodeRe      = regexp.MustCompile(`^[A-Za-z]{2}$`)
)

func inList(s string, list []string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Lane 是故障转移的一个页签。
type Lane struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Icon    string   `json:"icon"`
	Members []string `json:"members"`
	// 多节点页签在页签内怎么挑节点:true = 手动选择(内部 selector);不写 / false = 自动优选(内部 urltest)
	Manual bool `json:"manual,omitempty"`
}

// FailoverSettings 是故障转移的检测参数。
type FailoverSettings struct {
	TimeoutMs        int64 `json:"timeoutMs"`
	FailureThreshold int64 `json:"failureThreshold"`
	RestorePrimary   bool  `json:"restorePrimary"`
	RecoveryHoldMs   int64 `json:"recoveryHoldMs"`
}

// Group 是归一化后的节点组。JSON 输出的键顺序和旧实现一致(见 MarshalJSON)。
type Group struct {
	ID        string
	Name      string
	Type      string
	Mode      string
	Enabled   bool
	Icon      string
	IconScale int
	Keywords  []string
	Members   []string
	Kind      string // direct / block / 空

	// 只有对应类型才有的字段;extras 记录它们来自哪种类型(内置出站会改写 Type,但这些字段原样保留)
	extras  string // "" / urltest / failover
	TestURL string
	// 可接受状态码(内核 tcp19):空 = 用档案里的全局设置
	ExpectedStatus string
	Interval       string
	Tolerance      float64
	IdleTimeout    string
	Lanes          []Lane
	Failover       *FailoverSettings

	// 内置出站的默认值是一份固定对象:没有 iconScale,键顺序也不同
	pristineBuiltin bool
}

func (g *Group) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	first := true
	put := func(k string, v any) {
		if !first {
			b.WriteByte(',')
		}
		first = false
		kb, _ := json.Marshal(k)
		b.Write(kb)
		b.WriteByte(':')
		var vb bytes.Buffer
		enc := json.NewEncoder(&vb)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(v)
		b.Write(bytes.TrimRight(vb.Bytes(), "\n"))
	}
	if g.pristineBuiltin {
		put("id", g.ID)
		put("kind", g.Kind)
		put("name", g.Name)
		put("type", g.Type)
		put("mode", g.Mode)
		put("icon", g.Icon)
		put("keywords", g.Keywords)
		put("members", g.Members)
		put("enabled", g.Enabled)
		b.WriteByte('}')
		return b.Bytes(), nil
	}
	put("id", g.ID)
	put("name", g.Name)
	put("type", g.Type)
	put("mode", g.Mode)
	put("enabled", g.Enabled)
	put("icon", g.Icon)
	put("iconScale", g.IconScale)
	put("keywords", g.Keywords)
	put("members", g.Members)
	switch g.extras {
	case "urltest":
		put("testUrl", g.TestURL)
		put("expectedStatus", g.ExpectedStatus)
		put("interval", g.Interval)
		put("tolerance", g.Tolerance)
		put("idleTimeout", g.IdleTimeout)
	case "failover":
		put("lanes", g.Lanes)
		put("testUrl", g.TestURL)
		put("expectedStatus", g.ExpectedStatus)
		put("interval", g.Interval)
		put("tolerance", g.Tolerance)
		put("failover", g.Failover)
	}
	if g.Kind != "" {
		put("kind", g.Kind)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func builtinDefault(kind string) *Group {
	g := &Group{Kind: kind, Type: "selector", Mode: "static", Keywords: []string{}, Members: []string{}, Enabled: true, pristineBuiltin: true}
	if kind == "direct" {
		g.ID, g.Name, g.Icon = builtinDirectID, "直连", "misc:dart"
	} else {
		g.ID, g.Name, g.Icon = builtinBlockID, "拒绝", "misc:cross"
	}
	return g
}

func normalizeIcon(raw any) string {
	v, ok := jsx.NonEmpty(raw)
	if !ok {
		return ""
	}
	if iconPrefixRe.MatchString(v) {
		return lower(v)
	}
	if countryCodeRe.MatchString(v) {
		return upper(v)
	}
	return v
}

func normalizeIconScale(v any) int {
	n := jsx.ToNumber(v)
	if !jsx.IsFinite(n) {
		return 0
	}
	r := jsx.Round(n)
	return int(math.Max(-iconScaleLimit, math.Min(iconScaleLimit, r)))
}

// inRange:数字落在 [lo, hi] 内取整,否则回落。
func inRange(v any, lo, hi float64, fallback int64) int64 {
	n := jsx.ToNumber(v)
	if jsx.IsFinite(n) && n >= lo && n <= hi {
		return int64(math.Floor(n))
	}
	return fallback
}

func strList(v any) []string {
	out := []string{}
	if a, ok := v.([]any); ok {
		for _, e := range a {
			if s, ok := jsx.NonEmpty(e); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func normalizeLanes(raw any) []Lane {
	arr, _ := raw.([]any)
	if len(arr) > failoverMaxLanes {
		arr = arr[:failoverMaxLanes]
	}
	seen := map[string]bool{}
	out := make([]Lane, 0, len(arr))
	for i, lane := range arr {
		id, ok := jsx.NonEmpty(jsx.Get(lane, "id"))
		if !ok {
			id = idx("lane-%d", i+1)
		}
		for seen[id] {
			id += "~"
		}
		seen[id] = true
		members := []string{}
		if ms, ok := jsx.Get(lane, "members").([]any); ok {
			for _, m := range ms {
				if s, ok := jsx.NonEmpty(m); ok && !inList(s, members) {
					members = append(members, s)
				}
			}
		}
		name, _ := jsx.NonEmpty(jsx.Get(lane, "name"))
		icon, _ := jsx.NonEmpty(jsx.Get(lane, "icon"))
		out = append(out, Lane{ID: id, Name: name, Icon: icon, Members: members, Manual: jsx.Get(lane, "manual") == true})
	}
	return out
}

func normalizeGroup(raw any, index int) *Group {
	g := &Group{}
	if t, ok := jsx.Get(raw, "type").(string); ok && inList(t, groupTypes) {
		g.Type = t
	} else {
		g.Type = "selector"
	}
	switch {
	case g.Type == "failover":
		g.Mode = "static"
	case func() bool { m, ok := jsx.Get(raw, "mode").(string); return ok && inList(m, groupModes) }():
		g.Mode = jsx.Get(raw, "mode").(string)
	case jsx.Get(raw, "allNodes") == true:
		g.Mode = "dynamic"
	default:
		g.Mode = "static"
	}
	var ok bool
	if g.ID, ok = jsx.NonEmpty(jsx.Get(raw, "id")); !ok {
		g.ID = idx("group-%d", index)
	}
	if g.Name, ok = jsx.NonEmpty(jsx.Get(raw, "name")); !ok {
		g.Name = idx("分组-%d", index+1)
	}
	en, isBool := jsx.Get(raw, "enabled").(bool)
	g.Enabled = !(isBool && !en)
	g.Icon = normalizeIcon(jsx.Get(raw, "icon"))
	g.IconScale = normalizeIconScale(jsx.Get(raw, "iconScale"))
	g.Keywords = strList(jsx.Get(raw, "keywords"))
	g.Members = strList(jsx.Get(raw, "members"))

	switch g.Type {
	case "urltest":
		g.extras = "urltest"
		g.TestURL, _ = jsx.NonEmpty(jsx.Get(raw, "testUrl"))
		g.ExpectedStatus, _ = NormalizeExpectedStatus(jsx.Get(raw, "expectedStatus"))
		if g.Interval, ok = jsx.NonEmpty(jsx.Get(raw, "interval")); !ok {
			g.Interval = DefaultInterval
		}
		tol := jsx.ToNumber(jsx.Get(raw, "tolerance"))
		if jsx.IsFinite(tol) && tol >= 0 {
			g.Tolerance = math.Floor(tol)
			if g.Tolerance == 0 {
				g.Tolerance = 0 // 去掉负零
			}
		} else {
			g.Tolerance = DefaultTolerance
		}
		if g.IdleTimeout, ok = jsx.NonEmpty(jsx.Get(raw, "idleTimeout")); !ok {
			g.IdleTimeout = DefaultIdleTimeout
		}
	case "failover":
		g.extras = "failover"
		g.Keywords, g.Members = []string{}, []string{}
		g.Lanes = normalizeLanes(jsx.Get(raw, "lanes"))
		g.TestURL, _ = jsx.NonEmpty(jsx.Get(raw, "testUrl"))
		g.ExpectedStatus, _ = NormalizeExpectedStatus(jsx.Get(raw, "expectedStatus"))
		interval, _ := jsx.NonEmpty(jsx.Get(raw, "interval"))
		ms := parseDuration(interval)
		if ms >= failoverIntervalMs[0] && ms <= failoverIntervalMs[1] {
			g.Interval = interval
		} else {
			g.Interval = DefaultInterval
		}
		g.Tolerance = float64(inRange(jsx.Get(raw, "tolerance"), 0, 60000, 100))
		fo := jsx.Get(raw, "failover")
		rp, rpIsBool := jsx.Get(fo, "restorePrimary").(bool)
		g.Failover = &FailoverSettings{
			TimeoutMs:        inRange(jsx.Get(fo, "timeoutMs"), 1000, 60000, 5000),
			FailureThreshold: inRange(jsx.Get(fo, "failureThreshold"), 1, 20, 2),
			RestorePrimary:   !(rpIsBool && !rp),
			RecoveryHoldMs:   inRange(jsx.Get(fo, "recoveryHoldMs"), 0, 24*3600000, 60000),
		}
	}
	return g
}

// withKind:kind 只由固定 id 决定。内置出站固定是 selector / static / 无关键词 / 无成员,图标空了补默认。
func withKind(g *Group) *Group {
	kind := ""
	switch g.ID {
	case builtinDirectID:
		kind = "direct"
	case builtinBlockID:
		kind = "block"
	}
	if kind == "" {
		return g
	}
	if g.Icon == "" {
		g.Icon = builtinDefault(kind).Icon
	}
	g.Kind, g.Type, g.Mode = kind, "selector", "static"
	g.Keywords, g.Members = []string{}, []string{}
	return g
}

// NormalizeGroups:两个内置出站永远在列表里:没有就补上(直连放最前、拒绝放最后),有就照用户排的位置。
func NormalizeGroups(list any) []*Group {
	arr, _ := list.([]any)
	normalized := make([]*Group, len(arr))
	for i, g := range arr {
		normalized[i] = withKind(normalizeGroup(g, i))
	}
	has := func(id string) bool {
		for _, g := range normalized {
			if g.ID == id {
				return true
			}
		}
		return false
	}
	out := make([]*Group, 0, len(normalized)+2)
	if !has(builtinDirectID) {
		out = append(out, builtinDefault("direct"))
	}
	out = append(out, normalized...)
	if !has(builtinBlockID) {
		out = append(out, builtinDefault("block"))
	}
	return out
}

// Builtin 是两个内置出站现在叫什么、有没有被停用。
type Builtin struct {
	Direct        string `json:"direct"`
	Block         string `json:"block"`
	DirectEnabled bool   `json:"directEnabled"`
	BlockEnabled  bool   `json:"blockEnabled"`
}

func builtinTags(groups []*Group) Builtin {
	var d, b *Group
	for _, g := range groups {
		if g.Kind == "direct" && d == nil {
			d = g
		}
		if g.Kind == "block" && b == nil {
			b = g
		}
	}
	return Builtin{d.Name, b.Name, d.Enabled, b.Enabled}
}
