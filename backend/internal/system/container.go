package system

import (
	"context"
	"os"
	"strings"
)

// ContainerCheck 是 Docker 里跑时的自检结果(对齐上游服务状态的 container 对象)。
// 前端 Docker 卡片(`ContainerCard.vue`)与「系统提示」的容器告警都用它:
// 哪一项不满足,内核在这个容器里就跑不完整。
type ContainerCheck struct {
	// LanIP 是容器自己看到的局域网地址(用于显示访问入口)。
	LanIP string `json:"lanIp,omitempty"`
	// Mode 是截流方式(tun / stopped 等)。
	Mode string `json:"mode,omitempty"`
	// Masquerade 是转发 IP 伪装是否开着。
	Masquerade bool `json:"masquerade,omitempty"`
	// TUN 是容器里有 /dev/net/tun(内核建 tun 入站的硬要求)。
	TUN bool `json:"tun"`
	// NetAdmin 是容器带着 NET_ADMIN 能力(能改路由 / 建 tun / 装 nft 规则)。
	NetAdmin bool `json:"netAdmin"`
	// Forwarding 是 net.ipv4.ip_forward 为 1(内核要转发流量)。
	Forwarding bool `json:"forwarding"`
	// RedirectsDisabled 是 send_redirects 全关(关着才不会把流量重定向回容器)。
	RedirectsDisabled bool `json:"redirectsDisabled"`
	// NFTables 是容器里有 nft 命令(入口放行 / 直连应答这些规则要靠它)。
	NFTables bool `json:"nftables"`
	// Routing 是策略路由顺序检查:conflicts 是提前查询主路由表的规则,非空会让流量绕开容器。
	Routing *ContainerRouting `json:"routing,omitempty"`
}

// ContainerRouting 是容器里的策略路由检查结果。
type ContainerRouting struct {
	Checked   bool              `json:"checked"`
	Conflicts []RoutingConflict `json:"conflicts"`
}

// RoutingConflict 是一条「提前查询主路由表」的规则。
type RoutingConflict struct {
	Priority any `json:"priority"`
	Table    any `json:"table"`
}

// InContainer 判断当前进程是否跑在容器里。
// 依据 Docker 容器的两个稳定特征:根目录有 /.dockerenv,或 /proc/1/cgroup 里出现 docker / kubepods / containerd。
// 判断不出来就当不在容器里(不误报成 container)。
func InContainer() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	b, err := os.ReadFile("/proc/1/cgroup")
	if err != nil {
		return false
	}
	s := string(b)
	for _, marker := range []string{"docker", "kubepods", "containerd", "lxc"} {
		if strings.Contains(s, marker) {
			return true
		}
	}
	return false
}

// ContainerCaps 读容器自检里靠文件系统 / proc 就能判断的那几项。
// nft 与策略路由要执行命令,由调用方用 Runner 补(见 ProbeContainer)。
// 读不到的项一律 false:宁可提示「可能缺」,也不假装具备。
func ContainerCaps() ContainerCheck {
	c := ContainerCheck{}
	if _, err := os.Stat("/dev/net/tun"); err == nil {
		c.TUN = true
	}
	c.NetAdmin = hasNetAdmin()
	c.Forwarding = readProcInt("/proc/sys/net/ipv4/ip_forward") == 1
	c.RedirectsDisabled = allRedirectsDisabled()
	return c
}

// hasNetAdmin 从 /proc/self/status 的 CapEff 判断有没有 CAP_NET_ADMIN(第 12 位)。
// 能读 /proc/self/status 且解析成功才判断,否则 false。
func hasNetAdmin() bool {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "CapEff:") {
			continue
		}
		hex := strings.TrimSpace(strings.TrimPrefix(line, "CapEff:"))
		if hex == "" {
			return false
		}
		var v uint64
		for _, ch := range hex {
			var d uint64
			switch {
			case ch >= '0' && ch <= '9':
				d = uint64(ch - '0')
			case ch >= 'a' && ch <= 'f':
				d = uint64(ch-'a') + 10
			case ch >= 'A' && ch <= 'F':
				d = uint64(ch-'A') + 10
			default:
				return false
			}
			v = v<<4 | d
		}
		const capNetAdmin = 12
		return v&(1<<capNetAdmin) != 0
	}
	return false
}

// readProcInt 读一个只含整数的 /proc 文件,读不到返回 -1。
func readProcInt(path string) int64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return -1
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return -1
	}
	var v int64
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return -1
		}
		v = v*10 + int64(ch-'0')
	}
	return v
}

// allRedirectsDisabled 判断 send_redirects 是否全关(每块网卡一个文件,任何一个为 1 就返回 false)。
func allRedirectsDisabled() bool {
	entries, err := os.ReadDir("/proc/sys/net/ipv4/conf")
	if err != nil {
		return false
	}
	seen := false
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		v := readProcInt("/proc/sys/net/ipv4/conf/" + e.Name() + "/send_redirects")
		if v < 0 {
			continue
		}
		seen = true
		if v != 0 {
			return false
		}
	}
	return seen
}

// ProbeContainer 在容器里时补齐只有执行命令才知道的项(nft 是否存在、策略路由有没有提前查询主表)。
// 不在容器里返回 nil。run 为空时只做文件系统判断。
func ProbeContainer(ctx context.Context, run Runner, lanIP, mode string) *ContainerCheck {
	if !InContainer() {
		return nil
	}
	c := ContainerCaps()
	c.LanIP, c.Mode = lanIP, mode
	if run != nil {
		// nft 命令在不在:入口放行 / 直连应答这些规则要靠它
		if _, err := run(ctx, "nft", "--version"); err == nil {
			c.NFTables = true
		}
		c.Routing = probeRoutingConflicts(ctx, run)
	}
	return &c
}

// probeRoutingConflicts 查策略路由里有没有「rule 的优先级小于主路由表查询阈值」——
// 有的话流量会被别的表提前接走,容器的 tun 就截不到。判断不出来返回 Checked=false(不误报冲突)。
func probeRoutingConflicts(ctx context.Context, run Runner) *ContainerRouting {
	out, err := run(ctx, "ip", "rule", "show")
	if err != nil || out.Code != 0 {
		return &ContainerRouting{Checked: false, Conflicts: []RoutingConflict{}}
	}
	conflicts := []RoutingConflict{}
	// ip rule 的一行形如:32765: from all lookup main
	for _, line := range strings.Split(out.Stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "lookup main") {
			continue
		}
		prio := strings.TrimSuffix(strings.Fields(line)[0], ":")
		// 主表路由的默认优先级是 32766;比它更早查主表(pref 更小)且不是我们自己加的,算冲突
		if isSmallPriority(prio) {
			conflicts = append(conflicts, RoutingConflict{Priority: prio, Table: "main"})
		}
	}
	return &ContainerRouting{Checked: true, Conflicts: conflicts}
}

// isSmallPriority 判断优先级数值是否小于 32765(我们自己插入规则用的起始值)。
func isSmallPriority(s string) bool {
	var v int64
	if s == "" {
		return false
	}
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return false
		}
		v = v*10 + int64(ch-'0')
	}
	return v < 32765
}
