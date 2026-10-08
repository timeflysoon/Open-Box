import { randomBytes } from 'node:crypto'
import { CN_DIRECT_POLICY_SEED, migrateStoredRouting } from '../engine/routing-model.mjs'
import { DEFAULT_DNS_PORT, DEFAULT_PROXY_UPSTREAM, DNS_REGIONS, WAN_UPSTREAM, isDnsProtocol, isValidDnsPort, isWanUpstream, normalizeDnsUpstream } from '../engine/dns-upstream.mjs'
import { defaultGroups, normalizeGroups } from '../engine/user-groups.mjs'
import { DEFAULT_DIRECT_TEST_URL, DEFAULT_TEST_URL } from '../engine/test-url.mjs'
import { normalizeChainProxies } from '../engine/chain-proxy.mjs'

export const KEYS = {
  profile: 'openbox/profile',
  subscriptions: 'openbox/subscriptions',
  subscriptionShares: 'openbox/subscription-shares',
  nodes: 'openbox/nodes',
  groups: 'openbox/groups',
  deployState: 'openbox/deploy-state',
  clashSecret: 'openbox/clash-secret',
  // 内核里各 selector 当前选的线路的快照(system/scheduler.mjs 每分钟刷新)
  // 必须带 openbox/ 前缀:index.mjs 的 isProtectedStorageKey 只认这个前缀,浏览器每次
  // 同步设置(PUT /api/storage)会把不受保护的键整个清掉——以前用点号,快照每次都被删
  selections: 'openbox/selections',
}

