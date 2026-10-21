package routing

import (
	"strings"
)

// ---------------------------------------------------------------------------
// bypassPlan / entryPlan:系统入口(nft)哪些目标可以直接放走、不进内核。
// 对应上游 engine/routing-model.mjs 的 nativeBypassPlan / entryModePlan(v0.1.318)。
// ---------------------------------------------------------------------------

const (
	entryModeBlacklist = "blacklist"
	entryModeWhitelist = "whitelist"
	// 后端设置「直连不进内核」(档案 directBypass,默认开)关掉时的原因
	directBypassOffReason = "后端设置里关掉了「直连不进内核」:所有流量都进内核,入口不放行"
)

type EarlierRule struct {
	Name  string   `json:"name"`
	Geoip []string `json:"geoip"`
	Cidrs []string `json:"cidrs"`
	Lists []string `json:"lists,omitempty"`
}

type PendingItem struct {
	Policy  string        `json:"policy"`
	Sets    []string      `json:"sets"`
	Against []EarlierRule `json:"against"`
}

type BypassPlan struct {
	Enabled bool          `json:"enabled"`
	Sets    []string      `json:"sets"`
	Pending []PendingItem `json:"pending"`
	FakeIP  bool          `json:"fakeIp"`
	Reason  string        `json:"reason"`
}

// 两个计划共用的选项(JS 里是解构参数:没传的键取默认值,传了就按 JS 真假判断)。
type planOpts struct {
	members      []string
	builtin      builtinTags
	selections   map[string]any
	clientRoutes []any
	fakeIP       bool
	dnsMode      any
	enabled      bool
	// v0.1.318 快照之后才有的选项(v0.1.342 的 Node 在算「其余部分」时会传):不因为「有终端被指定走代理」关掉旁路。
	// 没有明文实现可对照,按旧实现的理解保留,只用在 bypassPlan 上。
	ignoreProxyClients bool
}

func parsePlanOpts(opts any) planOpts {
	o := planOpts{members: []string{"direct"}, builtin: defaultBuiltin, enabled: true, dnsMode: "dnsmasq"}
	m, ok := asObject(opts)
	if !ok {
		return o
	}
	if v, has := m["members"]; has && v != nil {
		o.members = parseMembers(v)
	}
	if v, has := m["builtin"]; has && v != nil {
		o.builtin = parseBuiltin(v)
	}
	if v, has := m["selections"]; has && v != nil {
		o.selections = parseSelections(v)
	}
	if a, ok := asArray(m["clientRoutes"]); ok {
		o.clientRoutes = a
	}
	o.fakeIP = jsTruthy(m["fakeIp"])
	if v, has := m["dnsMode"]; has {
		o.dnsMode = v
	}
	if v, has := m["enabled"]; has {
		o.enabled = jsTruthy(v)
	}
	o.ignoreProxyClients = jsTruthy(m["ignoreProxyClients"])
	return o
}

func (o planOpts) dnsOff() bool { return o.dnsMode == "off" }

// 有终端被指定走代理(出口不是内置直连)
func (o planOpts) proxyClient() bool {
	for _, cr := range o.clientRoutes {
		if out := get(cr, "outbound"); jsTruthy(out) && out != o.builtin.direct {
			return true
		}
	}
	return false
}

func hasGeoipPrefix(tag string) bool { return strings.HasPrefix(tag, "geoip-") }

func filterGeoip(tags []string) []string {
	out := []string{}
	for _, t := range tags {
		if hasGeoipPrefix(t) {
			out = append(out, t)
		}
	}
	return out
}

