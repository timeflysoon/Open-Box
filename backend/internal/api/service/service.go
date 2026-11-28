// Package service 实现 /api/openbox/service/* 和 /api/openbox/kernel/version:
// 查询、启动、停止、重启、开机自启 sing-box,以及读内核版本。
// 这里只做「服务控制」;启动 / 重启时「生成配置 → 校验 → 重启 → 确认在跑」的完整部署流程另做(STATUS.md M1)。
package service

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os/exec"
	"runtime"
	"time"

	"github.com/timeflysoon/Open-Box/backend/internal/dnssync"
	"github.com/timeflysoon/Open-Box/backend/internal/httpx"
	"github.com/timeflysoon/Open-Box/backend/internal/singbox"
	"github.com/timeflysoon/Open-Box/backend/internal/system"
)

// Controller 是服务控制的最小接口(*system.Services 实现它),测试里换假的。
type Controller interface {
	Status(ctx context.Context, name string) (system.ServiceInfo, error)
	Do(ctx context.Context, name, action string) (system.ActionResult, error)
}

// ConflictFinder 找出正在运行的其它代理服务(*system.ConflictDetector 实现它),测试里换假的。
type ConflictFinder interface {
	Find(ctx context.Context) ([]system.Conflict, error)
}

// PendingFinder 判断「配置改了、内核还没用上」(*singbox.Applied 实现它),测试里换假的。
type PendingFinder interface {
	Pending(ctx context.Context) (singbox.PendingRestart, error)
}

// DNSSync 把 DNS 接管接进内核的启停(*dnssync.Coordinator 满足),测试里换假的。
type DNSSync interface {
	BeforeKernelStop(ctx context.Context) error
	AfterKernelStart(ctx context.Context) (dnssync.Result, error)
}

// Deps 是本分组的依赖。
type Deps struct {
	Services    Controller
	Conflicts   ConflictFinder // 为空 = 不检测,conflicts 恒为空数组
	Pending     PendingFinder  // 为空 = 不判断,pendingRestart 恒为「没有」
	DNS         DNSSync        // 为空 = 不管 DNS 接管;非空 = 停 / 重启内核前先撤销接管,起 / 重启后按 dns.mode 对齐
	Kind        system.InitKind
	CoreService string // sing-box 的服务名
	PanelName   string // 后端自己的服务名(只查开机自启)
	SingBox     string // sing-box 可执行文件
	Mihomo      string // Mihomo 可执行文件;空 = 不提供 Mihomo(mihomoAvailable 恒为 false)
	KernelFile  string // 路由器内核选择文件(<ConfigDir>/router-kernel);空 = 一直是 sing-box
	Arch        string // 空 = runtime.GOARCH
	// Container 返回容器自检结果;为空 = 不探测(服务状态里不出现 container)。
	// 只在 Docker 里跑时由 main.go 接上 system.ProbeContainer。
	Container func(ctx context.Context) *system.ContainerCheck
}

// Register 把接口挂到 mux 上。
func Register(mux *http.ServeMux, d Deps) {
	if d.Arch == "" {
		d.Arch = runtime.GOARCH
	}
	mux.HandleFunc("/api/openbox/service/status", httpx.Methods(map[string]http.HandlerFunc{
		http.MethodGet: d.status,
	}))
	mux.HandleFunc("/api/openbox/service/core/{action}", httpx.Methods(map[string]http.HandlerFunc{
		http.MethodPost: d.action,
	}))
	mux.HandleFunc("/api/openbox/kernel/version", httpx.Methods(map[string]http.HandlerFunc{
		http.MethodGet: d.kernelVersion,
	}))
}

// kernelVersionResponse 是 GET /api/openbox/kernel/version:当前内核的版本加「安装包里有没有 Mihomo」。
// 前端只在带了 kernel 字段时才显示内核切换框(KernelPage.vue),见 STATUS.md 双内核。
type kernelVersionResponse struct {
	Kernel string `json:"kernel"`
	singbox.KernelVersion
	MihomoAvailable bool `json:"mihomoAvailable"`
}

func (d Deps) kernelVersion(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	kernel, err := system.ReadRouterKernel(d.KernelFile)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := kernelVersionResponse{Kernel: kernel}
	if kernel == system.KernelMihomo {
		resp.KernelVersion = singbox.ReadMihomoVersion(r.Context(), d.Mihomo)
	} else {
		resp.KernelVersion = singbox.ReadKernelVersion(r.Context(), d.SingBox)
	}
	if d.Mihomo != "" {
		_, lookErr := exec.LookPath(d.Mihomo)
		resp.MihomoAvailable = lookErr == nil
	}
	httpx.JSON(w, http.StatusOK, resp)
}

// coreInfo 是服务状态里的内核项:服务信息加当前选中的内核(sing-box / mihomo;选择文件无效时不带)。
type coreInfo struct {
	system.ServiceInfo
	Kernel string `json:"kernel,omitempty"`
}

type statusResponse struct {
	Core      coreInfo           `json:"core"`
	Panel     system.ServiceInfo `json:"panel"`
	Conflicts []system.Conflict  `json:"conflicts"`
	Platform  string             `json:"platform"`
	Arch      string             `json:"arch"`
	// 配置改了、内核还没用上的部分:内核在运行、且和上次成功部署时的输入不一样才有。
	// 要部署一次(POST /api/openbox/deploy)才会清掉;单纯的重启只是让内核重读磁盘上的旧配置,不会。
	PendingRestart pending `json:"pendingRestart"`
	// 在 Docker 容器里跑时才有:容器自检结果(Docker 卡片与「系统提示」的容器告警都用它)。
	// 不在容器里就是不出现这个键,前端按没有处理。
	Container *system.ContainerCheck `json:"container,omitempty"`
}