export const DEFAULT_PROFILE = {
  // 默认关掉 IPv6:关掉的含义是 DNS 只解析 A 记录(strategy=ipv4_only)、tun 不给
  // v6 地址、并在防火墙上 REJECT 掉 lan→wan 的 v6——也就是干脆不走 IPv6,免得它绕开
  // 隧道直连出去。要用 v6 的人在「其他」页签里自己打开。
  ipv6: false,
  // IPv6 开着时,走代理的目标怎么处理(engine/dns.mjs 的 ipv6ProxyMode):
  //   node:v6 目标和 v4 一样交给节点(老行为);
  //   ipv4:走代理的域名不给 AAAA(终端自然用 v4),裸 v6 目标要走代理时在内核里明确拒绝——
  //        代理线路不支持 v6 时用它,直连的 v6 照常。
  //   bypass:v6 根本不进内核,按系统路由直接从 WAN 出去(OpenClash / DAE 的默认行为,GitHub #36)。
  ipv6Proxy: 'node',
  // 订阅链接和节点服务器的地址一律直连,不看站点集(engine/direct-hosts.mjs)
  directForNodes: true,
  // 屏蔽 QUIC(GitHub #163):走代理线路的 UDP 443 在内核里拒绝,浏览器退回 TCP(engine/routing.mjs)。
  // 2026-09-24 起默认开(用户定的:OpenWrt / Debian 都一样)。键从 blockQuic 改成 rejectQuic:档案每次保存都会把默认值
  // 一起落库,老键在所有机器上都已经是显式的 false,只改默认值到不了它们;换个键名,老键退役删掉,新默认值才对所有人生效
  rejectQuic: true,
  // 直连不进内核(默认开):入口旁路 / 默认放行 / 直连应答放行整套开关。关掉后所有流量进内核,连接页和流量统计
  // 才看得到直连流量,代价是直连也要过一遍用户态转发(engine/routing-model.mjs 的 entryModePlan / nativeBypassPlan)
  directBypass: true,
  // 进内核前放行的端口(GitHub #183):「21114-21119, 2233」这样的写法,空 = 不放行(system/entry-bypass.mjs)。
  // 黑名单、白名单各存一份,只有 bypassPortsMode 选中的那份生效(system/entry-bypass.mjs 的 activeBypassPorts);
  // 以前两种模式共用 bypassPorts 一份,切到白名单时黑名单里的端口原样变成「只有这些进内核」
  bypassPorts: '',
  bypassPortsWhitelist: '',
  // 端口名单怎么用:blacklist=名单上的放行(默认、老行为),whitelist=只有名单上的进内核(#198 / #199)
  bypassPortsMode: 'blacklist',
  // stack / mtu / tcpMss:后端设置 → TUN 参数(engine/tun-options.mjs;GitHub #236 #239)。0 = 内核默认 / 不钳制
  tun: { autoRedirect: true, stack: 'mixed', mtu: 0, tcpMss: 0 },
  // 共享网络:本机开的服务器入站(engine/servers.mjs),默认没有
  servers: [],
  // 终端分流:按局域网来源 IP 指定出口(engine/client-routes.mjs),默认没有
  clientRoutes: [],
  // mode:off 不碰 DNS / hijack 防火墙劫持 / dnsmasq 转发(默认;见 engine/dns.mjs 与 system/dns-takeover.mjs)
  // direct / proxy:直连侧 / 代理侧解析器的上游,存裸 IP 或「上游 DNS」记号 wan(系统的上游 DNS);directProtocol /
  // proxyProtocol、directPort / proxyPort 是各自的协议(udp / tcp)和端口(engine/dns-upstream.mjs)。默认直连用上游 DNS、
  // 代理用经代理查的 TCP 1.1.1.1(用户 2026-10-02)。region:路由器在中国大陆(cn)还是中国大陆之外(intl),决定两侧的默认值、
  // 代理侧能不能用上游 DNS;不在默认值里——没有这个键说明还没判过,启动时按出口公网 IP 判一次(system/router-region.mjs)
  // fakeIpForProxy:走代理的域名不在本地解析,内核回占位地址、连接时把域名交给节点(engine/dns.mjs)。2026-09-24 起默认开
  // (用户定的:OpenWrt / Debian 都一样)。以前不在默认值里,只有手动开过 / 关过的档案才存了这个键,所以直接加默认值就行:
  // 没碰过的机器跟新默认走,明确关掉的还是关
  dns: {
    split: true, mode: 'dnsmasq', fakeIpForProxy: true,
    direct: WAN_UPSTREAM, directProtocol: 'udp', directPort: DEFAULT_DNS_PORT, directExtras: [],
    proxy: DEFAULT_PROXY_UPSTREAM, proxyProtocol: 'tcp', proxyPort: DEFAULT_DNS_PORT,
    // 两侧的备用上游(GitHub #151):和同侧的主上游**并发查**,谁先给出 NOERROR 就用谁的。
    // 一个上游卡住时不用干等到客户端超时。空数组 = 只用主上游,生成的配置和以前一字不差
    proxyExtras: [],
  },
  // 每日流量这些分析数据在库里留多久(月)。面板「后端设置」里可改,1~36。
  // 按正式路由器实测,按天的记录一天大约 0.75MB,3 个月 ≈ 70MB;小时明细另外只留 7 天
  // (见 system/traffic-collector.mjs)
  traffic: { keepMonths: 3 },
  // 测速地址。testUrl 给自动择优(url-test)组和面板的延迟测试用;directTestUrl 只给内置
  // 直连出站用——默认那个是 Google 的域名,从国内直连去测量出来的是"直连到 Google 有多远"。
  // 默认 HTTP，用户可自定义 HTTP / HTTPS 地址(见 engine/test-url.mjs)
  testUrl: DEFAULT_TEST_URL,
  directTestUrl: DEFAULT_DIRECT_TEST_URL,
  // 测速的「可接受状态码」(内核 tcp19,GitHub #482):空 = 什么应答都算通;节点组自己没写时用这个(engine/test-url.mjs)
  testExpectedStatus: '',
  // 自动更新计划(面板进程内的定时器,见 system/scheduler.mjs):默认都关
  // channel 是自动更新走的通道;checkChannel 是卡片上手动「检查更新 / 立即更新」那个下拉框
  // 上次选的通道,记下来免得每次进页面都要重选
  updates: {
    openbox: { auto: false, hour: 4, channel: 'auto', checkChannel: 'auto' },
  },
  routing: {
    // 站点集。一条 = 一组匹配条件 + 内核里一个同名 selector,不记具体节点。
    // 全新安装种一条「国内直连」;档案里一旦有 policies(哪怕是空数组)就以档案为准
    policies: [structuredClone(CN_DIRECT_POLICY_SEED)],
    // 兜底站点集的默认选中项:没被站点集挑走的走代理(人在国内);首次引导选了境外会改成 direct
    fallbackDefault: 'proxy',
  },
}

