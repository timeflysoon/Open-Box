// 生成内核配置的纯计算部分。路由器(api/deploy-runner.mjs 的 buildCurrentConfig、api/client-config.mjs 的 buildClientBundle)
// 和 App 本地分流(client-engine 的 build:手机本机刷新订阅后,用手机的节点重算)用的是同一个函数——PM 2026-10-04:两边同一套代码。
// 这里不碰 store、文件、网络,要的东西都从参数给
import { CHAIN_SOURCE_LABEL, CHAIN_SUBSCRIPTION_ID, chainNodes } from './chain-proxy.mjs'
import { CLIENT_CACHE_FILE, CLIENT_FAKEIP_V4, CLIENT_RULESET_DIR, toClientTemplate } from './client-config.mjs'
import { buildConfigDetailed } from './config.mjs'
import { nodeDirectSources } from './direct-hosts.mjs'
import { FAKEIP_V6, applyProxyUpstreamRoutes, dnsFakeIpEnabled } from './dns.mjs'
import { flipFlagMap, flipFlagStates } from './flip.mjs'
import { activeNodesOf } from './node-pool.mjs'
import { entryModePlan, nativeBypassPlan, normalizeRouting, policyClasses, policyOutboundOptions } from './routing-model.mjs'
import { rulesetKind } from './ruleset-tags.mjs'
import { normalizeAutoUpdate } from './subscription-schedule.mjs'
import { builtinTags, emitUserGroups } from './user-groups.mjs'

// 客户端引擎的版本:bundle.source 的形状、或者算法变了就加一(App 拿它和 source.engineVersion 比,不一样就不在手机上重算)。
// 2:订阅和节点站点直连从写进规则改成引用两份规则集文件(ruleFiles)
export const ENGINE_VERSION = 2

// 档案 + 节点池 + 节点组 → 内核配置。nodes 已去掉停用订阅的节点(node-pool.mjs 的 activeNodesOf)。
// 回 { config, failover, dnsRuleOwners, directHosts };failover 是故障转移的运行映射(父组 / 页签 / 有效节点 / 子组 tag / 检测参数),
// 和配置同一次生成(含链式节点),写进 config.meta.json 给后台管理器和界面用
export const buildConfigFromParts = ({
  profile, nodes, groups, subscriptions = [], clashSecret, geoDir, rulesetDir, cacheFilePath, selections, tlsCert,
  systemDns = [], localSubnets = [], directHostCidrs = [], ruleLists = {}, nativeBypass, dnsFilter = null, inlineDirectHosts = false,
}) => {
  const { config, dnsRuleOwners, directHosts, failover } = buildConfigDetailed({
    cacheFilePath,
    // 规则集 .srs 所在目录:本机安装路径,不存档案(见 engine/config.mjs)
    rulesetDir,
    selections,
    ...(tlsCert ? { tlsCert } : {}),
    nodes,
    userGroups: groups,
    subscriptions,
    profile: { ...profile, clashApiSecret: clashSecret },
    systemDns,
    // 本机接口网段:tun 的私网排除表要把它们挖出来(见 engine/config.mjs)
    localSubnets,
    // 节点 / 订阅域名此刻的解析结果,并进直连规则的 ip_cidr(见 system/resolve-hosts.mjs)
    directHostCidrs,
    // 规则集链接的形状表:每条链接编成了域名 / IP 哪几份 .srs(见 system/rule-lists.mjs)
    ruleLists,
    nativeBypass,
    dnsFilter,
    // 订阅和节点站点直连的地址直接写进规则(规则页推算、手机 App);部署的配置引用规则集文件(engine/config.mjs)
    inlineDirectHosts,
  })
  for (const entry of config.route?.rule_set || []) {
    if (rulesetKind(entry.tag)) entry.path = `${geoDir}/${entry.tag}.srs`
  }
  return { config, failover, dnsRuleOwners, directHosts }
}

