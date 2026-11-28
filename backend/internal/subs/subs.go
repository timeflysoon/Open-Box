// Package subs 是订阅的服务层:订阅元数据 + 每个订阅的节点池,存成 JSON 文件(D6)。
//
//	subscriptions.json  {"subscriptions":[Record...]}   前端列表直接读这份(不含节点)
//	sub-nodes.json      {"nodes":{"<id>":[sub.Node...]}} 改名 / 过滤之后进入节点池的节点
//
// 解析在 internal/sub。这里不碰 sing-box,也不重启内核:订阅的动作只改节点池,
// 返回的 changed 告诉前端「重启内核生效」。
package subs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/timeflysoon/Open-Box/backend/internal/store"
	"github.com/timeflysoon/Open-Box/backend/internal/sub"
)

const (
	fileSubs  = "subscriptions"
	fileNodes = "sub-nodes"

	MaxURLs     = 20
	MaxNameLen  = 100
	MaxContent  = 8 << 20
	maxKeywords = 500
)

// 业务错误(调用方按类型映射状态码)。
var (
	ErrNotFound = errors.New("订阅不存在")
	// ErrNoLogin:账号登录来源暂不支持(DESIGN「待维护者确认」)。
	ErrNoLogin = errors.New("暂不支持账号登录来源的订阅")
)

// InputError 是用户输入有问题(400)。
type InputError struct{ Msg string }

func (e *InputError) Error() string { return e.Msg }

func bad(format string, a ...any) error { return &InputError{Msg: fmt.Sprintf(format, a...)} }

// Record 是订阅的元数据,字段与前端 OpenboxSubscription 一致。
type Record struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	URL        string         `json:"url"`
	Enabled    bool           `json:"enabled"`
	AutoUpdate map[string]any `json:"autoUpdate"`
	URLs       []string       `json:"urls,omitempty"`
	// URLEntries 是带「启用 / 停用」的链接列表(对齐上游 v0.1.473 的 urlEntries);url / urls 只留启用的,给旧读法用。
	URLEntries []URLEntry     `json:"urlEntries,omitempty"`
	Content    string         `json:"content,omitempty"`
	Format     string         `json:"format"`
	NodeCount  int            `json:"nodeCount"`
	Rename     map[string]any `json:"renameOptions,omitempty"`
	NodeDNS    map[string]any `json:"nodeDns"`
	CreatedAt  int64          `json:"createdAt"`
	UpdatedAt  int64          `json:"updatedAt"`
	Usage      *sub.Usage     `json:"usage"`
	UserAgent  string         `json:"userAgent,omitempty"`
	Account    map[string]any `json:"account"`
	Skipped    []sub.Skipped  `json:"skipped,omitempty"` // 最近一次解析没能导入的条目(前端不读,留给诊断)
	// BandwidthCheck 是「定期带宽检查」(前端 bandwidthCheck)。只影响自动测速入队,不进 sing-box 配置。
	BandwidthCheck bool `json:"bandwidthCheck,omitempty"`
	// DirectSubscription / DirectNodes 是「订阅链接直连」「节点直连」(对齐上游 v0.1.473):
	// 前者关了,这条订阅的链接主机不进直连;后者关了,它名下节点的服务器地址不进直连。
	// nil(没设置)= 开,所以老记录行为不变;只在明确设成 false 时才写出。
	DirectSubscription *bool `json:"directSubscription,omitempty"`
	DirectNodes        *bool `json:"directNodes,omitempty"`
	// KernelStale 是「本订阅有多少节点还没进已部署的内核配置」(上游 v0.1.499 的
	// 「订阅节点尚未同步到内核」提示用)。不落盘,只在列表接口的响应里现算现给。
	KernelStale int `json:"kernelStale,omitempty"`
}

type subsFile struct {
	Subscriptions []Record `json:"subscriptions"`
}

type nodesFile struct {
	Nodes map[string][]sub.Node `json:"nodes"`
}

// Fetcher 抽象订阅拉取,测试里替换。
type Fetcher func(ctx context.Context, rawURL, userAgent string) (*sub.Fetched, error)