// 改版前留在档案里、现在没有任何代码再读的顶层字段。读档案时删掉并写回一次(见 cleanupStoredProfile)
// restartOnClassFlip / restartOnFlip:v0.1.207、v0.1.208 ~ v0.1.209 的「直连和代理切换重启内核」开关,v0.1.210 起去掉(一律热切换)
// blockQuic:屏蔽 QUIC 的老键(默认关),2026-09-24 改名 rejectQuic 且默认开,见 DEFAULT_PROFILE 里的说明
const LEGACY_PROFILE_KEYS = ['region', 'rulesetDir', 'restartOnClassFlip', 'restartOnFlip', 'blockQuic']

const DEFAULT_DEPLOY_STATE = { stage: 'idle', message: '', at: 0, badTags: [] }

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// 深合并:普通对象递归合并,数组与其它类型整体替换(patch 优先)。
const deepMerge = (base, patch) => {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const result = { ...base }
  for (const key of Object.keys(patch)) {
    result[key] = deepMerge(base[key], patch[key])
  }
  return result
}

// 存进库里的档案要满足的形状。返回 { profile, changed },changed 为 false 时 profile 就是传进来的对象:
//   · 顶层退役字段(region / rulesetDir)和 updates.geo 删掉
//   · routing 的地区层 / 出站开关 / 广告拦截 / categories 这些老字段翻译成站点集后删掉(engine/routing-model.mjs)
//   · dns.direct / dns.proxy 折成裸地址:老档案存的是 "https://1.1.1.1/dns-query",内核那头只用得上主机名;
//     折不出合法地址的(包括空串)换回默认值;「上游 DNS」记号 wan 原样留着
const cleanupStoredProfile = (stored) => {
  const profile = { ...stored }
  let changed = false
  for (const key of LEGACY_PROFILE_KEYS) {
    if (!(key in profile)) continue
    delete profile[key]
    changed = true
  }
  // 端口名单拆成黑 / 白两份之前(没有 bypassPortsWhitelist 这个键),白名单模式用的是 bypassPorts:挪到白名单那份名下
  if (profile.bypassPortsMode === 'whitelist' && !('bypassPortsWhitelist' in profile) && typeof profile.bypassPorts === 'string' && profile.bypassPorts.trim()) {
    profile.bypassPortsWhitelist = profile.bypassPorts
    profile.bypassPorts = ''
    changed = true
  }
  if (isPlainObject(profile.updates) && 'geo' in profile.updates) {
    profile.updates = { ...profile.updates }
    delete profile.updates.geo
    changed = true
  }
  if (isPlainObject(profile.routing)) {
    const migrated = migrateStoredRouting(profile.routing)
    if (migrated.changed) {
      profile.routing = migrated.routing
      changed = true
    }
  }
  if (isPlainObject(profile.dns)) {
    for (const key of ['direct', 'proxy']) {
      if (!(key in profile.dns) || isWanUpstream(profile.dns[key])) continue
      const host = normalizeDnsUpstream(profile.dns[key])
      if (host && host === profile.dns[key]) continue
      profile.dns = { ...profile.dns, [key]: host || DEFAULT_PROFILE.dns[key] }
      changed = true
    }
    // 协议 / 端口 / 地区字段不合法的值(手改库 / 撤掉过的协议)删掉,读出来时由默认值补(地区没有默认值,按中国大陆算)
    for (const [key, ok] of [['directProtocol', isDnsProtocol], ['proxyProtocol', isDnsProtocol], ['directPort', isValidDnsPort], ['proxyPort', isValidDnsPort], ['region', (v) => DNS_REGIONS.includes(v)]]) {
      if (!(key in profile.dns) || ok(profile.dns[key])) continue
      profile.dns = { ...profile.dns }
      delete profile.dns[key]
      changed = true
    }
  }
  return { profile, changed }
}