// ---- App「节点 / 订阅」页签里随节点变的两样(api/client-config.mjs 的 clientView 也用它们)----
// 节点组:用户组,带类型和图标;故障转移组带 lanes(页签按定义顺序,0 = 主用;字段同 failover[].lanes)
export const viewGroups = ({ groups, outboundTags, failover = [] }) => {
  const lanesOf = new Map(failover.map((f) => [f.tag, f.lanes]))
  const laneView = ({ id, name, icon, mode, ref, members, valid }) => ({ id, name, icon, mode, ref, members, valid })
  return (groups || [])
    .filter((g) => !g.kind && g.enabled !== false && outboundTags.has(g.name))
    .map((g) => ({
      tag: g.name, name: g.name, icon: g.icon || '', type: g.type,
      ...(g.type === 'failover' ? { lanes: (lanesOf.get(g.name) || []).map(laneView) } : {}),
    }))
}

// 订阅和它进了配置的节点(停用订阅的节点不在配置里,列表就空着);链式代理单列一份(和面板节点管理一样)。
// 流量是字节,到期 / 更新时间是毫秒,0 = 没有;开了定期更新的带 autoUpdate
export const viewSubscriptions = ({ subscriptions, nodes, profile, outboundTags }) => {
  const count = (v) => (Number.isFinite(v) && v > 0 ? v : 0)
  const all = [...(nodes || []), ...chainNodes(profile || {})]
  const tagsOf = (id) => all.filter((n) => n && n.subscriptionId === id && outboundTags.has(n.tag)).map((n) => n.tag)
  const out = (subscriptions || []).map((s) => {
    const autoUpdate = normalizeAutoUpdate(s.autoUpdate)
    return {
      id: s.id,
      name: s.name || '',
      enabled: s.enabled !== false,
      nodes: tagsOf(s.id),
      upload: count(s.usage?.upload),
      download: count(s.usage?.download),
      total: count(s.usage?.total),
      expire: count(s.usage?.expire) * 1000,
      updatedAt: count(s.updatedAt),
      ...(autoUpdate ? { autoUpdate } : {}),
    }
  })
  const chained = tagsOf(CHAIN_SUBSCRIPTION_ID)
  if (chained.length) {
    out.push({ id: CHAIN_SUBSCRIPTION_ID, name: CHAIN_SOURCE_LABEL, enabled: true, nodes: chained, upload: 0, download: 0, total: 0, expire: 0, updatedAt: 0 })
  }
  return out
}

// 客户端配置。source 是配对 / 同步时从路由器带下来的全部输入(api/client-config.mjs 的 buildClientBundle 里拼):
//   engineVersion、profile(打过客户端补丁的档案)、subscriptions、nodes(路由器此刻的整份节点池)、groups、
//   ruleLists(规则集链接的形状)、selections(此刻的选择)、upstreamRoutes(代理侧 DNS 上游的线路,路由器上按目标分流判好的)。
// nodes 是这次用的节点池(App 本机刷新过的订阅换成手机的;用 source.nodes 就和路由器发来的配置一字不差)。
// 回 { config, flags, ruleSets, ruleFiles, failover, directTag, view: { subscriptions, groups } }:
// ruleFiles 是订阅和节点站点直连那两份规则集文件的内容({ 'obnode-direct': {...}, 'obnode-direct-ip': {...} },写成 rulesets/<tag>.json),
// 开关关着就是 {}(配置里也不引用)
export const buildClientConfig = ({ source, nodes }) => {
  const profile = source.profile || {}
  const groups = source.groups || []
  const subscriptions = source.subscriptions || []
  const selections = source.selections || {}
  const active = activeNodesOf(nodes || [], subscriptions)
  const { config, failover, directHosts } = buildConfigFromParts({
    profile,
    nodes: active,
    groups,
    subscriptions,
    // clash API 在客户端模板里整段去掉,密钥用不上
    clashSecret: '',
    selections,
    ruleLists: source.ruleLists || {},
    geoDir: CLIENT_RULESET_DIR,
    rulesetDir: CLIENT_RULESET_DIR,
    cacheFilePath: CLIENT_CACHE_FILE,
    nativeBypass: { enabled: false, sets: [] },
    // 订阅和节点站点直连:和路由器一样引用两份本地规则集(开关开着就一直引用,没地址也留着),地址在 ruleFiles 里由 App 写文件——
    // 节点变了内核配置不变,只换文件和出站
    inlineDirectHosts: false,
  })
  const builtin = builtinTags(groups)
  // 代理侧 DNS 上游走哪条线路:和部署一样按目标分流判,再写进解析器的 detour(engine/dns.mjs)。不做这一步,解析器停在
  // 生成时的占位(兜底)上
  applyProxyUpstreamRoutes(config, source.upstreamRoutes || [], builtin)
  const { publicTags } = emitUserGroups(groups, active, {})
  const members = policyOutboundOptions(publicTags, builtin)
  const conf = normalizeRouting(profile.routing)
  // 热切换开关此刻开没开(和 system/flip-files.mjs 的 flipTargetState(...).flags 同一算法)、开关 tag → 站点集名字
  const flagState = flipFlagStates(conf, policyClasses(profile.routing, members, builtin, selections))
  const flagSelectors = Object.fromEntries([...flipFlagMap(conf)].map(([name, tag]) => [tag, name]))
  const template = toClientTemplate(config, { selections, flagState, flagSelectors })
  const outboundTags = new Set((template.config.outbounds || []).map((o) => o.tag))
  return {
    config: template.config,
    flags: template.flags,
    ruleSets: template.ruleSets,
    ruleFiles: directHosts ? nodeDirectSources(directHosts) : {},
    failover,
    directTag: builtin.direct,
    view: {
      subscriptions: viewSubscriptions({ subscriptions, nodes: nodes || [], profile, outboundTags }),
      groups: viewGroups({ groups, outboundTags, failover }),
    },
  }
}