// Service 并发安全:写操作串行(含拉取),读不加服务层锁(store 自己有文件锁)。
type Service struct {
	st    *store.Store
	fetch Fetcher
	now   func() time.Time
	mu    sync.Mutex

	wmu  sync.Mutex    // 护 wake
	wake chan struct{} // 下一次写盘时关闭(见 revision.go)
}

// New 创建服务。fetch 为 nil 时用 sub.Fetch + 默认 HTTP 客户端。
func New(st *store.Store, fetch Fetcher) *Service {
	if fetch == nil {
		client := &http.Client{Timeout: sub.DefaultFetchTimeout}
		fetch = func(ctx context.Context, u, ua string) (*sub.Fetched, error) { return sub.Fetch(ctx, client, u, ua) }
	}
	return &Service{st: st, fetch: fetch, now: time.Now}
}

// Source 是订阅来源:urls 与 content 二选一(content 优先)。
type Source struct {
	URL        string
	URLs       []string
	URLEntries []URLEntry // 传了就以它为准(url / urls 忽略)
	Content    string
	UserAgent  string
	LoginID    string
}

// URLEntry 是一条订阅链接和它的开关;停用的链接保留在列表里,但不拉取。
type URLEntry struct {
	URL     string `json:"url"`
	Enabled bool   `json:"enabled"`
}

type resolved struct {
	urls    []string   // 启用的链接(拉取用)
	entries []URLEntry // 全部链接(含停用)
	content string
	ua      string
}

func normalizeSource(s Source) (*resolved, error) {
	if s.LoginID != "" && s.URL == "" && len(s.URLs) == 0 && s.Content == "" {
		return nil, ErrNoLogin
	}
	r := &resolved{ua: strings.TrimSpace(s.UserAgent)}
	if len(r.ua) > 200 {
		return nil, bad("User-Agent 太长")
	}
	if strings.TrimSpace(s.Content) != "" {
		if len(s.Content) > MaxContent {
			return nil, bad("粘贴的内容过大(上限 %d MiB)", MaxContent>>20)
		}
		r.content = s.Content
		return r, nil
	}
	// 传了 urlEntries 就以它为准;否则 url 是 urls 里的第一条,两个都传时 url 排最前,都按「启用」处理。按字面去重
	list := s.URLEntries
	if len(list) == 0 {
		for _, u := range append([]string{s.URL}, s.URLs...) {
			list = append(list, URLEntry{URL: u, Enabled: true})
		}
	}
	seen := map[string]bool{}
	for _, e := range list {
		u := strings.TrimSpace(e.URL)
		if u == "" || seen[u] {
			continue
		}
		pu, err := url.Parse(u)
		if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Hostname() == "" {
			return nil, bad("订阅地址必须是 http:// 或 https:// 开头的有效地址")
		}
		seen[u] = true
		r.entries = append(r.entries, URLEntry{URL: u, Enabled: e.Enabled})
		if e.Enabled {
			r.urls = append(r.urls, u)
		}
	}
	if len(r.entries) == 0 {
		return nil, bad("请填写订阅地址或粘贴节点内容")
	}
	if len(r.entries) > MaxURLs {
		return nil, bad("订阅地址最多 %d 条", MaxURLs)
	}
	if len(r.urls) == 0 {
		return nil, bad("至少启用一条订阅链接")
	}
	return r, nil
}

