// Package subscriptions 实现 /api/openbox/subscriptions*(订阅 CRUD、排序、刷新、预览、节点分享;login 暂不支持)。
package subscriptions

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/timeflysoon/Open-Box/backend/internal/httpx"
	"github.com/timeflysoon/Open-Box/backend/internal/sub"
	"github.com/timeflysoon/Open-Box/backend/internal/subs"
)

const maxBody = 16 << 20 // 粘贴的节点内容可能较大

// PendingFunc 判断「配置改了、内核还没用上」。内核没在运行、或判断不了时返回 (false, nil)——
// 与服务状态的 pendingRestart 同一个口径(main.go 用同一个 *singbox.Applied 接进来)。
type PendingFunc func(ctx context.Context) (pending bool, reasons []string)

// DeployedNodesFunc 给出「已部署进内核的节点名集合」,用来算 kernelStale。
type DeployedNodesFunc func(ctx context.Context) (map[string]struct{}, error)

// Deps 是本分组的依赖。
type Deps struct {
	Subs    *subs.Service
	Pending PendingFunc // 为空 = 保存 / 刷新的返回里不带 applied
	// DeployedNodes 返回已部署配置里的节点名集合;为空时列表接口不算 kernelStale。
	DeployedNodes DeployedNodesFunc
	// UpdatesWait 是 updates 长轮询最长挂多久,0 = 20 秒(面板那边 25 秒没回就掐掉重来)。
	UpdatesWait time.Duration
}

type handlers struct {
	s        *subs.Service
	pending  PendingFunc
	deployed DeployedNodesFunc
	wait     time.Duration
}

// applied 是保存 / 刷新之后「内核用上没有」:订阅的动作从不自动重启内核(重启会断开连接,什么时候重启由
// 用户决定),所以节点变了而内核在跑时 ok=false、pendingRestart.pending=true,面板据此提示「重启内核后生效」。
type applied struct {
	OK             bool           `json:"ok"`
	PendingRestart pendingRestart `json:"pendingRestart"`
}

type pendingRestart struct {
	Pending bool     `json:"pending"`
	Reasons []string `json:"reasons"`
}

// saved 在 subs.SaveResult 之外多带一个 applied(没有就不出现这个键)。
type saved struct {
	subs.SaveResult
	Applied *applied `json:"applied,omitempty"`
}

// withApplied 给保存 / 刷新的结果补上 applied。节点池没变、或没接判断时原样返回。
func (h *handlers) withApplied(ctx context.Context, res *subs.SaveResult) any {
	if res == nil || h.pending == nil || !res.Changed {
		return res
	}
	pending, reasons := h.pending(ctx)
	if reasons == nil {
		reasons = []string{}
	}
	return saved{SaveResult: *res, Applied: &applied{OK: !pending, PendingRestart: pendingRestart{Pending: pending, Reasons: reasons}}}
}

// Register 把本分组的接口挂到 mux 上。字面路径(preview / login / node-share / order)比 {id} 优先。
func Register(mux *http.ServeMux, d Deps) {
	h := &handlers{s: d.Subs, pending: d.Pending, deployed: d.DeployedNodes, wait: d.UpdatesWait}
	if h.wait <= 0 {
		h.wait = 20 * time.Second
	}
	mux.HandleFunc("/api/openbox/subscriptions", httpx.Methods(map[string]http.HandlerFunc{
		http.MethodGet: h.list, http.MethodPost: h.create,
	}))
	mux.HandleFunc("/api/openbox/subscriptions/preview", httpx.Methods(map[string]http.HandlerFunc{http.MethodPost: h.preview}))
	mux.HandleFunc("/api/openbox/subscriptions/login", httpx.Methods(map[string]http.HandlerFunc{http.MethodPost: h.login}))
	mux.HandleFunc("/api/openbox/subscriptions/node-share", httpx.Methods(map[string]http.HandlerFunc{http.MethodPost: h.nodeShare}))
	mux.HandleFunc("/api/openbox/subscriptions/updates", httpx.Methods(map[string]http.HandlerFunc{http.MethodGet: h.updates}))
	mux.HandleFunc("/api/openbox/subscriptions/order", httpx.Methods(map[string]http.HandlerFunc{http.MethodPut: h.order}))
	mux.HandleFunc("/api/openbox/subscriptions/{id}", httpx.Methods(map[string]http.HandlerFunc{
		http.MethodPatch: h.patch, http.MethodDelete: h.delete,
	}))
	mux.HandleFunc("/api/openbox/subscriptions/{id}/refresh", httpx.Methods(map[string]http.HandlerFunc{http.MethodPost: h.refresh}))
}

// decode 读请求体为 JSON 对象。字段逐个检查(parse),这样能区分「没传」和「传了 null」。
func decode(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	var raw map[string]any
	if !httpx.DecodeJSON(w, r, &raw, maxBody) {
		return nil, false
	}
	if raw == nil {
		httpx.Error(w, http.StatusBadRequest, "请求体必须是 JSON 对象")
		return nil, false
	}
	return raw, true
}