// 所有 JSON 解析统一走这里:损坏数据回退到 fallback,而不是抛错拖垮整个面板。
const parseJsonOr = (raw, fallback) => {
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

const defaultRandomHex = () => randomBytes(16).toString('hex')

// platform(system/platform.mjs):Debian / Ubuntu(systemd)没有 dnsmasq 可接管,档案里的 dnsmasq 分流一律按劫持读——
// 默认档案就是 dnsmasq,不翻译的话新装的 Debian 机器第一次部署就去调 uci。翻译只在读取时做,不改库里的值
export const createStore = ({ get, set, del }, { randomHex = defaultRandomHex, platform = 'openwrt' } = {}) => {
  void del // 当前接口未暴露删除操作,保留注入以便未来使用/测试对称性。

  // 档案 / 节点组 / 订阅 / 节点写过之后通知订阅者(api/hot-apply.mjs:能不重启就生效的改动——节点、节点组、链式代理——
  // 由它在后台热替换进内核)。回调里的异常不影响写库本身
  const listeners = new Set()
  const notify = (what) => {
    for (const fn of listeners) {
      try { fn(what) } catch { /* 订阅者自己的问题 */ }
    }
  }

  // 读档案:老字段翻译 / 删掉之后有变化就写回一次,之后每次读都是干净的;再盖上默认值
  const getProfile = () => {
    const stored = parseJsonOr(get(KEYS.profile), {})
    const { profile: cleaned, changed } = cleanupStoredProfile(isPlainObject(stored) ? stored : {})
    if (changed) set(KEYS.profile, JSON.stringify(cleaned))
    const merged = deepMerge(structuredClone(DEFAULT_PROFILE), cleaned)
    if (platform === 'systemd' && merged.dns && merged.dns.mode === 'dnsmasq') merged.dns.mode = 'hijack'
    return merged
  }

  // 写档案:patch 可能来自老版本的备份文件,带着退役字段和 DoH 写法的上游。patch 先自己整理一遍再合并——
  // 老备份里的地区数据要靠"没有 fallbackDefault"才翻译得出来,合并进现有档案(已有 fallbackDefault)之后就翻不出来了
  const setProfile = (patch) => {
    const { profile: cleanPatch } = cleanupStoredProfile(isPlainObject(patch) ? patch : {})
    // 链式代理:存库前去空白、按节点内容重算摘要(界面列表显示用,不信客户端传来的)
    if (Array.isArray(cleanPatch.chainProxies)) cleanPatch.chainProxies = normalizeChainProxies(cleanPatch.chainProxies)
    const { profile: merged } = cleanupStoredProfile(deepMerge(getProfile(), cleanPatch))
    set(KEYS.profile, JSON.stringify(merged))
    notify('profile')
    return merged
  }

  const getSubscriptions = () => {
    const raw = get(KEYS.subscriptions)
    const stored = parseJsonOr(raw, [])
    return Array.isArray(stored) ? stored : []
  }

  const setSubscriptions = (list) => {
    set(KEYS.subscriptions, JSON.stringify(Array.isArray(list) ? list : []))
    notify('subscriptions')
  }

  const getSubscriptionShares = () => {
    const raw = get(KEYS.subscriptionShares)
    const stored = parseJsonOr(raw, [])
    return Array.isArray(stored) ? stored : []
  }

  const setSubscriptionShares = (list) => {
    set(KEYS.subscriptionShares, JSON.stringify(Array.isArray(list) ? list : []))
  }

  const getNodes = () => {
    const raw = get(KEYS.nodes)
    const stored = parseJsonOr(raw, [])
    return Array.isArray(stored) ? stored : []
  }

  const setNodes = (list) => {
    set(KEYS.nodes, JSON.stringify(Array.isArray(list) ? list : []))
    notify('nodes')
  }

  const getDeployState = () => {
    const raw = get(KEYS.deployState)
    const stored = parseJsonOr(raw, DEFAULT_DEPLOY_STATE)
    return deepMerge(DEFAULT_DEPLOY_STATE, isPlainObject(stored) ? stored : {})
  }

  const setDeployState = (s) => {
    set(KEYS.deployState, JSON.stringify(s))
  }

  // 内核跑着的时候从 clash API 读到的「每个 selector 现在选的是谁」。内核没在跑时
  // (升级脚本停掉内核后用户点启动、开机自启)拿它生成 DNS 规则,不然所有站点集都
  // 会按配置里的默认项判直连/代理,和内核用 cache_file 恢复出来的实际选择对不上。
  const LEGACY_SELECTIONS_KEY = 'openbox.selections'
  const getSelectionsSnapshot = () => {
    let raw = get(KEYS.selections)
    if (raw === null || raw === undefined) {
      // 旧键名的快照搬到新键下(能搬到就搬,搬不到也无妨:那份多半早被清空了)
      const legacy = get(LEGACY_SELECTIONS_KEY)
      if (legacy !== null && legacy !== undefined) {
        set(KEYS.selections, legacy)
        del(LEGACY_SELECTIONS_KEY)
        raw = legacy
      }
    }
    const stored = parseJsonOr(raw, {})
    return isPlainObject(stored) ? stored : {}
  }
  const setSelectionsSnapshot = (map) => {
    set(KEYS.selections, JSON.stringify(isPlainObject(map) ? map : {}))
    // 内核在跑时每分钟都是直接写新快照、不经过 get,旧键名那份要顺手清掉
    if (get(LEGACY_SELECTIONS_KEY) !== null && get(LEGACY_SELECTIONS_KEY) !== undefined) del(LEGACY_SELECTIONS_KEY)
  }

  const getClashSecret = () => {
    const existing = get(KEYS.clashSecret)
    if (typeof existing === 'string' && existing) return existing
    const generated = randomHex()
    set(KEYS.clashSecret, generated)
    return generated
  }

  // 用户自定义节点组。第一次读取时落地两个默认组(所有-自动 / 所有-手动)并写回,
  // 这样"默认值"只在这里定义一次,前端拿到的永远是真实存在的记录,而不是靠界面
  // 自己临时编两条出来。
  const getGroups = () => {
    const raw = get(KEYS.groups)
    if (raw) {
      try {
        const list = JSON.parse(raw)
        if (Array.isArray(list)) return normalizeGroups(list)
      } catch { /* 落到下面的默认值 */ }
    }
    const seeded = normalizeGroups(defaultGroups())
    set(KEYS.groups, JSON.stringify(seeded))
    return seeded
  }
  const setGroups = (list) => {
    set(KEYS.groups, JSON.stringify(normalizeGroups(Array.isArray(list) ? list : [])))
    notify('groups')
  }

  return {
    getProfile,
    setProfile,
    getGroups,
    setGroups,
    getSubscriptions,
    setSubscriptions,
    getSubscriptionShares,
    setSubscriptionShares,
    getNodes,
    setNodes,
    getDeployState,
    setDeployState,
    getSelectionsSnapshot,
    setSelectionsSnapshot,
    // 裸键读写:给部署锁这类"进程间协调"用,键必须带 openbox/ 前缀才不会被设置同步清掉
    getRaw: (key) => get(key),
    setRaw: (key, value) => set(key, value),
    delRaw: (key) => del(key),
    getClashSecret,
    onChange: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