// load 拉取 / 解析原始节点(改名之前)。
func (s *Service) load(ctx context.Context, r *resolved) (*sub.Result, *sub.Usage, error) {
	if r.content != "" {
		res, err := sub.Parse([]byte(r.content))
		return res, nil, err
	}
	merged := &sub.Result{Nodes: []sub.Node{}, Skipped: []sub.Skipped{}}
	var usage *sub.Usage
	var formats []string
	for i, u := range r.urls {
		f, err := s.fetch(ctx, u, r.ua)
		if err != nil {
			if len(r.urls) > 1 {
				return nil, nil, fmt.Errorf("第 %d 条订阅地址:%w", i+1, err)
			}
			return nil, nil, err
		}
		res, err := sub.Parse(f.Body)
		if err != nil {
			if len(r.urls) > 1 {
				return nil, nil, fmt.Errorf("第 %d 条订阅地址:%w", i+1, err)
			}
			return nil, nil, err
		}
		if usage == nil {
			usage = f.Usage
		}
		formats = appendUnique(formats, res.Format)
		merged.Nodes = append(merged.Nodes, res.Nodes...)
		merged.Skipped = append(merged.Skipped, res.Skipped...)
	}
	merged.Format = strings.Join(formats, "+")
	if len(merged.Nodes) == 0 {
		return nil, nil, sub.ErrNoNodes
	}
	return merged, usage, nil
}

func appendUnique(a []string, v string) []string {
	for _, e := range a {
		if e == v {
			return a
		}
	}
	return append(a, v)
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- 读 ----

func (s *Service) loadAll() ([]Record, map[string][]sub.Node, error) {
	var sf subsFile
	if _, err := s.st.Load(fileSubs, &sf); err != nil {
		return nil, nil, err
	}
	var nf nodesFile
	if _, err := s.st.Load(fileNodes, &nf); err != nil {
		return nil, nil, err
	}
	if nf.Nodes == nil {
		nf.Nodes = map[string][]sub.Node{}
	}
	return sf.Subscriptions, nf.Nodes, nil
}

// List 返回全部订阅(按用户排序),不含节点。
func (s *Service) List(ctx context.Context) ([]Record, error) {
	recs, _, err := s.loadAll()
	if err != nil {
		return nil, err
	}
	if recs == nil {
		recs = []Record{}
	}
	return recs, nil
}

// NodeNamesBySubscription 返回每条订阅的节点名列表(用于算「有多少节点还没进内核」)。
// 与 PoolNodes 不同:这里不筛启用状态,调用方自己决定要不要用到某条订阅。
func (s *Service) NodeNamesBySubscription(ctx context.Context) (map[string][]string, error) {
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, err
	}
	out := make(map[string][]string, len(recs))
	for _, r := range recs {
		names := make([]string, 0, len(nodes[r.ID]))
		for _, n := range nodes[r.ID] {
			names = append(names, n.Tag)
		}
		out[r.ID] = names
	}
	return out, nil
}

// PoolNodes 按订阅顺序返回已启用订阅的节点池(给配置生成用)。
func (s *Service) PoolNodes(ctx context.Context) ([]sub.Node, error) {
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, err
	}
	out := []sub.Node{}
	for _, r := range recs {
		if r.Enabled {
			out = append(out, nodes[r.ID]...)
		}
	}
	return out, nil
}

// CatalogNode 是节点池里的一个节点和它所属的订阅(给节点组的成员选择器用)。
type CatalogNode struct {
	SubscriptionID   string
	SubscriptionName string
	BandwidthCheck   bool
	Node             sub.Node
}

// Catalog 返回全部订阅(含停用的)和已启用订阅的节点,按订阅顺序。
func (s *Service) Catalog(ctx context.Context) ([]Record, []CatalogNode, error) {
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, nil, err
	}
	if recs == nil {
		recs = []Record{}
	}
	out := []CatalogNode{}
	for _, r := range recs {
		if !r.Enabled {
			continue
		}
		for _, n := range nodes[r.ID] {
			out = append(out, CatalogNode{SubscriptionID: r.ID, SubscriptionName: r.Name, BandwidthCheck: r.BandwidthCheck, Node: n})
		}
	}
	return recs, out, nil
}

func takenTags(recs []Record, nodes map[string][]sub.Node, exceptID string) map[string]bool {
	t := map[string]bool{}
	for _, r := range recs {
		if r.ID == exceptID {
			continue
		}
		for _, n := range nodes[r.ID] {
			t[n.Tag] = true
		}
	}
	return t
}

// ---- 预览 ----