func bypassPlan(routing any, opts any) BypassPlan {
	conf := normalizeRouting(routing)
	o := parsePlanOpts(opts)
	domainSafe := o.fakeIP && !o.dnsOff()
	empty := func(reason string) BypassPlan {
		return BypassPlan{Sets: []string{}, Pending: []PendingItem{}, FakeIP: domainSafe, Reason: reason}
	}
	if !o.enabled {
		return empty(directBypassOffReason)
	}
	notes := []string{}
	if o.fakeIP && o.dnsOff() {
		notes = append(notes, "DNS 禁用模式下终端的查询不一定经内核,FakeIP 不作旁路前提,按真实 IP 计算")
	}
	if domainSafe {
		notes = append(notes, "FakeIP 试验开着:走代理的域名规则按占位地址计,不挡直连集合（终端自带加密 DNS / 开启前已缓存的真实地址 / 转发漏匹配不在此保证内）")
	}
	off := func(reason string) BypassPlan {
		return empty(strings.Join(append([]string{reason}, notes...), ";"))
	}

	earlier := []EarlierRule{}
	if customPolicyActive(conf.Custom) {
		cidrs, geoip, lists := []string{}, []string{}, []string{}
		for _, rule := range conf.Custom.Rules {
			if customOutboundTag(rule, o.builtin) == o.builtin.direct {
				continue
			}
			switch rule.Type {
			case "port":
				return off("前置自定义分流「" + rule.Value + "」按端口分流,任何目标 IP 都可能命中,入口旁路不能越过它")
			case "ipCidr":
				cidrs = append(cidrs, rule.Value)
				continue
			case "geoip":
				geoip = append(geoip, "geoip-"+rule.Value)
				continue
			}
			// 规则集链接:开着 FakeIP 时域名那份拿的是占位地址,不挡;IP 那份部署时解码出来扣掉重叠段
			if rule.Type == "ruleUrl" && domainSafe {
				lists = append(lists, ListTagForUrl(rule.Value))
				continue
			}
			if rule.Type == "ruleUrl" || rule.Type == "ruleset" {
				return off("前置自定义分流「" + rule.Value + "」是规则集链接 / 规则集,里面可能有 IP 段,入口旁路不能越过它")
			}
			// 域名 / 后缀 / 关键词行
			if !domainSafe {
				return off("前置自定义分流「" + rule.Value + "」按域名分流,它解析出来的 IP 在入口分不出来,旁路不能越过它")
			}
		}
		if len(cidrs) > 0 || len(geoip) > 0 || len(lists) > 0 {
			e := EarlierRule{Name: "前置自定义分流", Geoip: geoip, Cidrs: cidrs}
			if len(lists) > 0 {
				e.Lists = lists
			}
			earlier = append(earlier, e)
		}
	}
	if o.proxyClient() && !o.ignoreProxyClients {
		return off("有终端被指定走代理,该终端的全部流量都要进内核")
	}
	if !domainSafe {
		goes := func(name, def string) bool { return policyGoesDirect(name, def, o.members, o.builtin, o.selections) }
		for _, p := range conf.ActivePolicies {
			byDomain := false
			if !goes(p.Name, p.Default) {
				byDomain = len(p.Domain) > 0 || len(p.DomainSuffix) > 0 || len(p.DomainKeyword) > 0
				if !byDomain {
					for _, tag := range p.Rulesets {
						if !hasGeoipPrefix(tag) {
							byDomain = true
							break
						}
					}
				}
			}
			if byDomain {
				return off("站点集「" + p.Name + "」按域名走代理 / 拒绝:有域名的访问只按域名判,这些域名解析出来的真实地址在入口分不出来,按 IP 放走会放错（开 FakeIP 后它们拿的是占位地址,就不挡了）")
			}
		}
		if !goes(conf.Fallback.Name, conf.Fallback.Default) {
			return off("兜底「" + conf.Fallback.Name + "」走代理:没命中域名规则的域名都走兜底,它们解析出来的真实地址在入口分不出来,按 IP 放走会放错（开 FakeIP 后它们拿的是占位地址,就不挡了）")
		}
	}

	sets := []string{}
	pending := []PendingItem{}
	for _, p := range conf.ActivePolicies {
		geoip := filterGeoip(p.Rulesets)
		if !policyGoesDirect(p.Name, p.Default, o.members, o.builtin, o.selections) {
			lists := []string{}
			for _, tag := range p.Rulesets {
				if isRuleListTag(tag) {
					lists = append(lists, tag)
				}
			}
			if len(geoip) > 0 || len(p.IPCidr) > 0 || len(lists) > 0 {
				e := EarlierRule{Name: p.Name, Geoip: geoip, Cidrs: cloneStrs(p.IPCidr)}
				if len(lists) > 0 {
					e.Lists = lists
				}
				earlier = append(earlier, e)
			}
			continue
		}
		if len(geoip) == 0 {
			continue
		}
		if len(earlier) > 0 {
			against := make([]EarlierRule, len(earlier))
			for i, e := range earlier {
				against[i] = EarlierRule{Name: e.Name, Geoip: cloneStrs(e.Geoip), Cidrs: cloneStrs(e.Cidrs)}
				if len(e.Lists) > 0 {
					against[i].Lists = cloneStrs(e.Lists)
				}
			}
			pending = append(pending, PendingItem{Policy: p.Name, Sets: geoip, Against: against})
		} else {
			for _, tag := range geoip {
				if !inList(tag, sets) {
					sets = append(sets, tag)
				}
			}
		}
	}
	if len(sets) == 0 && len(pending) == 0 {
		return off("走直连的站点集里没有 geoip 规则集,入口没有可用的 IP 集合")
	}
	reasons := append([]string{}, notes...)
	for _, x := range pending {
		names := make([]string, len(x.Against))
		for i, a := range x.Against {
			names[i] = a.Name
		}
		reasons = append(reasons, "站点集「"+x.Policy+"」的集合要先和前面带 IP 条件的「"+strings.Join(names, "」「")+"」核对重叠,部署时决定")
	}
	return BypassPlan{Enabled: len(sets) > 0, Sets: sets, Pending: pending, FakeIP: domainSafe, Reason: strings.Join(reasons, ";")}
}
