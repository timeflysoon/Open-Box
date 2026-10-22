package routing

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// 对应上游 engine/flip.mjs(基线 v0.1.318 快照)。热切换:站点集在直连 / 代理之间翻面时不重启内核。
// sing-box 没有热加载,运行中能变的只有 selector 的选择和本地规则集文件的内容,所以把「这个站点集此刻走直连还是走代理」
// 放进一个很小的开关规则集里,按类别分叉的规则成对写进配置:
//
//	logical AND(站点集匹配, 开关[, 附加条件])  → 代理那一支
//	站点集匹配                                 → 直连那一支
//
// 翻面时只改写开关文件。这个文件只有纯函数;写文件和翻面流程在 Node 端(system/flip-files.mjs)。
//
// 没有移植 flattenFlipRule / flipFlagOfRule:它们是 Node 端「读规则」(规则页推算、规则归属)用的,依赖
// client-routes 的 withoutShareGuard,configDetailed 不会走到。

const (
	FlipTagPrefix    = "obflip-"
	FlipFallbackTag  = FlipTagPrefix + "fallback"
	FlipBypassPrefix = FlipTagPrefix + "byp-"
	FlipDirName      = "flip"
	// 入口白名单那一侧的「必须进内核」动态集:每个 geoip 候选一份,另外三份固定的。
	FlipNeedPrefix = FlipTagPrefix + "need-"
	FlipNeedAll    = FlipNeedPrefix + "all"    // 黑名单模式是「全部」,白名单模式只剩 ::/0
	FlipNeedFakeIP = FlipNeedPrefix + "fakeip" // FakeIP 占位池
	FlipNeedCidr   = FlipNeedPrefix + "cidr"   // 走代理 / 拒绝的站点集手写的网段 + 前置自定义分流里走代理的 IP 行
)

// FlipNeedFixed 是三份固定的「必须进内核」动态集,顺序固定。
var FlipNeedFixed = []string{FlipNeedAll, FlipNeedFakeIP, FlipNeedCidr}

func IsFlipTag(tag string) bool       { return strings.HasPrefix(tag, FlipTagPrefix) }
func IsFlipBypassTag(tag string) bool { return strings.HasPrefix(tag, FlipBypassPrefix) }
func IsFlipNeedTag(tag string) bool   { return strings.HasPrefix(tag, FlipNeedPrefix) }

// FlipFlagTag:站点集的开关 tag。按站点集 id 取(normalizeRouting 保证有 id;改名、调序都不变),没有 id 退到名字。
// tag 会拼进文件路径,只用十六进制。
func FlipFlagTag(p Policy) string {
	key := p.ID
	if key == "" {
		key = p.Name
	}
	sum := sha256.Sum256([]byte(key))
	return FlipTagPrefix + hex.EncodeToString(sum[:])[:12]
}

func FlipBypassTag(geoTag string) string { return FlipBypassPrefix + geoTag }
func FlipNeedTag(geoTag string) string   { return FlipNeedPrefix + geoTag }

// FlipFlags 是「名字 → 开关 tag」,按 JS Map 的语义:保持插入顺序,同名再次写入只更新值、不换位置。
type FlipFlags struct {
	names []string
	tags  map[string]string
}

func (f *FlipFlags) set(name, tag string) {
	if f.tags == nil {
		f.tags = map[string]string{}
	}
	if _, has := f.tags[name]; !has {
		f.names = append(f.names, name)
	}
	f.tags[name] = tag
}

func (f FlipFlags) Get(name string) (string, bool) { t, ok := f.tags[name]; return t, ok }

// Each 按插入顺序遍历。
func (f FlipFlags) Each(fn func(name, tag string)) {
	for _, n := range f.names {
		fn(n, f.tags[n])
	}
}

// FlipFlagMap:名字 → 开关 tag(生效的站点集 + 兜底)。conf 是 normalizeRouting 的结果。
func FlipFlagMap(conf Routing) FlipFlags {
	var m FlipFlags
	for _, p := range conf.ActivePolicies {
		m.set(p.Name, FlipFlagTag(p))
	}
	if conf.Fallback.Name != "" {
		m.set(conf.Fallback.Name, FlipFallbackTag)
	}
	return m
}

// 开关文件的内容(source 格式,免编译)。ON = 此刻不是直连(走代理或拒绝):network 这一项对 UDP / TCP 都命中,
// 等于「匹配一切」;OFF = 一条永远不会命中的域名。
const (
	FlipFlagOn  = `{"version":3,"rules":[{"network":["tcp","udp"]}]}`
	FlipFlagOff = `{"version":3,"rules":[{"domain":["obflip-off.invalid"]}]}`
)

func FlipFlagContent(on bool) string {
	if on {
		return FlipFlagOn
	}
	return FlipFlagOff
}

// FlipBypassPlaceholder:旁路动态集的「空」状态不能真空(启动时集合全空,内核不建 nft 集合,之后再填就报错),
// 放文档保留段里的单个地址占位,v4 / v6 各一个。
var FlipBypassPlaceholder = []string{"192.0.2.255/32", "2001:db8:ffff::ffff/128"}

// FlipPlaceholderSource 和 JS 的 JSON.stringify 逐字节一致(map 序列化会按字母序排键,所以这里直接拼)。
func FlipPlaceholderSource() string {
	return `{"version":3,"rules":[{"ip_cidr":["` + FlipBypassPlaceholder[0] + `","` + FlipBypassPlaceholder[1] + `"]}]}`
}

// FlipPlaceholderSRSBase64:上面那份源码用内核(1.14.0-openbox-tcp5)编出来的 .srs,46 字节,内容固定,直接内嵌。
const FlipPlaceholderSRSBase64 = "U1JTAnjaYmRgY2SAACaWAwxM/8GEgAIj747//6ESDP8xBf4zAAIAAP//StUOeA=="

// andRule:成对规则里代理那一支。子规则各是一组条件,整体是它们的与;tail 是动作(server / action / rcode / outbound)。
// 空的子规则(null / 没有键)丢掉。
func andRule(subRules []map[string]any, tail map[string]any) map[string]any {
	kept := make([]any, 0, len(subRules))
	for _, r := range subRules {
		if len(r) > 0 {
			kept = append(kept, r)
		}
	}
	out := map[string]any{"type": "logical", "mode": "and", "rules": kept}
	for k, v := range tail {
		out[k] = v
	}
	return out
}

// FlipFlagStates:此刻每个开关该是什么状态。classes 是 policyClasses(含兜底);不是直连就是 ON,不在 classes 里的按 OFF。
func FlipFlagStates(conf Routing, classes map[string]string) map[string]bool {
	out := map[string]bool{}
	FlipFlagMap(conf).Each(func(name, tag string) {
		if c, has := classes[name]; has {
			out[tag] = c != "direct"
		} else {
			out[tag] = false
		}
	})
	return out
}

// FlipBypassCandidates:入口旁路的候选——所有生效站点集引用到的 geoip-* 集合(去重、保序)。
func FlipBypassCandidates(conf Routing) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, p := range conf.ActivePolicies {
		for _, tag := range p.Rulesets {
			if isGeoipTag(tag) && !seen[tag] {
				seen[tag] = true
				out = append(out, tag)
			}
		}
	}
	return out
}