// NodeSummary 对应前端 OpenboxNodeSummary。
type NodeSummary struct {
	Tag         string `json:"tag"`
	OriginalTag string `json:"originalTag"`
	Type        string `json:"type"`
	Server      string `json:"server"`
}

// Preview 对应前端 OpenboxSubscriptionPreview。
type Preview struct {
	Format   string           `json:"format"`
	Nodes    []NodeSummary    `json:"nodes"`
	Skipped  []sub.Skipped    `json:"skipped"`
	Excluded []map[string]any `json:"excluded"`
	Disabled []map[string]any `json:"disabled"`
	Preview  []PreviewEntry   `json:"preview"`
	Groups   []map[string]any `json:"groups"`
	Usage    *sub.Usage       `json:"usage"`
}

func names(list []string) []map[string]any {
	out := []map[string]any{}
	for _, n := range list {
		out = append(out, map[string]any{"name": n})
	}
	return out
}

func summaries(nodes []sub.Node) []NodeSummary {
	out := make([]NodeSummary, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, NodeSummary{Tag: n.Tag, OriginalTag: n.OriginalTag, Type: n.Type, Server: n.Server})
	}
	return out
}

// Preview 不落盘:拉取 → 解析 → 改名过滤,与已有订阅的节点重名也按保存时的规则处理。
func (s *Service) Preview(ctx context.Context, src Source, name string, rename map[string]any) (*Preview, error) {
	r, err := normalizeSource(src)
	if err != nil {
		return nil, err
	}
	res, usage, err := s.load(ctx, r)
	if err != nil {
		return nil, err
	}
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, err
	}
	ap := apply(res.Nodes, parseRenameOpts(rename), name, takenTags(recs, nodes, ""))
	return &Preview{
		Format: res.Format, Nodes: summaries(ap.Nodes), Skipped: nonNilSkipped(res.Skipped),
		Excluded: names(ap.Excluded), Disabled: names(ap.Disabled), Preview: ap.Preview,
		Groups: []map[string]any{}, Usage: usage,
	}, nil
}

// PreviewNodes 做与 Preview 相同的拉取、解析、改名过滤,但返回完整的节点(给测速用,不落盘)。
func (s *Service) PreviewNodes(ctx context.Context, src Source, name string, rename map[string]any) ([]sub.Node, error) {
	r, err := normalizeSource(src)
	if err != nil {
		return nil, err
	}
	res, _, err := s.load(ctx, r)
	if err != nil {
		return nil, err
	}
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, err
	}
	return apply(res.Nodes, parseRenameOpts(rename), name, takenTags(recs, nodes, "")).Nodes, nil
}

func nonNilSkipped(s []sub.Skipped) []sub.Skipped {
	if s == nil {
		return []sub.Skipped{}
	}
	return s
}

// ---- 写 ----

// SaveResult 对应前端 OpenboxSubscriptionSaveResult。
type SaveResult struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	NodeCount int           `json:"nodeCount"`
	Skipped   []sub.Skipped `json:"skipped"`
	Changed   bool          `json:"changed"`
}

// Input 是新增 / 修改的字段;指针和 nil 表示「没传」(PATCH 只改传了的)。
type Input struct {
	Name           *string
	Source         *Source // 传了 url / urls / content 之一才非 nil
	UserAgent      *string
	Rename         map[string]any // nil = 没传
	AutoUpdate     map[string]any
	AutoSet        bool
	NodeDNS        map[string]any
	NodeDNSSet     bool
	Enabled        *bool
	BandwidthCheck *bool // nil = 没传
	// DirectSubscription / DirectNodes:nil = 没传;传 true 存成 nil(默认就是开)
	DirectSubscription *bool
	DirectNodes        *bool
}

func validateName(n string) (string, error) {
	n = strings.TrimSpace(n)
	if n == "" {
		return "", bad("请填写订阅名称")
	}
	if len([]rune(n)) > MaxNameLen {
		return "", bad("订阅名称最多 %d 个字", MaxNameLen)
	}
	return n, nil
}