func str(raw map[string]any, k string) (*string, bool) {
	v, ok := raw[k]
	if !ok || v == nil {
		return nil, true
	}
	s, isStr := v.(string)
	if !isStr {
		return nil, false
	}
	return &s, true
}

func obj(raw map[string]any, k string) (m map[string]any, set bool, ok bool) {
	v, has := raw[k]
	if !has {
		return nil, false, true
	}
	if v == nil {
		return nil, true, true
	}
	m, isObj := v.(map[string]any)
	return m, true, isObj
}

// parse 把原始 JSON 转成 subs.Input 和预览用的来源。
func parse(w http.ResponseWriter, raw map[string]any) (subs.Input, subs.Source, bool) {
	fail := func(msg string) (subs.Input, subs.Source, bool) {
		httpx.Error(w, http.StatusBadRequest, msg)
		return subs.Input{}, subs.Source{}, false
	}
	var in subs.Input
	var src subs.Source
	for _, k := range []string{"name", "url", "content", "userAgent", "loginId"} {
		if _, ok := str(raw, k); !ok {
			return fail(k + " 必须是字符串")
		}
	}
	in.Name, _ = str(raw, "name")
	u, _ := str(raw, "url")
	c, _ := str(raw, "content")
	ua, _ := str(raw, "userAgent")
	lid, _ := str(raw, "loginId")
	if u != nil {
		src.URL = *u
	}
	if c != nil {
		src.Content = *c
	}
	if lid != nil {
		src.LoginID = *lid
	}
	if ua != nil {
		src.UserAgent = *ua
		in.UserAgent = ua
	}
	if v, ok := raw["urls"]; ok && v != nil {
		arr, isArr := v.([]any)
		if !isArr {
			return fail("urls 必须是字符串数组")
		}
		for _, e := range arr {
			s, isStr := e.(string)
			if !isStr {
				return fail("urls 必须是字符串数组")
			}
			src.URLs = append(src.URLs, s)
		}
	}
	if v, ok := raw["urlEntries"]; ok && v != nil {
		arr, isArr := v.([]any)
		if !isArr {
			return fail("urlEntries 必须是数组")
		}
		for _, e := range arr {
			m, isObj := e.(map[string]any)
			if !isObj {
				return fail("urlEntries 的每一项必须是对象")
			}
			us, isStr := m["url"].(string)
			if !isStr {
				return fail("urlEntries 的 url 必须是字符串")
			}
			en := true
			if ev, has := m["enabled"]; has && ev != nil {
				b, isBool := ev.(bool)
				if !isBool {
					return fail("urlEntries 的 enabled 必须是布尔值")
				}
				en = b
			}
			src.URLEntries = append(src.URLEntries, subs.URLEntry{URL: us, Enabled: en})
		}
	}
	if u != nil || c != nil || len(src.URLs) > 0 || len(src.URLEntries) > 0 || src.LoginID != "" {
		cp := src
		in.Source = &cp
	}
	var ok bool
	if in.Rename, _, ok = obj(raw, "renameOptions"); !ok {
		return fail("renameOptions 必须是对象")
	}
	if in.AutoUpdate, in.AutoSet, ok = obj(raw, "autoUpdate"); !ok {
		return fail("autoUpdate 必须是对象或 null")
	}
	if in.NodeDNS, in.NodeDNSSet, ok = obj(raw, "nodeDns"); !ok {
		return fail("nodeDns 必须是对象或 null")
	}
	if v, has := raw["enabled"]; has && v != nil {
		b, isBool := v.(bool)
		if !isBool {
			return fail("enabled 必须是布尔值")
		}
		in.Enabled = &b
	}
	for _, k := range []string{"directSubscription", "directNodes"} {
		v, has := raw[k]
		if !has || v == nil {
			continue
		}
		b, isBool := v.(bool)
		if !isBool {
			return fail(k + " 必须是布尔值")
		}
		if k == "directSubscription" {
			in.DirectSubscription = &b
		} else {
			in.DirectNodes = &b
		}
	}
	if v, has := raw["bandwidthCheck"]; has && v != nil {
		b, isBool := v.(bool)
		if !isBool {
			return fail("bandwidthCheck 必须是布尔值")
		}
		in.BandwidthCheck = &b
	}
	return in, src, true
}