type pending struct {
	Pending bool     `json:"pending"`
	Reasons []string `json:"reasons"`
	// 具体改了什么的明细码(对齐上游 v0.1.486);空数组 = 只知道原因,前端按 reasons 显示
	Details []string `json:"details"`
}

func (d Deps) status(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	resp := statusResponse{
		Conflicts:      []system.Conflict{},
		Platform:       string(d.Kind),
		Arch:           d.Arch,
		PendingRestart: pending{Reasons: []string{}, Details: []string{}},
		// 后端自己:能回答这个请求就是在运行
		Panel: system.ServiceInfo{Running: true, Raw: "running"},
	}
	if d.Kind == system.InitNone || d.Services == nil {
		// 没有服务管理器:不是错误,界面按「没在跑」显示,并在 raw 里说明
		resp.Core = coreInfo{ServiceInfo: system.ServiceInfo{Raw: "unsupported"}, Kernel: d.selectedKernel()}
		httpx.JSON(w, http.StatusOK, resp)
		return
	}
	core, err := d.Services.Status(r.Context(), d.CoreService)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "查询 sing-box 服务状态失败: "+err.Error())
		return
	}
	resp.Core = coreInfo{ServiceInfo: core, Kernel: d.selectedKernel()}
	// 与其它代理服务冲突的检测:尽力而为,查不到就当没有,不让它拖垮状态接口
	if d.Conflicts != nil {
		if found, _ := d.Conflicts.Find(r.Context()); len(found) > 0 {
			resp.Conflicts = found
		}
	}
	// 待重启:内核没在运行就没有「还没生效」一说,不算;判断失败当作没有(与 conflicts 一样,不让它拖垮状态接口)
	if d.Pending != nil && core.Running {
		if p, err := d.Pending.Pending(r.Context()); err != nil {
			slog.Debug("判断待重启失败", "error", err)
		} else if p.Pending {
			resp.PendingRestart = pending{Pending: true, Reasons: append([]string{}, p.Reasons...), Details: append([]string{}, p.Details...)}
		}
	}
	// 后端自己的开机自启:查不到就不带这个字段
	if p, err := d.Services.Status(r.Context(), d.PanelName); err == nil {
		resp.Panel.Autostart = p.Autostart
	}
	// 容器自检:只在容器里跑时才有(不在容器里 ProbeContainer 返回 nil,这个键就不出现)
	if d.Container != nil {
		resp.Container = d.Container(r.Context())
	}
	httpx.JSON(w, http.StatusOK, resp)
}

// selectedKernel 读选中的内核;选择文件读不了 / 无效就不带这个字段(不让它拖垮状态接口)。
func (d Deps) selectedKernel() string {
	k, err := system.ReadRouterKernel(d.KernelFile)
	if err != nil {
		slog.Warn("读取内核选择失败", "error", err)
		return ""
	}
	return k
}

// actionResponse 是 ActionResult 加一句可选的 DNS 说明(前端按 ok / stderr 显示,多出的字段会被忽略)。
type actionResponse struct {
	system.ActionResult
	DNSNote string `json:"dnsNote,omitempty"`
}

// dnsBudget 是 DNS 接管那一步的总时限(撤销 / 对齐各自还有更细的超时)。
const dnsBudget = 2 * time.Minute

func (d Deps) action(w http.ResponseWriter, r *http.Request) {
	httpx.NoStore(w)
	if d.Kind == system.InitNone || d.Services == nil {
		httpx.Error(w, http.StatusServiceUnavailable, system.ErrNoInit.Error())
		return
	}
	action := r.PathValue("action")
	// DNS 接管的撤销和对齐一旦开始就要做完:请求断开不能把 dnsmasq 留在指着一个停了的内核的状态
	dctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), dnsBudget)
	defer cancel()
	// 停 / 重启之前先撤销接管:内核停了而 dnsmasq 还指着它,整个局域网就没有 DNS。撤销不成功就不动内核
	if d.DNS != nil && (action == "stop" || action == "restart") {
		if err := d.DNS.BeforeKernelStop(dctx); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "为安全起见没有"+actionVerb(action)+"内核: "+err.Error())
			return
		}
	}
	res, err := d.Services.Do(r.Context(), d.CoreService, action)
	if err != nil {
		switch {
		case errors.Is(err, system.ErrBadAction):
			httpx.Error(w, http.StatusBadRequest, "不支持的操作,可选 start / stop / restart / enable / disable")
		case errors.Is(err, system.ErrNoInit):
			httpx.Error(w, http.StatusServiceUnavailable, err.Error())
		default:
			httpx.Error(w, http.StatusInternalServerError, "服务操作失败: "+err.Error())
		}
		return
	}
	resp := actionResponse{ActionResult: res}
	// 起 / 重启成功之后按 dns.mode 对齐(等内核的 DNS 入站应答)。对齐失败不改变服务操作本身的结果:
	// 内核已经起来了,接管那边出错时已自动恢复原状,只在 dnsNote 里说明
	if d.DNS != nil && res.OK && (action == "start" || action == "restart") {
		got, derr := d.DNS.AfterKernelStart(dctx)
		resp.DNSNote = dnssync.Note(got, derr)
		if derr != nil {
			slog.Warn("内核启动后对齐 DNS 接管失败", "action", action, "error", derr)
		}
	}
	// 命令本身失败(退出码非 0)仍是 200:前端按 ok / stderr 显示
	httpx.JSON(w, http.StatusOK, resp)
}

func actionVerb(action string) string {
	if action == "restart" {
		return "重启"
	}
	return "停止"
}