func validateRename(m map[string]any) error {
	for _, k := range []string{"excludeKeywords", "disabled", "featureKeywords"} {
		if a, ok := m[k].([]any); ok && len(a) > maxKeywords*10 {
			return bad("renameOptions.%s 条目过多", k)
		}
	}
	if a, ok := m["regionDict"].([]any); ok {
		if len(a) > maxKeywords {
			return bad("地区关键词最多 %d 行", maxKeywords)
		}
		for _, e := range a {
			if em, ok := e.(map[string]any); ok {
				if kws, ok := em["keywords"].([]any); ok && len(kws) > maxKeywords*10 {
					return bad("renameOptions.regionDict 条目过多")
				}
			}
		}
	}
	if a, ok := m["excludeKeywords"].([]any); ok && len(a) > maxKeywords {
		return bad("过滤关键词最多 %d 条", maxKeywords)
	}
	return nil
}

func validateAutoUpdate(m map[string]any) error {
	if m == nil {
		return nil
	}
	if _, ok := m["enabled"].(bool); !ok {
		return bad("autoUpdate.enabled 必须是布尔值")
	}
	intIn := func(k string, lo, hi float64, required bool) error {
		v, has := m[k]
		if !has || v == nil {
			if required {
				return bad("autoUpdate.%s 不能为空", k)
			}
			return nil
		}
		f, ok := v.(float64)
		if !ok || f != float64(int64(f)) || f < lo || f > hi {
			return bad("autoUpdate.%s 必须是 %d 到 %d 的整数", k, int(lo), int(hi))
		}
		return nil
	}
	if mode, _ := m["mode"].(string); mode == "hours" {
		return intIn("hours", 1, 720, true)
	}
	if err := intIn("days", 1, 365, true); err != nil {
		return err
	}
	return intIn("hour", 0, 23, true)
}

// ValidateNodeDNS 校验一份订阅的节点 DNS({url, bootstrap}),给别的包(装配 Mihomo 配置)复用同一套规则。
func ValidateNodeDNS(m map[string]any) error { return validateNodeDNS(m) }

func validateNodeDNS(m map[string]any) error {
	if m == nil {
		return nil
	}
	raw, _ := m["url"].(string)
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" {
		return bad("节点 DNS 地址必须是 https:// 开头的 DoH 地址")
	}
	if net.ParseIP(u.Hostname()) == nil {
		bs, _ := m["bootstrap"].(string)
		if net.ParseIP(strings.TrimSpace(bs)) == nil {
			return bad("DoH 地址里是域名时,必须填写用来解析它的 DNS(IP)")
		}
	}
	return nil
}

// Create 新增订阅:拉取并解析成功才保存(拉不下来不留空壳)。
func (s *Service) Create(ctx context.Context, in Input) (*SaveResult, error) {
	if in.Name == nil {
		return nil, bad("请填写订阅名称")
	}
	name, err := validateName(*in.Name)
	if err != nil {
		return nil, err
	}
	if in.Source == nil {
		return nil, bad("请填写订阅地址或粘贴节点内容")
	}
	src := *in.Source
	if in.UserAgent != nil {
		src.UserAgent = *in.UserAgent
	}
	r, err := normalizeSource(src)
	if err != nil {
		return nil, err
	}
	if err := validateRename(in.Rename); err != nil {
		return nil, err
	}
	if err := validateAutoUpdate(in.AutoUpdate); err != nil {
		return nil, err
	}
	if err := validateNodeDNS(in.NodeDNS); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	res, usage, err := s.load(ctx, r)
	if err != nil {
		return nil, err
	}
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, err
	}
	ap := apply(res.Nodes, parseRenameOpts(in.Rename), name, takenTags(recs, nodes, ""))
	if len(ap.Nodes) == 0 {
		return nil, bad("过滤和禁用之后没有剩下可导入的节点")
	}
	ts := s.now().UnixMilli()
	rec := Record{
		ID: newID(), Name: name, Enabled: true, Format: res.Format, NodeCount: len(ap.Nodes),
		Rename: in.Rename, NodeDNS: in.NodeDNS, AutoUpdate: in.AutoUpdate,
		CreatedAt: ts, UpdatedAt: ts, Usage: usage, UserAgent: r.ua, Skipped: res.Skipped,
	}
	if in.Enabled != nil {
		rec.Enabled = *in.Enabled
	}
	if in.BandwidthCheck != nil {
		rec.BandwidthCheck = *in.BandwidthCheck
	}
	rec.DirectSubscription, rec.DirectNodes = directFlag(in.DirectSubscription), directFlag(in.DirectNodes)
	rec.setSource(r)
	nodes[rec.ID] = ap.Nodes
	recs = append(recs, rec)
	if err := s.persist(recs, nodes); err != nil {
		return nil, err
	}
	return &SaveResult{ID: rec.ID, Name: rec.Name, NodeCount: rec.NodeCount, Skipped: nonNilSkipped(res.Skipped), Changed: rec.Enabled}, nil
}

