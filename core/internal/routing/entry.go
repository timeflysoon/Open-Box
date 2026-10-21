package routing

import (
	"encoding/json"

	"github.com/timeflysoon/Open-Box/core/internal/protocol"
)

// entryPlan:系统入口(nft)的进内核策略(上游 engine 的 entryModePlan)。
// 选项和 bypassPlan 相同,返回 mode / reason / fakeIp / needSets / needCidrs / directAnswer。
//   blacklist  默认进内核:只有此刻走直连的站点集引用的 IP 集合在入口放走(集合由 bypassPlan 给出)
//   whitelist  默认放行:只有「必须进内核」的目标(FakeIP 占位池 + 走代理 / 拒绝的 IP 集合和网段)进内核
// whitelist 的前提少一条都退回 blacklist,原因写明。IPv6 这一版不放。

type EntryPlan struct {
	Mode         string   `json:"mode"`
	Reason       string   `json:"reason"`
	FakeIP       bool     `json:"fakeIp"`
	NeedSets     []string `json:"needSets"`
	NeedCidrs    []string `json:"needCidrs"`
	DirectAnswer bool     `json:"directAnswer"`
}

// 直连应答放行(直连侧解析出来的真实地址写进入口放行集合)开不开。
func directAnswerAllowed(conf Routing, o planOpts) bool {
	if !o.enabled || !o.fakeIP || o.dnsOff() {
		return false
	}
	if o.proxyClient() {
		return false
	}
	if customPolicyActive(conf.Custom) {
		for _, rule := range conf.Custom.Rules {
			if rule.Type == "port" && customOutboundTag(rule, o.builtin) != o.builtin.direct {
				return false
			}
		}
	}
	return true
}

func entryPlan(routing any, opts any) EntryPlan {
	conf := normalizeRouting(routing)
	o := parsePlanOpts(opts)
	domainSafe := o.fakeIP && !o.dnsOff()
	needSets, needCidrs := []string{}, []string{}
	addSet := func(tag string) {
		if !inList(tag, needSets) {
			needSets = append(needSets, tag)
		}
	}
	directAnswer := directAnswerAllowed(conf, o)
	black := func(reason string) EntryPlan {
		return EntryPlan{Mode: entryModeBlacklist, Reason: reason, FakeIP: domainSafe, NeedSets: []string{}, NeedCidrs: []string{}, DirectAnswer: directAnswer}
	}
	if !o.enabled {
		return black(directBypassOffReason)
	}
	if !o.fakeIP {
		return black("没开 FakeIP:走代理的域名解析出来是真实 IP,入口分不出它和直连目标,不能默认放行")
	}
	if o.dnsOff() {
		return black("DNS 禁用模式下终端的查询不一定经内核,走代理的域名拿不到占位地址,不能默认放行")
	}
	if !policyGoesDirect(conf.Fallback.Name, conf.Fallback.Default, o.members, o.builtin, o.selections) {
		return black("兜底「" + conf.Fallback.Name + "」走代理:没命中的目标都要进内核,入口没法默认放行")
	}
	if o.proxyClient() {
		return black("有终端被指定走代理,该终端的全部流量都要进内核")
	}
	if customPolicyActive(conf.Custom) {
		for _, rule := range conf.Custom.Rules {
			if customOutboundTag(rule, o.builtin) == o.builtin.direct {
				continue
			}
			switch rule.Type {
			case "port":
				return black("前置自定义分流「" + rule.Value + "」按端口分流,入口按 IP 判不了")
			case "ruleUrl", "ruleset":
				return black("前置自定义分流「" + rule.Value + "」是规则集链接 / 规则集,里面有没有 IP 段说不清")
			case "ipCidr":
				needCidrs = append(needCidrs, rule.Value)
			case "geoip":
				addSet("geoip-" + rule.Value)
			}
			// 域名行:走代理的拿占位地址、拒绝的解析也拒,都不产生真实 IP
		}
	}
	for _, p := range conf.ActivePolicies {
		if policyGoesDirect(p.Name, p.Default, o.members, o.builtin, o.selections) {
			continue
		}
		for _, tag := range p.Rulesets {
			if hasGeoipPrefix(tag) {
				addSet(tag)
			}
		}
		for _, c := range p.IPCidr {
			if !inList(c, needCidrs) {
				needCidrs = append(needCidrs, c)
			}
		}
	}
	return EntryPlan{Mode: entryModeWhitelist, Reason: "FakeIP 开着、兜底直连:入口默认放行,只有 FakeIP 占位池和走代理 / 拒绝的 IP 集合进内核", FakeIP: domainSafe, NeedSets: needSets, NeedCidrs: needCidrs, DirectAnswer: true}
}

// entryPlan(routing, {members, builtin, selections, clientRoutes, fakeIp, dnsMode, enabled})
func hEntryPlan(_ *protocol.Context, args []json.RawMessage) (any, error) {
	routing, err := arg(args, 0)
	if err != nil {
		return nil, err
	}
	opts, err := arg(args, 1)
	if err != nil {
		return nil, err
	}
	return entryPlan(routing, opts), nil
}
