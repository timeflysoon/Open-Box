package config

import (
	"regexp"

	"github.com/timeflysoon/Open-Box/core/internal/jsx"
	"github.com/timeflysoon/Open-Box/core/internal/routing"
)

// 对应基线 engine/config.mjs 开头的常量和两个小函数。

const (
	// 面板专用回环入站的端口 / 标签(连接表里这类连接的 metadata.type 是 mixed/<标签>)
	PanelInboundPort = 7891
	PanelInboundTag  = "panel-in"

	TunV4 = "172.19.0.1/30"
	TunV6 = "fdfe:dcba:9876::1/126"
	// 上面两个地址所在的网段,给路由规则做防回环用
	TunV4Net = "172.19.0.0/30"
	TunV6Net = "fdfe:dcba:9876::/126"
	// tun 的对端地址(网段里的第二个地址),sing-box 1.14 起 dns_mode 把 53 端口改写到这里
	TunV4Peer = "172.19.0.2"
	TunV6Peer = "fdfe:dcba:9876::2"

	// UDP 会话空闲超时:sing-box 默认 5 分钟,Clash 系默认 60 秒
	TunUDPTimeout = "60s"

	// 内核 DNS 入站端口(system/dns-takeover.mjs 的 SINGBOX_DNS_UPSTREAM 与之一致)
	DNSInboundPort = 7853
	// 「只让这些终端进内核」名单外终端的查询由入口转到这里,一律直连解析
	DNSDirectInboundTag  = "dns-in-direct"
	DNSLanInboundTag     = "dns-in-lan"
	DNSLanInboundPort    = 53
	DNSDirectInboundPort = 7855
	// dnsmasq 分流模式专用的回送出站;init 脚本用这个 tag 判断「这份配置需要接管 dnsmasq」
	DNSMasqOutboundTag = "dnsmasq"

	DefaultRulesetDir = "/opt/open-box/data/rulesets"
)

// 私网 / 链路本地 / 组播目标不进 TUN(和 OpenClash 的 localnetwork 放行一致)。
var (
	TunExcludeV4 = []string{"10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4"}
	TunExcludeV6 = []string{"fc00::/7", "fe80::/10", "ff00::/8"}
	// 地址空间的最后一个地址:sing-tun 把排除表编成 nft 区间集合时,「一直到末尾」的区间终点会溢出,
	// 所以 auto_redirect 下要把这个地址从排除段里挖掉。
	EndOfAddressSpace = []string{"255.255.255.255/32", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128"}
)

var lastSegmentRe = regexp.MustCompile(`/[^/]*/?$`)

// FlipDirFor:热切换的开关 / 旁路动态集放在 data/flip/,和规则集目录同级。
// 对应 flipDirFor(rulesetDir):String(rulesetDir || 默认值) 去掉最后一段路径,再接上 flip 目录名。
func FlipDirFor(rulesetDir any) string {
	dir := DefaultRulesetDir
	if jsx.Truthy(rulesetDir) {
		dir = jsx.ToString(rulesetDir)
	}
	return lastSegmentRe.ReplaceAllString(dir, "") + "/" + routing.FlipDirName
}

// FindDuplicateTag:出站 / endpoint 的 tag 在内核里是同一个命名空间,有同名就是 duplicate tag FATAL。
// 返回第一个重复的 tag;没有重复(或 tag 不是字符串的条目)返回 ok=false。
func FindDuplicateTag(list []any) (string, bool) {
	seen := map[string]bool{}
	for _, o := range list {
		tag, isStr := jsx.Get(o, "tag").(string)
		if !isStr {
			continue
		}
		if seen[tag] {
			return tag, true
		}
		seen[tag] = true
	}
	return "", false
}