func (rec *Record) setSource(r *resolved) {
	rec.Content = r.content
	rec.URLs = nil
	rec.URL = ""
	rec.URLEntries = nil
	if len(r.urls) > 0 {
		rec.URL = r.urls[0]
		if len(r.urls) > 1 {
			rec.URLs = r.urls
		}
	}
	if len(r.entries) > 0 {
		rec.URLEntries = append([]URLEntry(nil), r.entries...)
	}
}

func (rec *Record) source() *resolved {
	r := &resolved{content: rec.Content, ua: rec.UserAgent}
	switch {
	case len(rec.URLEntries) > 0:
		r.entries = append([]URLEntry(nil), rec.URLEntries...)
		for _, e := range rec.URLEntries {
			if e.Enabled {
				r.urls = append(r.urls, e.URL)
			}
		}
	case len(rec.URLs) > 0:
		r.urls = rec.URLs
	case rec.URL != "":
		r.urls = []string{rec.URL}
	}
	if len(rec.URLEntries) == 0 {
		for _, u := range r.urls {
			r.entries = append(r.entries, URLEntry{URL: u, Enabled: true})
		}
	}
	return r
}

// persist 先写节点再写元数据:中途失败最多留下没人引用的节点,不会出现「有订阅没节点」。
func (s *Service) persist(recs []Record, nodes map[string][]sub.Node) error {
	defer s.notify()
	live := map[string][]sub.Node{}
	for _, r := range recs {
		live[r.ID] = nodes[r.ID]
	}
	if err := s.st.Save(fileNodes, nodesFile{Nodes: live}); err != nil {
		return fmt.Errorf("保存节点失败: %w", err)
	}
	if err := s.st.Save(fileSubs, subsFile{Subscriptions: recs}); err != nil {
		return fmt.Errorf("保存订阅失败: %w", err)
	}
	return nil
}

func indexOf(recs []Record, id string) int {
	for i := range recs {
		if recs[i].ID == id {
			return i
		}
	}
	return -1
}