func (h *handlers) fail(w http.ResponseWriter, err error, what string) {
	var ie *subs.InputError
	switch {
	case errors.As(err, &ie):
		httpx.Error(w, http.StatusBadRequest, ie.Msg)
	case errors.Is(err, subs.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, err.Error())
	case errors.Is(err, subs.ErrNoLogin):
		httpx.Error(w, http.StatusNotImplemented, err.Error())
	case errors.Is(err, sub.ErrEmpty), errors.Is(err, sub.ErrNoNodes), errors.Is(err, sub.ErrUnrecognized), errors.Is(err, sub.ErrClashInvalid):
		httpx.Error(w, http.StatusBadRequest, err.Error())
	default:
		// 拉取失败(连不上、HTTP 非 2xx、超时)等:来自订阅服务器,用 502 区别于本机错误
		var fe *sub.FetchError
		if errors.As(err, &fe) {
			httpx.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		httpx.Error(w, http.StatusInternalServerError, what+": "+err.Error())
	}
}

func (h *handlers) list(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	recs, err := h.s.List(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "读取订阅失败: "+err.Error())
		return
	}
	h.fillKernelStale(r.Context(), recs)
	httpx.JSON(w, http.StatusOK, map[string]any{"subscriptions": recs})
}

// fillKernelStale 给每条订阅补上 KernelStale:本订阅的节点里有多少个还没进已部署的内核配置。
// 上游 v0.1.499 的「订阅节点尚未同步到内核」提示用它。算不出来(没接依赖 / 内核没在跑 / 读不到配置)时
// 保持 0,前端按没有处理,不误报。
func (h *handlers) fillKernelStale(ctx context.Context, recs []subs.Record) {
	if h.deployed == nil || len(recs) == 0 {
		return
	}
	deployed, err := h.deployed(ctx)
	if err != nil || deployed == nil {
		return
	}
	names, err := h.s.NodeNamesBySubscription(ctx)
	if err != nil {
		return
	}
	for i := range recs {
		stale := 0
		for _, n := range names[recs[i].ID] {
			if _, ok := deployed[n]; !ok {
				stale++
			}
		}
		recs[i].KernelStale = stale
	}
}

func (h *handlers) create(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	raw, ok := decode(w, r)
	if !ok {
		return
	}
	in, _, ok := parse(w, raw)
	if !ok {
		return
	}
	res, err := h.s.Create(r.Context(), in)
	if err != nil {
		h.fail(w, err, "保存订阅失败")
		return
	}
	httpx.JSON(w, http.StatusOK, h.withApplied(r.Context(), res))
}

func (h *handlers) preview(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	raw, ok := decode(w, r)
	if !ok {
		return
	}
	in, src, ok := parse(w, raw)
	if !ok {
		return
	}
	name := ""
	if in.Name != nil {
		name = *in.Name
	}
	res, err := h.s.Preview(r.Context(), src, name, in.Rename)
	if err != nil {
		h.fail(w, err, "预览订阅失败")
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

func (h *handlers) login(w http.ResponseWriter, _ *http.Request) {
	httpx.Error(w, http.StatusNotImplemented, subs.ErrNoLogin.Error())
}

func (h *handlers) patch(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	raw, ok := decode(w, r)
	if !ok {
		return
	}
	in, _, ok := parse(w, raw)
	if !ok {
		return
	}
	res, err := h.s.Update(r.Context(), r.PathValue("id"), in)
	if err != nil {
		h.fail(w, err, "修改订阅失败")
		return
	}
	httpx.JSON(w, http.StatusOK, h.withApplied(r.Context(), res))
}

func (h *handlers) delete(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	changed, err := h.s.Delete(r.Context(), r.PathValue("id"))
	if err != nil {
		h.fail(w, err, "删除订阅失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "changed": changed})
}

func (h *handlers) order(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	var req struct {
		IDs []string `json:"ids"`
	}
	if !httpx.DecodeJSON(w, r, &req, 1<<20) {
		return
	}
	recs, changed, err := h.s.Reorder(r.Context(), req.IDs)
	if err != nil {
		h.fail(w, err, "排序失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "subscriptions": recs, "changed": changed})
}

func (h *handlers) refresh(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	var req struct {
		Rename map[string]any `json:"renameOptions"`
	}
	if !httpx.DecodeJSON(w, r, &req, 1<<20) {
		return
	}
	res, err := h.s.Refresh(r.Context(), r.PathValue("id"), req.Rename)
	if err != nil {
		h.fail(w, err, "刷新订阅失败")
		return
	}
	httpx.JSON(w, http.StatusOK, h.withApplied(r.Context(), res))
}

// updates 是订阅页的长轮询:?since=<上次拿到的 revision>。版本和 since 不同(或 since 为空)就立刻返回
// {revision, nodesRevision};相同就挂住,等订阅 / 节点变了或挂满 UpdatesWait 再返回(没变时 revision 原样)。
// 面板拿到 nodesRevision 变了才重新拉节点和服务状态,只有 revision 变了就只刷新订阅列表。
func (h *handlers) updates(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	rev, err := h.s.WaitRevision(r.Context(), r.URL.Query().Get("since"), h.wait)
	if err != nil {
		if r.Context().Err() != nil {
			return // 客户端断开(切页 / 隐藏标签页 / 超时重来),不用回
		}
		httpx.Error(w, http.StatusInternalServerError, "读取订阅版本失败: "+err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, rev)
}
