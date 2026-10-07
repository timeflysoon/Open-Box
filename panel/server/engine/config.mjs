import { emitOutbound } from './emit-outbound.mjs'
import { TUN_INTERFACE_NAME, tunStack, tunMtu } from './tun-options.mjs'
import { resolveChainNodes } from './chain-proxy.mjs'
import { emitEndpoint } from './emit-endpoint.mjs'
import { emitUserGroups } from './user-groups.mjs'
import { customOutboundTag, customPolicyActive, effectiveOutbound, nativeBypassPlan, normalizeRouting, policyClasses, policyOutboundOptions } from './routing-model.mjs'
import { buildRoute } from './routing.mjs'
import { buildServerInbounds } from './servers.mjs'
import { admitDnsDirect, admitSources, bypassSources, guardTerminalRules, normalizeClientRoutes } from './client-routes.mjs'
import { planNodeDns, withNodeResolver } from './node-dns.mjs'
import { buildDnsWithResolvers, dnsFakeIpEnabled, fakeIpCachePath, ipv6InTun, ipv6ProxyMode, FAKEIP_V6 } from './dns.mjs'
import { NODE_DIRECT_DOMAIN_TAG, NODE_DIRECT_IP_TAG, NODE_DIRECT_PLACEHOLDER, collectDirectHosts, isSharedCdnCidr, nodeDirectRuleSets } from './direct-hosts.mjs'
import { cidrsOverlap, parseCidr, subtractCidrs } from './cidr.mjs'
import { buildFilterConfig } from './dns-filter.mjs'
import { FLIP_DIR_NAME, FLIP_NEED_FIXED, flipBypassCandidates, flipBypassTag, flipFlagMap, flipNeedTag } from './flip.mjs'

// 面板专用回环入站的端口(见下方 inbounds 注释)
export const PANEL_INBOUND_PORT = 7891
// 面板自己的回环 mixed 入站标签;连接表里这类连接的 metadata.type 是 `mixed/<标签>`(route-test 靠它认出探测连接)
export const PANEL_INBOUND_TAG = 'panel-in'

const TUN_V4 = '172.19.0.1/30'
const TUN_V6 = 'fdfe:dcba:9876::1/126'
// 上面两个地址所在的网段,给路由规则做防回环用(见 routing.mjs)
export const TUN_V4_NET = '172.19.0.0/30'
export const TUN_V6_NET = 'fdfe:dcba:9876::/126'
// tun 的对端地址(网段里的第二个地址):sing-box 1.14 起 tun 自己的 DNS 劫持(dns_mode)把 53 端口改写到这里,
// 和 1.13 隐含的做法同一个地址;显式写出来是为了关掉它顺带的「发到这个地址的连接自动交给 DNS 模块」
// (见下面 tunInbound.dns_address 处的说明)
const TUN_V4_PEER = '172.19.0.2'
const TUN_V6_PEER = 'fdfe:dcba:9876::2'