// Update 修改订阅,只改传了的字段。来源、User-Agent、改名规则变了(或开了名称前缀而名称变了)才重新拉取;
// 单纯改名 / 开关 / 计划不联网,提供商连不上也能改。
func (s *Service) Update(ctx context.Context, id string, in Input) (*SaveResult, error) {
	if err := validateRename(in.Rename); err != nil {
		return nil, err
	}
	if in.AutoSet {
		if err := validateAutoUpdate(in.AutoUpdate); err != nil {
			return nil, err
		}
	}
	if in.NodeDNSSet {
		if err := validateNodeDNS(in.NodeDNS); err != nil {
			return nil, err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, err
	}
	i := indexOf(recs, id)
	if i < 0 {
		return nil, ErrNotFound
	}
	rec := recs[i]
	before := nodes[id]
	wasEnabled := rec.Enabled
	wasDirect := rec.directKey()

	rebuild := false
	nameChanged := false
	if in.Name != nil {
		n, err := validateName(*in.Name)
		if err != nil {
			return nil, err
		}
		nameChanged = n != rec.Name
		rec.Name = n
	}
	if in.Source != nil || in.UserAgent != nil {
		src := Source{URLEntries: rec.source().entries, Content: rec.Content, UserAgent: rec.UserAgent}
		if in.Source != nil {
			src = *in.Source
			src.UserAgent = rec.UserAgent
		}
		if in.UserAgent != nil {
			src.UserAgent = *in.UserAgent
		}
		r, err := normalizeSource(src)
		if err != nil {
			return nil, err
		}
		if !reflect.DeepEqual(r, rec.source()) {
			rebuild = true
		}
		rec.setSource(r)
		rec.UserAgent = r.ua
	}
	if in.Rename != nil {
		rec.Rename = in.Rename
		rebuild = true
	}
	if nameChanged && parseRenameOpts(rec.Rename).usePrefix {
		rebuild = true
	}
	if in.AutoSet {
		rec.AutoUpdate = in.AutoUpdate
	}
	if in.NodeDNSSet {
		rec.NodeDNS = in.NodeDNS
	}
	if in.Enabled != nil {
		rec.Enabled = *in.Enabled
	}
	if in.BandwidthCheck != nil {
		rec.BandwidthCheck = *in.BandwidthCheck
	}
	if in.DirectSubscription != nil {
		rec.DirectSubscription = directFlag(in.DirectSubscription)
	}
	if in.DirectNodes != nil {
		rec.DirectNodes = directFlag(in.DirectNodes)
	}
	after := before
	if rebuild {
		after, err = s.rebuild(ctx, &rec, recs, nodes)
		if err != nil {
			return nil, err
		}
	}
	rec.UpdatedAt = s.now().UnixMilli()
	recs[i] = rec
	nodes[id] = after
	if err := s.persist(recs, nodes); err != nil {
		return nil, err
	}
	// 直连开关、启用的链接主机变了,生成的配置就变了(即使节点没变)
	changed := rec.Enabled != wasEnabled || (rec.Enabled && (!reflect.DeepEqual(before, after) || rec.directKey() != wasDirect))
	return &SaveResult{ID: rec.ID, Name: rec.Name, NodeCount: rec.NodeCount, Skipped: nonNilSkipped(rec.Skipped), Changed: changed}, nil
}

// directFlag 把「开」存成 nil(默认值),只有明确关才存 false。
func directFlag(v *bool) *bool {
	if v == nil || *v {
		return nil
	}
	off := false
	return &off
}

// directKey 把影响「订阅和节点站点直连」的字段拼成一个串,前后比较就知道配置要不要重新生成。
func (rec *Record) directKey() string {
	on := func(v *bool) string {
		if v != nil && !*v {
			return "0"
		}
		return "1"
	}
	return on(rec.DirectSubscription) + on(rec.DirectNodes) + "|" + strings.Join(rec.source().urls, "\n")
}

// rebuild 按记录里保存的来源重新拉取 / 解析 / 改名,更新 rec 的格式、用量、节点数、skipped。
func (s *Service) rebuild(ctx context.Context, rec *Record, recs []Record, nodes map[string][]sub.Node) ([]sub.Node, error) {
	res, usage, err := s.load(ctx, rec.source())
	if err != nil {
		return nil, err
	}
	ap := apply(res.Nodes, parseRenameOpts(rec.Rename), rec.Name, takenTags(recs, nodes, rec.ID))
	if len(ap.Nodes) == 0 {
		return nil, bad("过滤和禁用之后没有剩下可导入的节点")
	}
	rec.Format = res.Format
	rec.NodeCount = len(ap.Nodes)
	rec.Skipped = res.Skipped
	if usage != nil {
		rec.Usage = usage
	}
	return ap.Nodes, nil
}

// Refresh 重新拉取并只替换这个订阅的节点;renameOptions 传了就一并保存。
func (s *Service) Refresh(ctx context.Context, id string, rename map[string]any) (*SaveResult, error) {
	if err := validateRename(rename); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, err
	}
	i := indexOf(recs, id)
	if i < 0 {
		return nil, ErrNotFound
	}
	rec := recs[i]
	if rec.source().content == "" && len(rec.source().urls) == 0 {
		return nil, bad("这个订阅没有可重新拉取的来源")
	}
	if rename != nil {
		rec.Rename = rename
	}
	before := nodes[id]
	after, err := s.rebuild(ctx, &rec, recs, nodes)
	if err != nil {
		return nil, err
	}
	rec.UpdatedAt = s.now().UnixMilli()
	recs[i] = rec
	nodes[id] = after
	if err := s.persist(recs, nodes); err != nil {
		return nil, err
	}
	return &SaveResult{ID: rec.ID, Name: rec.Name, NodeCount: rec.NodeCount, Skipped: nonNilSkipped(rec.Skipped),
		Changed: rec.Enabled && !reflect.DeepEqual(before, after)}, nil
}