// App 本地分流「直连不进内核」的规划(用户 2026-10-04 定:App 的直连流量和路由器版一样不进内核,域名、IP 都算)。
// 判断和路由器的入口旁路同一套(engine/routing-model.mjs 的 entryModePlan + nativeBypassPlan),手机上的前提:
//   · 没有终端分流(clientRoutes 空);终端的查询都经内核(dnsMode 按 hijack 算);FakeIP 按档案的开关;
//   · enabled 一律 true:客户端补丁把档案的 directBypass 关了,只是为了内核配置里不出现路由器的入口动态集;手机上旁不旁路由这里定;
//   · selections 用 App 传进来的手机自己的选择(selector 名 → 选中的成员),不用 source.selections;
//   · 节点组 / 内置出口和 buildClientConfig 一样算(nodes 不给就用 source.nodes,只影响组在不在,不影响判断)。
// 回 { entry, bypass, fakeIpRanges }:
//   entry   入口模式:{ mode: 'whitelist' | 'blacklist', reason, fakeIp, needSets(geoip tag), needCidrs, directAnswer }——
//           白名单时只有 needSets / needCidrs 和 FakeIP 占位池进内核;directAnswer = 直连域名解析出的真实地址可以记下来放走
//   bypass  黑名单时能直接旁路的:{ enabled, sets(geoip tag), pending: [{ policy, sets, against: [{ name, geoip, cidrs, lists? }] }], reason, fakeIp }
//           pending 的集合要先和 against 里较早的 IP 条件核对,扣掉重叠的段再旁路
//   fakeIpRanges  手机上的 FakeIP 占位池(和路由器的不是同一段),开着 FakeIP 时旁路的集合要扣掉它
// 第二步(解码 .srs、只认纯目标 IP 的集合、扣重叠段、收回到地址空间末尾的区间、扣占位池)照路由器 system/native-bypass.mjs
// 的 resolveNativeBypass,由 App 在 Go 里做
export const clientEntryPlan = ({ source, selections, nodes }) => {
  const profile = source.profile || {}
  const groups = source.groups || []
  const active = activeNodesOf(nodes || source.nodes || [], source.subscriptions || [])
  const builtin = builtinTags(groups)
  const { publicTags } = emitUserGroups(groups, active, {})
  const fakeIp = dnsFakeIpEnabled(profile)
  const options = {
    members: policyOutboundOptions(publicTags, builtin),
    builtin,
    selections: selections || {},
    clientRoutes: [],
    fakeIp,
    dnsMode: 'hijack',
    enabled: true,
  }
  return {
    entry: entryModePlan(profile.routing, options),
    bypass: nativeBypassPlan(profile.routing, options),
    fakeIpRanges: fakeIp ? [CLIENT_FAKEIP_V4, FAKEIP_V6] : [],
  }
}