// 私网 / 链路本地 / 组播目标不进 TUN,由内核按普通路由转发——和 OpenClash 的 localnetwork
// 放行一致。否则局域网里发往任何私网地址(包括指向死网关的静态路由网段)的包都会进 sing-box,
// 按 ip_is_private 交给直连去拨:TCP 每条等 5 秒,UDP 会话默认挂 5 分钟。正式路由器实测:
// AnyDesk 打洞向 10.0.0.x 并发探测几千个地址,sing-box 攒下几万个会话,内核 slab 涨 270MB、
// 自身涨到 200MB,直接被 OOM 杀掉;OpenClash 下同样的包在内核里静默丢掉,毫无影响。
// 排除时要把路由器自己各接口所在的网段挖出来(options.localSubnets,部署时从 ip addr 读,见
// system/local-subnets.mjs):sing-box 生成的 nft 里排除表的 return 排在 DNS 劫持规则之前,
// 把路由器所在网段也排除的话,局域网发给路由器的 DNS 查询就进不了内核,劫持模式的分流解析就废了。
// tun 自己的网段(172.19.0.0/30 / fdfe:dcba:9876::/126)必须无条件挖出来:内核停着的时候(开机、
// 升级后首次启动)tun0 还不存在,从 ip addr 读不到它;若把它连同 172.16/12 一起排除,内核起来后
// 自己的 DNS 交换全部超时、什么都不通(v0.1.64 在开发路由器上升级后实测)。
const TUN_EXCLUDE_V4 = ['10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4']
const TUN_EXCLUDE_V6 = ['fc00::/7', 'fe80::/10', 'ff00::/8']
// sing-tun 1.13.14 把排除表编成 nft 区间集合时(auto_redirect),每个区间写成 [起点, 终点+1);"一直到地址
// 空间末尾"的区间(ff00::/8 的末尾就是 ffff:…:ffff,v4 的 240.0.0.0/4 同理)终点+1 溢出,sing-tun 退回用
// 起点当终点键,和别的区间同在一个集合里就 EEXIST、auto_redirect 整个起不来(redirect_nftables_exprs.go
// nftablesCreateIPSet;开发路由器实测 fe80::/10 + ff00::/8 崩、去掉 ff00::/8 正常)。
// 处理办法不是砍掉半段组播(第四轮 T6:ff80::/9 含 RFC 7371 的 ffbx::/32 SSM 等合法范围),而是只把最后
// 一个地址(全 1,任何真实流量都不会以它为目标)从排除段里挖掉,让区间终点可编码;纯 tun 模式没有这个
// 编码问题,排除表原样
const END_OF_ADDRESS_SPACE = ['255.255.255.255/32', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128']
// UDP 会话空闲超时:sing-box 默认 5 分钟,Clash 系默认 60 秒。打洞 / 探测类的一次性 UDP 包
// 没必要挂 5 分钟,60 秒足够覆盖正常的 DNS / QUIC / 游戏心跳。
const TUN_UDP_TIMEOUT = '60s'
// 内核 DNS 入站端口(system/dns-takeover.mjs 的 SINGBOX_DNS_UPSTREAM 与之一致)
export const DNS_INBOUND_PORT = 7853
// 「只让这些终端进内核」名单外终端的查询由入口转到这里,一律直连解析(engine/client-routes.mjs 的 admitDnsDirect)
export const DNS_DIRECT_INBOUND_TAG = 'dns-in-direct'
export const DNS_DIRECT_INBOUND_PORT = 7855
// dnsmasq 模式下把被 auto_redirect 改写进 tun 的局域网 DNS 交回本机 dnsmasq 用的专用出站
export const findDuplicateTag = (list) => {
  const seen = new Set()
  for (const o of list) {
    const tag = o && o.tag
    if (typeof tag !== 'string') continue
    if (seen.has(tag)) return tag
    seen.add(tag)
  }
  return null
}

// dnsmasq 分流模式专用的回送出站;init 脚本用这个 tag 判断"这份配置需要接管 dnsmasq"
export const DNSMASQ_OUTBOUND_TAG = 'dnsmasq'

// systemDns:路由器系统的上游 DNS(部署时从 resolv.conf.auto 等读,见 system/resolv.mjs)。「上游 DNS」(档案记号 wan)
// 用的就是它(engine/dns.mjs 的 directUpstream)——不能让 sing-box 去问系统解析器,会绕回 dnsmasq 形成死循环。
// 预览/测试不传就按地区回落到随包默认。
// regionGroups 参数已经退役(以前按国家自动分的 urltest 组 + 一个 PROXY 聚合 selector,
// 那是节点组功能出现之前的东西);留着这个参数名只是让老调用方不报错。
// 规则集 .srs 放哪(system/paths.mjs 的 rulesetDir);部署时由 deploy-runner 按安装根目录传进来,
// 不再存进档案——它是本机路径,跟着档案导出到别的机器上没有意义
export const DEFAULT_RULESET_DIR = '/opt/open-box/data/rulesets'
// 热切换的开关 / 旁路动态集放在 data/flip/(engine/flip.mjs);和规则集目录同级
export const flipDirFor = (rulesetDir) => `${String(rulesetDir || DEFAULT_RULESET_DIR).replace(/\/[^/]*\/?$/, '')}/${FLIP_DIR_NAME}`

export const buildConfigDetailed = ({ nodes, profile, userGroups, systemDns, localSubnets = [], directHostCidrs = [], subscriptions = [], ruleLists = {}, cacheFilePath = '/opt/open-box/data/cache.db', rulesetDir = DEFAULT_RULESET_DIR, selections = {}, tlsCert = { certPath: '/opt/open-box/etc/certs/server.crt', keyPath: '/opt/open-box/etc/certs/server.key' }, nativeBypass, dnsFilter, flipDir: flipDirOption, inlineDirectHosts = false }) => {
  // 订阅和节点站点直连(默认开):见 engine/direct-hosts.mjs
  // directHostCidrs:部署时把节点域名解析出来的 IP(见 system/resolve-hosts.mjs),让按裸 IP
  // 直连节点服务器的客户端(SSH 等)也能命中直连规则;预览接口没有这份,只按域名匹配。
  const directHosts = profile.directForNodes === false
    ? null
    : (() => {
        const dh = collectDirectHosts(nodes, subscriptions)
        // Cloudflare 这类共享任播地址不按 IP 直连(engine/direct-hosts.mjs 的 SHARED_CDN_CIDRS,#304):路由规则和首包预判放行用的都是这一份
        const cidrs = [...new Set([...dh.cidrs, ...(Array.isArray(directHostCidrs) ? directHostCidrs : [])])].filter((c) => !isSharedCdnCidr(c))
        return { ...dh, cidrs }
      })()
  // 配置里不写这些地址本身,引用两份本地规则集(engine/direct-hosts.mjs):地址变了只换文件、不重启内核。地址交给调用方写文件。
  // inlineDirectHosts:地址直接写进规则——给手机 App 的配置(true,没有路由器上的文件);规则页按当前设置推算('aligned',
  // api/penetration.mjs):地址是空的也写一条永远不会命中的占位,部署的配置不管有没有地址都有这条(引用规则集),推算数出来的
  // 「第几条」才对得上
  const directHostSets = directHosts && !inlineDirectHosts ? { domain: NODE_DIRECT_DOMAIN_TAG, ip: NODE_DIRECT_IP_TAG } : null
  const inlineHosts = directHostSets || !directHosts ? null : inlineDirectHosts !== 'aligned' ? directHosts : {
    domains: directHosts.domains.length ? directHosts.domains : [NODE_DIRECT_PLACEHOLDER.domain],
    cidrs: directHosts.cidrs.length ? directHosts.cidrs : [NODE_DIRECT_PLACEHOLDER.cidr],
  }
  // 链式代理(档案的 chainProxies):核对过上游和环之后并进节点表。它们的服务器地址不进上面的「节点站点直连」——
  // 那些地址是经上游线路去连的,本机不直连、也不该在部署时去解析
  const chain = resolveChainNodes({ chainProxies: profile.chainProxies, nodes, userGroups })
  const allNodes = [...nodes, ...chain.nodes]
  const wireguardNodes = allNodes.filter((n) => n.type === 'wireguard')
  const outboundNodes = allNodes.filter((n) => n.type !== 'wireguard')

  // 节点组只有用户自己建的这一种:emitUserGroups 已经保证了成员非空、无悬空引用、
  // 无环(sing-box check 只能挡住第一条,见 user-groups.mjs 的说明)。
  // 内置的直连/拒绝也从这里出(它们和节点组同在「节点管理」列表里,按那里的顺序)
  // 故障转移的内部子组也在 userGroupOutbounds 里(要进内核),但公开的出站清单(站点集出口候选、DNS 分类、
  // 旁路计划)只用 publicTags——内部子组不能漏进候选
  const { outbounds: userGroupOutbounds, builtin, publicTags, failover } = emitUserGroups(userGroups || [], allNodes, {
    testUrl: profile.testUrl,
  })

  // 每个站点集在内核里就是一个同名 selector,成员是「节点管理」里启用着的条目
  // (直连 / 各节点组 / 拒绝)。用户在代理页点选,和 Clash 的策略组用法一致——
  // 所以站点集本身不记节点,只记"能选哪些"。最后固定跟一个兜底的「其他」:
  // route.final 指向它,上面都没命中的流量走它。
  const routingConf = normalizeRouting(profile.routing)
  const groupTags = publicTags
  const policyMemberTags = policyOutboundOptions(groupTags, builtin)
  // default 必须是成员之一,否则内核启动时找不到。effectiveOutbound 负责把"不在成员
  // 表里"的情况(空值、已删掉的组、迁移留下的 'proxy' 占位)算成一个真实存在的成员。
  const asSelector = (tag, preferred) => ({
    type: 'selector',
    tag,
    outbounds: policyMemberTags,
    default: effectiveOutbound(preferred, policyMemberTags, builtin),
  })
  const policyOutbounds = [
    ...routingConf.activePolicies.map((p) => asSelector(p.name, p.default)),
    asSelector(routingConf.fallback.name, routingConf.fallback.default),
  ]
  // 节点服务器域名的专用解析器(GitHub #136,engine/node-dns.mjs):配了的订阅,它的节点出站带 domain_resolver
  const nodeDns = planNodeDns(subscriptions)
  const outbounds = [
    ...userGroupOutbounds,
    ...policyOutbounds,
    ...outboundNodes.map((n) => withNodeResolver(emitOutbound(n), nodeDns.bySubscription.get(n.subscriptionId))),
  ]
  const endpoints = wireguardNodes.map(emitEndpoint)

  const dnsMode = (profile.dns && profile.dns.mode) || 'hijack'
  if (dnsMode === 'dnsmasq') {
    // 绑定 lo 才拨得通 127.0.0.1(auto_detect_interface 对写了 bind_interface 的出站不生效)
    outbounds.push({ type: 'direct', tag: DNSMASQ_OUTBOUND_TAG, bind_interface: 'lo' })
  }
  // 出站 / endpoint 的 tag 在内核里是同一个命名空间:节点组、站点集、节点、内置直连/拒绝、
  // dnsmasq 回送出站之间只要有一对同名,内核就 duplicate tag FATAL。API 层各自只查自己那份
  // 列表,这里是最后一道闸——报一句人能看懂的话,而不是让部署死在 check 上。
  const duplicateTag = findDuplicateTag([...outbounds, ...endpoints])
  if (duplicateTag) {
    throw new Error(`出站名称重复:「${duplicateTag}」——节点组、站点集、节点、内置直连/拒绝之间不能同名,请改名后再启动`)
  }
  // 终端分流(engine/client-routes.mjs);出口只认配置里真有的 outbound。
  // wireguard 是 endpoint 不是 outbound,但路由规则一样能指向它的 tag
  const clientRoutes = normalizeClientRoutes(profile.clientRoutes, { directTag: builtin.direct })
  const knownOutbounds = new Set([...outbounds, ...endpoints].map((o) => o.tag))
  // IPv6 分层 · 代理 v6 降为 IPv4:出口此刻落在代理线路(不是直连 / 拒绝;站点集按此刻的选择判,
  // 节点组 / 节点 / 隧道端点都算代理线路)的规则前面插 v6 拒绝(engine/routing.mjs)
  // 站点集(含兜底)此刻的出口类别:和 DNS 分类、入口旁路、选择同步共用同一张表(routing-model.policyClasses)
  const classes = policyClasses(profile.routing, policyMemberTags, builtin, selections)
  const isProxyOutbound = (tag) => {
    if (tag === builtin.direct || tag === builtin.block) return false
    if (Object.prototype.hasOwnProperty.call(classes, tag)) return classes[tag] === 'proxy'
    return true
  }
  const rejectV6For = ipv6ProxyMode(profile) === 'ipv4' ? isProxyOutbound : null
  // 屏蔽 QUIC(档案 rejectQuic,默认开):走代理线路的 UDP 443 拒绝,让浏览器退回 TCP(engine/routing.mjs)
  const rejectQuicFor = profile.rejectQuic === true ? isProxyOutbound : null
  // groupTags 传给 DNS:它要按"这个站点集默认走哪"决定用直连还是代理侧解析,
  // 而"默认走哪"在 default 为空时取决于成员表的第一项(见 effectiveOutbound)。
  // 预解析(engine/routing.mjs 的 preResolveRules)本轮不进正式配置:收尾验收复现了它的回归——兜底那条无条件
  // resolve 会先于排在 IP 规则前面的域名规则执行,直连解析器对只有节点认得的域名回 NXDOMAIN 时连接被终止。
  // 解析器映射先不交给路由(留待后续方案验证),以域名进内核的连接仍按"没有真实目标 IP"处理
  const filtering = buildFilterConfig(profile, dnsFilter)
  // auto_redirect 自带 nft 层的 DNS 劫持(局域网发往任何 53 端口的查询都改写进 tun),关不掉劫持只留 redirect;所以 DNS
  // 「禁用」模式只能把它一起关掉,流量靠 auto_route 进 tun(tun 入站那边的详细说明见下)
  const autoRedirect = Boolean(profile.tun && profile.tun.autoRedirect && dnsMode !== 'off')
  // 终端分流里「直连」「不进内核」的终端:解析由内核按终端答(engine/client-routes.mjs 的 terminalDnsRedirected);「直连」终端
  // 和订阅和节点站点直连的地址,连接在首包预判时照规则放行(engine/routing.mjs 的 preMatchBypassRules)。都只在有 nft 重定向时
  // 成立;「直连不进内核」关掉时所有流量进内核,这些也不放行
  const directBypass = profile.directBypass !== false
  const admitDirect = admitDnsDirect(profile.clientRoutes, { dnsMode, autoRedirect, splitDns: Boolean(profile.dns && profile.dns.split) })
  // 热切换(engine/flip.mjs):站点集此刻走直连还是走代理不写死在配置结构里——按类别分叉的规则两支都写进配置,
  // 挂在开关规则集上,翻面只改写开关文件、不重启内核。所以这份配置的 dns / route / 入站与此刻的选择无关
  const { dns, ruleOwners: dnsRuleOwners } = buildDnsWithResolvers(profile, { systemDns, groupTags, builtin, selections, directHostSets, directHosts: inlineHosts, ruleLists, clientRoutes, knownOutbounds, filterRules: filtering.rules, terminalDns: { autoRedirect, directBypass, admitDirect: admitDirect ? DNS_DIRECT_INBOUND_TAG : '' } })
  // 节点专用解析器只给节点出站拨号用(domain_resolver 直接点名),不进 dns.rules,局域网的查询碰不到它们
  if (nodeDns.servers.length) dns.servers.push(...nodeDns.servers)
  // buildRoute 自己归一化档案;传已归一化的对象会丢掉 fallbackName 等原始字段,
  // 导致 route.final 又变成「其他」,与用户改名后的 selector 不一致(GitHub #46)。
  const { route } = buildRoute(profile.routing, rulesetDir, {
    dnsMode, directTag: builtin.direct, blockTag: builtin.block, directHostSets, directHosts: inlineHosts, rejectV6For, rejectQuicFor,
    tunCidrs: ipv6InTun(profile) ? [TUN_V4_NET, TUN_V6_NET] : [TUN_V4_NET],
    dnsmasqTag: dnsMode === 'dnsmasq' ? DNSMASQ_OUTBOUND_TAG : '',
    clientRoutes,
    knownOutbounds,
    // 规则集链接各自有没有域名 / IP 那份 .srs(见 system/rule-lists.mjs)
    ruleLists,
    preMatchBypass: autoRedirect && directBypass,
    dnsDirectInbound: admitDirect ? DNS_DIRECT_INBOUND_TAG : '',
  })
  if (filtering.sets.length) route.rule_set = [...(route.rule_set || []), ...filtering.sets]
  if (directHostSets) route.rule_set = [...(route.rule_set || []), ...nodeDirectRuleSets(rulesetDir)]
  // 每个站点集(含兜底)一个开关规则集,source 格式、免编译;文件由部署 / 翻面流程写(system/flip-files.mjs)
  const flipDir = flipDirOption || flipDirFor(rulesetDir)
  const flagEntries = [...new Set(flipFlagMap(normalizeRouting(profile.routing)).values())].map((tag) => ({ type: 'local', tag, format: 'source', path: `${flipDir}/${tag}.json` }))
  route.rule_set = [...(route.rule_set || []), ...flagEntries]

  // IPv6「不进内核」模式(engine/dns.mjs 的 ipv6ProxyMode = bypass):tun 不给 v6 地址,auto_route 就不接管 v6,
  // 局域网的 v6 按系统路由直接从 WAN 出去;防火墙那条 v6 拦截只在 ipv6 关着时加(system/deploy.mjs)
  const v6InTun = ipv6InTun(profile)
  const tunAddress = v6InTun ? [TUN_V4, TUN_V6] : [TUN_V4]

  // auto_redirect(上面算好的 autoRedirect)自带 nft 层的 DNS 劫持(局域网发往任何 53 端口的查询都改写进 tun),
  // 关不掉劫持只留 redirect;所以 DNS「禁用」模式只能把它一起关掉,流量靠 auto_route 进 tun。
  // 本机接口网段只在「auto_redirect + 劫持模式」下才从排除表里挖出来:挖它是为了 nft 里 DNS 改写
  // 规则能碰到发给路由器的查询(劫持模式靠这个把局域网 DNS 拦进内核),而 nft 另有 local_address_set
  // 的 return 保证这些网段不进 tun。dnsmasq 转发模式不需要:局域网的查询本来就该直接到 dnsmasq,
  // 挖掉只会让每个查询先被改写进 tun、再由内核送回本机 dnsmasq 绕一圈(审核 A2);不挖,发给
  // 路由器的查询在入口就 return,根本不进内核。
  // 没有 auto_redirect 时只剩路由规则(strict_route),排除表就是唯一的"本机网段不进 tun"
  // 依据——挖掉之后路由器回给局域网的每个包都被路由进 tun 吞掉,LuCI / 面板 / DNS 全部失联,
  // 重启后内核自启立刻复现(v0.1.65–v0.1.70 的「禁用」模式,正式路由器和开发路由器都实测)。
  const holes = autoRedirect && dnsMode === 'hijack' ? [...localSubnets, TUN_V4_NET, TUN_V6_NET] : [TUN_V4_NET, TUN_V6_NET]
  // FakeIP 的 v6 占位段 fc00::/18 落在排除表的 fc00::/7 里,不挖出来的话走代理域名的 v6 连接在入口就被
  // 放走了(v4 的 198.19.0.0/16 不在排除表里,不用挖)
  const fakeIp = dnsFakeIpEnabled(profile)
  if (fakeIp && ipv6ProxyMode(profile) === 'node') holes.push(FAKEIP_V6)
  // 用户明确要送去节点的私网段(前置自定义分流的 ip_cidr 行,出口不是直连 / 拒绝)也要挖出来:
  // 不然 10.77.0.0/16 → 节点 这种规则被排除表的 10.0.0.0/8 在入口先放走,永远到不了那条规则
  // (审核 B5,经 WireGuard 访问对端局域网的典型写法)。和排除表有交集的都算——规则比排除段
  // 小(10.77/16 在 10/8 里)和规则比排除段大(10.0.0.0/7 盖住 10/8)是一回事(复审 R6b)。
  // 但本机接口网段、tun 自己的网段、回环、链路本地永远不能被挖走:纯 tun 模式下排除表是唯一的
  // "本机网段不进 tun"依据,10.0.0.0/8 → 节点 这种规则挖掉整个 10/8,路由器回给 10.0.0.x 局域网的
  // 包就全被吞进 tun、面板 / SSH / DNS 失联(复审 R6a)。所以从规则里先扣掉这些保护段,只挖剩下的
  const excludeBase = v6InTun ? [...TUN_EXCLUDE_V4, ...TUN_EXCLUDE_V6] : TUN_EXCLUDE_V4
  const protectedSubnets = [...localSubnets, TUN_V4_NET, TUN_V6_NET, '127.0.0.0/8', '169.254.0.0/16', '::1/128', 'fe80::/10']
  if (customPolicyActive(routingConf.custom)) {
    for (const rule of routingConf.custom.rules) {
      if (rule.type !== 'ipCidr' || !parseCidr(rule.value)) continue
      const target = customOutboundTag(rule, builtin)
      if (target === builtin.direct || target === builtin.block || !knownOutbounds.has(target)) continue
      if (!excludeBase.some((base) => cidrsOverlap(base, rule.value))) continue
      holes.push(...subtractCidrs([rule.value], protectedSubnets))
    }
  }
  const routeExclude = subtractCidrs(excludeBase, holes)
  const tunInbound = {
    // 接口名固定成自己的:防火墙放行规则按名字写;不用 tun0——OpenVPN / ZeroTier / 残留的旧实例占着 tun0 时
    // 内核起不来(TUNSETIFF: device or resource busy,GitHub #109)。Linux 接口名最长 15 字符
    type: 'tun', interface_name: TUN_INTERFACE_NAME, tag: 'tun-in', address: tunAddress,
    // 单栈 tun + strict_route 会在 nft / ip rule 层拒绝未接管的地址族。
    // bypass 要让原生 IPv6（含 DHCPv6、RA）继续按系统路由走;其余模式保留严格路由。
    // 协议栈 / MTU 按后端设置(engine/tun-options.mjs;MT6000 有线口直连坏字节要选 gvisor,GitHub #236)
    auto_route: true, strict_route: ipv6ProxyMode(profile) !== 'bypass', stack: tunStack(profile),
    ...(tunMtu(profile) ? { mtu: tunMtu(profile) } : {}),
    route_exclude_address: autoRedirect ? subtractCidrs(routeExclude, END_OF_ADDRESS_SPACE) : routeExclude,
    udp_timeout: TUN_UDP_TIMEOUT,
  }
  if (autoRedirect) tunInbound.auto_redirect = true
  // 「不进内核」的终端(engine/client-routes.mjs 的 bypassSources):按 MAC 的在 nft 入口就排除,流量根本不进 tun——
  // sing-box 1.14 起的 exclude_mac_address,只在 auto_route + auto_redirect 下有效;按 IP 的由部署写进 inet openbox 表
  // 打标记(system/entry-bypass.mjs)。纯 tun 兼容模式下这些终端按直连的路由规则走
  const bypassMacs = bypassSources(profile.clientRoutes).macs
  if (autoRedirect && bypassMacs.length) tunInbound.exclude_mac_address = bypassMacs
  // 「只让这些终端进内核」(engine/client-routes.mjs 的 admitSources,白名单):同样只在 auto_redirect 下有效。
  // 只有按 MAC 的才用内核原生的 include_mac_address;有按 IP 的整个交给 nft(连同 MAC 一起判,见 entry-bypass.mjs)。
  // sing-tun 先按 include 挡掉名单外的终端,再按上面的 exclude 挡,两样都写了时名单里又被标成不进内核的,照样不进
  const admit = admitSources(profile.clientRoutes)
  if (autoRedirect && admit.macs.length && !admit.ips.length) tunInbound.include_mac_address = admit.macs
  // sing-box 1.14 起 tun 自己管 DNS 接管(dns_mode,缺省 hijack):auto_redirect 下 nft 把 53 端口 DNAT 到 dns_address;
  // 没有 auto_redirect 时另加一条 ip rule 把发往直连网段的 53 端口流量强行送进 tun——后者是 1.13 没有的行为,
  // 不写这个字段就会悄悄多出来。所以:开着 auto_redirect 的劫持 / dnsmasq 模式明确写 hijack,DNAT 目标写死成
  // tun 对端(和 1.13 隐含的一样),这样改写后的查询照旧经路由规则处理——劫持模式由 {protocol:'dns'} 接住,
  // dnsmasq 模式由 engine/routing.mjs 那条 override 交回本机 dnsmasq;dns_address 不写的话 1.14 会把发到对端的
  // 连接直接交给 DNS 模块、越过路由规则,dnsmasq 那一层就被绕开了。「禁用」模式和没有 auto_redirect 的兜底路径
  // (system/deploy.mjs 在 nft 失败时关掉 auto_redirect 重生成)一律 disabled:1.13 在这两种情况下本来就什么都不劫持
  if (autoRedirect && dnsMode !== 'off') {
    tunInbound.dns_mode = 'hijack'
    tunInbound.dns_address = v6InTun ? [TUN_V4_PEER, TUN_V6_PEER] : [TUN_V4_PEER]
  } else {
    tunInbound.dns_mode = 'disabled'
  }
  // 第一层 · 入口原生旁路:此刻走直连的站点集里的 geoip 集合(geoip-cn 之类)编进
  // route_exclude_address_set——命中的目标在系统入口就旁路,不进内核。开 auto_redirect 时
  // 内核把它们写成 nft 集合;不开时等价于加进 route_exclude_address(1.11 起)。条件和
  // 原因见 routing-model.mjs 的 nativeBypassPlan;不满足时直连目标进内核由 direct 出站连(兼容路径)
  // 部署时会带一份已经做过 IP 集合重叠核对的结果(system/native-bypass.mjs);没带(预览 / 测试)就按纯函数
  // 的保守结论——待核对的集合一律不开
  const bypass = nativeBypass && typeof nativeBypass === 'object'
    ? nativeBypass
    : nativeBypassPlan(profile.routing, { members: policyMemberTags, builtin, selections, clientRoutes, fakeIp, dnsMode, enabled: profile.directBypass !== false })
  if (autoRedirect) {
    // 有 nft 重定向:入口旁路是静态候选表——所有生效站点集引用到的 geoip-*,各配一份内容可换的动态集
    // (「满」= 原集合的拷贝,「空」= 占位地址)。哪几份此刻是满的由部署 / 翻面流程按核对过的旁路结论写文件,
    // 这里的列表不随类别变。站点集自己的路由规则仍引用原来的 geoip-*。
    // 没有 nft 重定向(纯 tun)时集合是编进路由表的,没验证过能在线换:维持下面的静态写法,旁路变了就回到重启
    const candidates = flipBypassCandidates(normalizeRouting(profile.routing))
    if (candidates.length) {
      tunInbound.route_exclude_address_set = candidates.map(flipBypassTag)
      route.rule_set = [...(route.rule_set || []), ...candidates.map((tag) => ({ type: 'local', tag: flipBypassTag(tag), format: 'binary', path: `${flipDir}/${flipBypassTag(tag)}.srs` }))]
    }
    // 白名单那一侧(entryModePlan):"必须进内核"的动态集,和上面的旁路动态集并存——sing-tun 先按
    //   ip daddr != @route_address_set return   (不在必须进内核名单里的放走)
    // 再按 ip daddr @route_exclude_address_set return。黑名单模式时 obflip-need-all 是"全部",这一条等于不存在;
    // 白名单模式时它只剩 ::/0,进内核的就只有 FakeIP 池 + 走代理 / 拒绝的 IP 集合。两种模式之间只换文件,不重启
    const need = [...FLIP_NEED_FIXED, ...candidates.map(flipNeedTag)]
    tunInbound.route_address_set = need
    route.rule_set = [...(route.rule_set || []), ...need.map((tag) => ({ type: 'local', tag, format: 'binary', path: `${flipDir}/${tag}.srs` }))]
  } else if (bypass.enabled && bypass.sets.length) {
    // 纯 tun(没有 nft 重定向,含 auto_redirect 起不来的降级):内核启动时把这些集合展开成路由表的排除项,
    // 不能在线换——旁路变了就重启(api/deploy-runner.mjs 的 applyHotFlip 按计划指纹判)。原样的集合直接引用
    // geoip-*;扣过几段的(trimmed)引用部署时编好的 obflip-byp-* 文件(system/flip-files.mjs 静态模式只写这几份)。
    // 以前这里把裁剪过的整份丢掉,默认配置的 geoip-cn / geoip-private 都是裁剪过的,纯 tun 下等于一份都没旁路(GitHub #225)
    const trimmedTags = bypass.sets.filter((tag) => bypass.trimmed && bypass.trimmed[tag])
    const whole = bypass.sets.filter((tag) => !trimmedTags.includes(tag))
    tunInbound.route_exclude_address_set = [...whole, ...trimmedTags.map(flipBypassTag)]
    if (trimmedTags.length) route.rule_set = [...(route.rule_set || []), ...trimmedTags.map((tag) => ({ type: 'local', tag: flipBypassTag(tag), format: 'binary', path: `${flipDir}/${flipBypassTag(tag)}.srs` }))]
  }

  // 面板「真实路由」测试用的回环入站:面板进程经它发请求,请求才会真的走内核的分流
  // (路由器自身发出的流量不一定进 tun)。只听 127.0.0.1,外面碰不到。
  const inbounds = [tunInbound, { type: 'mixed', tag: PANEL_INBOUND_TAG, listen: '127.0.0.1', listen_port: PANEL_INBOUND_PORT }]
  // 内核 DNS 入站 :7853,三种模式都开、监听所有地址(防火墙只放行 LAN,见 system/firewall.mjs):
  // dnsmasq 模式下 dnsmasq 的上游指向它;局域网里的 AdGuard Home / Pi-hole 也可以把上游指向
  // <路由器 IP>:7853 用内核的分流解析——尤其是「禁用」模式,不劫持任何 DNS,但把入口留着。
  // 此前只在 dnsmasq 模式开、且只听 127.0.0.1,用户在禁用模式下把 AdGuard 上游指到 7853,
  // 整个局域网的 DNS 就死了(正式路由器实测)。
  // 开了 IPv6 就双栈监听(AdGuard 用路由器的 v6 地址当上游时才到得了);'::' 在 sing-box 里同时收 v4
  inbounds.push({ type: 'direct', tag: 'dns-in', listen: profile.ipv6 ? '::' : '0.0.0.0', listen_port: DNS_INBOUND_PORT })
  // 「只让这些终端进内核」名单外终端的查询(入口转过来,system/entry-bypass.mjs):这里的一律直连解析,给真实地址
  if (admitDirect) inbounds.push({ type: 'direct', tag: DNS_DIRECT_INBOUND_TAG, listen: profile.ipv6 ? '::' : '0.0.0.0', listen_port: DNS_DIRECT_INBOUND_PORT })
  // 共享网络:用户在设置里开的服务器入站(engine/servers.mjs)
  const shareInbounds = buildServerInbounds(profile.servers, tlsCert)
  inbounds.push(...shareInbounds)
  // 终端分流 / 「不进内核」按来源认终端的路由、DNS 规则不管从共享网络入站进来的连接(engine/client-routes.mjs 的 guardTerminalRules)
  const shareTags = shareInbounds.map((i) => i.tag)
  route.rules = guardTerminalRules(route.rules, shareTags)
  if (dns.rules) dns.rules = guardTerminalRules(dns.rules, shareTags)

  const config = {
    log: { level: 'warn' },
    dns,
    inbounds,
    outbounds,
    route,
    experimental: {
      clash_api: { external_controller: '127.0.0.1:9095', secret: profile.clashApiSecret },
      // 记住每个 selector 的选择:没有它,内核每次重启(包括面板里的「重启」)都会把站点集
      // 和手动组重置回配置里的默认项,用户在代理页选好的线路全部丢掉。文件放在 data/ 下,
      // 重新部署面板不会碰它。
      // FakeIP 开着时占位地址 ↔ 域名的映射也要落盘:重启后客户端缓存里的占位地址还能找回域名
      cache_file: { enabled: true, path: fakeIp ? fakeIpCachePath(cacheFilePath) : cacheFilePath, store_fakeip: fakeIp },
    },
  }
  // 换池首次使用新的缓存文件时，把当前选择写为默认值，保留站点集和手动组的出口。
  if (fakeIp) {
    for (const outbound of outbounds) {
      const selected = selections[outbound.tag]
      if (outbound.type === 'selector' && outbound.outbounds.includes(selected)) outbound.default = selected
    }
  }
  if (endpoints.length) config.endpoints = endpoints
  // directHosts:订阅和节点站点直连两份规则集文件的内容(system/node-direct-files.mjs 写),关着时是 null
  // failover:故障转移的运行映射(父组 / 页签 / 有效节点 / 子组 tag),和上面的出站同一次生成(含链式节点),写进 config.meta.json
  return { config, dnsRuleOwners, directHosts, failover }
}
// 生成配置本体;dnsRuleOwners(每条 DNS 规则归哪个站点集)另带一份给部署写进元数据(见 buildConfigDetailed)
export const buildConfig = (options) => buildConfigDetailed(options).config
