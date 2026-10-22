package directhosts

import "github.com/timeflysoon/Open-Box/core/internal/ipx"

// 对应基线 engine/direct-hosts.mjs 里 config 装配要用的导出。
// (nodeDirectSources 只有 client-build 用,不属于 core,没有移植。)

// SharedCdnCidrs 是 Cloudflare 公布的全部地址段:成千上万个网站共用的任播地址,不进「节点直连」按 IP 的那份。
var SharedCdnCidrs = []string{
	"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
	"190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
	"104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
	"2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
}

// IsSharedCdnCidr 相当于 isSharedCdnCidr:和任一共用段有重叠就算。
func IsSharedCdnCidr(cidr any) bool {
	for _, r := range SharedCdnCidrs {
		if ipx.CidrsOverlap(r, cidr) {
			return true
		}
	}
	return false
}

const (
	NodeDirectDomainTag = "obnode-direct"
	NodeDirectIPTag     = "obnode-direct-ip"
	// 地址一个都没有时的占位:文档保留的域名 / 地址,真实流量碰不到。
	NodeDirectPlaceholderDomain = "obnode-direct.invalid"
	NodeDirectPlaceholderCidr   = "192.0.2.255/32"
)

func NodeDirectFile(rulesetDir, tag string) string { return rulesetDir + "/" + tag + ".json" }

// NodeDirectRuleSets 是配置里引用两份本地规则集的条目(域名一份、IP 一份)。
func NodeDirectRuleSets(rulesetDir string) []map[string]any {
	out := []map[string]any{}
	for _, tag := range []string{NodeDirectDomainTag, NodeDirectIPTag} {
		out = append(out, map[string]any{"type": "local", "tag": tag, "format": "source", "path": NodeDirectFile(rulesetDir, tag)})
	}
	return out
}
