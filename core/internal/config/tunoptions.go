package config

import "math"

// 对应基线 engine/tun-options.mjs:tun 接口的几个底层参数(后端设置 → TUN 参数)。
// 档案 tun.{stack,mtu,tcpMss};生成配置、入口 nft 表和校验都从这里取值。

const (
	// 接口名固定、不给设置:不用 tun0(OpenVPN / ZeroTier 占着时内核起不来,GitHub #109)
	TunInterfaceName = "openbox-tun"
	TunMTUMin        = 1280
	TunMTUMax        = 65535
	TunMSSMin        = 536
	TunMSSMax        = 65495
)

var TunStacks = []string{"mixed", "gvisor", "system"}

func tunConf(profile any) map[string]any {
	if p, ok := profile.(map[string]any); ok {
		if t, ok := p["tun"].(map[string]any); ok {
			return t
		}
	}
	return map[string]any{}
}

// isIntInRange 相当于 v === 0 || (Number.isInteger(v) && lo <= v && v <= hi)
func isIntInRange(v any, lo, hi float64) (int, bool) {
	f, ok := v.(float64)
	if !ok {
		return 0, false
	}
	if f == 0 {
		return 0, true
	}
	if f != math.Trunc(f) || f < lo || f > hi {
		return 0, false
	}
	return int(f), true
}

// TunStack:mixed(默认)/ gvisor / system。
func TunStack(profile any) string {
	if s, ok := tunConf(profile)["stack"].(string); ok {
		for _, v := range TunStacks {
			if s == v {
				return s
			}
		}
	}
	return "mixed"
}

// TunMTU:0 = 不写,内核默认。
func TunMTU(profile any) int {
	n, _ := isIntInRange(tunConf(profile)["mtu"], TunMTUMin, TunMTUMax)
	return n
}

// TunTCPMss:0 = 不钳制(由入口 nft 表里的规则实现,sing-box 没有这个选项)。
func TunTCPMss(profile any) int {
	n, _ := isIntInRange(tunConf(profile)["tcpMss"], TunMSSMin, TunMSSMax)
	return n
}