// Delete 删除订阅及其节点。
func (s *Service) Delete(ctx context.Context, id string) (changed bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	recs, nodes, err := s.loadAll()
	if err != nil {
		return false, err
	}
	i := indexOf(recs, id)
	if i < 0 {
		return false, ErrNotFound
	}
	changed = recs[i].Enabled && len(nodes[id]) > 0
	recs = append(recs[:i:i], recs[i+1:]...)
	defer s.notify()
	// 先写元数据再写节点:中途失败留下的是没人引用的节点
	if err := s.st.Save(fileSubs, subsFile{Subscriptions: recs}); err != nil {
		return false, fmt.Errorf("保存订阅失败: %w", err)
	}
	delete(nodes, id)
	if err := s.st.Save(fileNodes, nodesFile{Nodes: nodes}); err != nil {
		return false, fmt.Errorf("保存节点失败: %w", err)
	}
	return changed, nil
}

// Reorder 按 ids 重排;ids 必须正好是现有全部订阅 id 的一个排列。
func (s *Service) Reorder(ctx context.Context, ids []string) ([]Record, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, false, err
	}
	if len(ids) != len(recs) {
		return nil, false, bad("排序列表必须包含全部订阅")
	}
	byID := map[string]Record{}
	for _, r := range recs {
		byID[r.ID] = r
	}
	out := make([]Record, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		r, ok := byID[id]
		if !ok || seen[id] {
			return nil, false, bad("排序列表里有未知或重复的订阅")
		}
		seen[id] = true
		out = append(out, r)
	}
	changed := false
	for i := range out {
		if out[i].ID != recs[i].ID {
			changed = true
			break
		}
	}
	if !changed {
		return recs, false, nil
	}
	if err := s.persist(out, nodes); err != nil {
		return nil, false, err
	}
	return out, true, nil
}

// NodesForShare 按订阅 id 列表收集**启用**订阅的节点,并合并 usage(给 /sub/<token> 用)。
func (s *Service) NodesForShare(ctx context.Context, ids []string) ([]sub.Node, *sub.Usage, error) {
	recs, nodes, err := s.loadAll()
	if err != nil {
		return nil, nil, err
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	out := []sub.Node{}
	var usage *sub.Usage
	for _, r := range recs {
		if !want[r.ID] || !r.Enabled {
			continue
		}
		out = append(out, nodes[r.ID]...)
		if r.Usage != nil {
			usage = mergeUsage(usage, r.Usage)
		}
	}
	return out, usage, nil
}

func mergeUsage(a, b *sub.Usage) *sub.Usage {
	if a == nil {
		if b == nil {
			return nil
		}
		c := *b
		return &c
	}
	if b == nil {
		return a
	}
	c := *a
	add := func(dst **int64, src *int64) {
		if src == nil {
			return
		}
		if *dst == nil {
			v := *src
			*dst = &v
			return
		}
		**dst += *src
	}
	add(&c.Upload, b.Upload)
	add(&c.Download, b.Download)
	add(&c.Total, b.Total)
	if b.Expire != nil && (c.Expire == nil || *b.Expire < *c.Expire) {
		v := *b.Expire
		c.Expire = &v
	}
	return &c
}
