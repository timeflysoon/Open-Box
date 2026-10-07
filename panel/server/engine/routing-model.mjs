import { createHash } from 'node:crypto'
import { dnsmasqSafeDomain } from './dns-names.mjs'
import { RULE_LIST_IP_SUFFIX, isRuleListTag, listTagForUrl, ruleListIpTag } from './rule-list.mjs'
import { stripShareGuardText } from './client-routes.mjs'
// 分流模型的归一化与老档案迁移。
//
// 现在只有一层:**站点集**。一个站点集 = 一组匹配规则 + 内核里一个同名 selector,
// 走哪条线路由用户在代理页点选(成员由「出站」页签决定:直连/节点组/拒绝)。
// 站点集按顺序匹配,首条命中生效。
//
// 最后固定跟一个系统生成的兜底站点集「其他」:上面都没命中的流量走它。它必须存在
// ——内核的 route.final 得指向某个出站——所以它不在 policies 里,由这里合成,
// 界面上也删不掉、拖不动。
//
// 改版前是两层:
//   地区分流(regionMode) —— 路由器本身在哪。它决定"没被策略挑走的流量"往哪走:
//     CN    中国大陆:geosite-cn/geoip-cn 直连,其余走代理
//     HKMO  香港澳门:只有策略挑走的走代理,其余全部直连
//     OTHER 其他地区:geosite-cn/geoip-cn 走代理(回国),其余直连
//   策略分流(policies) —— 一条策略就是一组匹配条件 + 内核里一个同名 selector。
//     策略里不指定具体节点:selector 的成员由「出站」页签决定(直连/节点组/拒绝),
//     用户在代理页点选,和 Clash 的用法一致。
//
// 这个模块只做"读出来归一化",不写回库:store 的 deepMerge 只能覆盖键、不能删键
// (见 store/openbox-store.mjs),硬清空老字段反而会让降级回旧版本的人丢数据。
// 老档案(categories/directRulesets/fallback)在这里翻译成新模型,行为保持不变。

// 中国大陆那两个规则集,三个内置地区都用得到,只是去向不同
export const CN_RULESETS = Object.freeze(['geosite-cn', 'geoip-cn'])

// 一条地区规则:类型 + 值 + 动作。顺序即匹配顺序(内核首条命中生效),所以它是数组
// 不是几个按类型分开的桶——把 geosite-cn 排在某条 domain 前面还是后面,结果是不同的。
// 类型对到 sing-box 的字段:
//   geosite/geoip → rule_set(值 cn 存成 geosite-cn,官方规则集就这两个前缀)
//   domain        → domain(完全匹配)
//   domainSuffix  → domain_suffix(域名本身和它的子域)
//   ipcidr        → ip_cidr
export const REGION_RULE_TYPES = Object.freeze(['geosite', 'geoip', 'domain', 'domainSuffix', 'ipcidr'])
export const REGION_RULE_ACTIONS = Object.freeze(['direct', 'proxy'])

// 内置的三个地区。它们只是"预置的几条",用户可以改、可以删、可以自己加(比如日本:
// geosite-jp 直连、其余走代理),所以存的是数据而不是三个写死的分支。
//   rules     按顺序匹配的规则表
//   catchAll  一条都没命中的流量走哪(direct / proxy)
const cnRules = (action) => [
  { type: 'geosite', value: 'cn', action },
  { type: 'geoip', value: 'cn', action },
]
const BUILTIN_REGIONS = Object.freeze([
  { id: 'cn', name: '中国大陆', rules: cnRules('direct'), catchAll: 'proxy' },
  { id: 'hkmo', name: '香港澳门', rules: [], catchAll: 'direct' },
  { id: 'other', name: '其他地区', rules: cnRules('proxy'), catchAll: 'direct' },
])

// 内网直连那几条(127.0.0.0/8、10.0.0.0/8 ……)不放进这张表:生成配置时固定写在
// 所有规则之前(见 engine/routing.mjs 的 ip_is_private),用户删不掉也不用管。

// 内置的 NTP 对时直连(见 engine/routing.mjs 生成它的地方)。规则页认归属(engine/rule-owner.mjs)
// 按同一个形状认,两边从这里取,不各写一份
export const ntpDirectRule = (directTag) => ({ network: 'udp', port: [123], outbound: directTag })
export const isNtpDirectRule = (rule) =>
  Boolean(rule) && rule.network === 'udp' && Array.isArray(rule.port) && rule.port.length === 1 && Number(rule.port[0]) === 123 &&
  rule.port_range === undefined && Object.keys(rule).every((k) => ['network', 'port', 'outbound', 'action'].includes(k))

// 老字段 regionMode 到内置地区的对照,用来迁移改版初期存下的那一版档案
const REGION_MODE_TO_ID = { CN: 'cn', HKMO: 'hkmo', OTHER: 'other' }

// 「拒绝」在内核里是一个 block 出站。sing-box 1.13.14 实测:block 出站能过 check,
// 而 selector 的成员必须非空(空 outbounds 直接 FATAL: missing tags)。
export const REJECT_TAG = 'block'

// 兜底站点集:上面都没命中的流量。名字直接当内核里的出站 tag 用,所以它是数据
// 不是文案(改名会让代理页上原来的选择对不上号)。图标是彩色地球。
export const FALLBACK_TAG = '其他'
export const FALLBACK_ICON = 'globe:earth-meridians'

// 前置自定义分流:固定置顶、删不掉的一条,排在所有站点集之前(所以叫"前置")。
// 和站点集的区别是**每条规则各自带一个出口**:站点集是内核里的一个同名 selector,整个集
// 共用一条线路、成员还只能是节点组,走哪条由用户在代理页点选;这里一行就是一条规则,
// 每行自己选出口,而且能选到具体节点。一行 → 内核里一条 route 规则,按行的先后匹配。
// 它单独存在 routing.custom 里而不是混进 policies:混进去就得靠标记位防删、防拖动,
// 单独存一份天然删不掉。
export const CUSTOM_POLICY_NAME = '前置自定义分流'
// 默认图钉:它固定钉在最前面,和兜底那条的彩色地球一样,是"这条不是你建的"的标记。
// 和名字一样可以改(界面上的东西,不进内核配置)。
export const CUSTOM_POLICY_ICON = 'misc:pin'

// 一行能写哪几种条件。和站点集编辑器里的那几档一一对应:
//   geosite/geoip  官方规则集(值写 cn,存下去是 geosite-cn)
//   ruleUrl        规则集链接(部署时下回来编译)
//   ruleset        老档案里可能出现的、不带前缀的规则集名
//   port           目标端口(只有前置自定义分流有:放行 WireGuard 的 51820 之类,GitHub #2)
export const CUSTOM_RULE_TYPES = Object.freeze([
  'domainSuffix', 'domain', 'domainKeyword', 'ipCidr', 'geosite', 'geoip', 'ruleUrl', 'ruleset', 'port',
])

// 端口这一档的值:「51820」「1000-2000」,多个用逗号隔开。拆成 sing-box 的 port / port_range
// 两个字段(范围写法是 "1000:2000");有一个写错整行不要,返回 null
export const parsePortSpec = (value) => {
  const port = []
  const port_range = []
  const tokens = String(value || '').split(/[,\s]+/).filter(Boolean)
  if (!tokens.length) return null
  const inRange = (n) => Number.isInteger(n) && n >= 1 && n <= 65535
  for (const token of tokens) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(token)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    if (!inRange(a) || !inRange(b) || a > b) return null
    if (a === b) port.push(a)
    else port_range.push(`${a}:${b}`)
  }
  const spec = {}
  if (port.length) spec.port = port
  if (port_range.length) spec.port_range = port_range
  return spec
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0
const strList = (v) => (Array.isArray(v) ? v.filter(isNonEmptyString).map((s) => s.trim()) : [])

const TARGETS = ['direct', 'proxy']

// 规则集 tag:geosite/geoip 两类规则要下载对应的 .srs,其余类型没有 tag
export const regionRuleTag = (rule) =>
  rule.type === 'geosite' || rule.type === 'geoip' ? `${rule.type}-${rule.value}` : ''

const normalizeRegionRule = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  if (!REGION_RULE_TYPES.includes(raw.type)) return null
  if (!isNonEmptyString(raw.value)) return null
  return {
    type: raw.type,
    value: raw.value.trim(),
    action: REGION_RULE_ACTIONS.includes(raw.action) ? raw.action : 'direct',
  }
}

// 改版前的地区形状:一组规则集 + 它们走哪(target) + 其余走哪(fallback)。
// 翻译成规则表,行为不变。
const migrateRegionRules = (raw) => {
  const target = TARGETS.includes(raw?.target) ? raw.target : 'direct'
  return strList(raw?.rulesets).map((tag) => {
    const type = tag.startsWith('geoip-') ? 'geoip' : 'geosite'
    const value = tag.startsWith(`${type}-`) ? tag.slice(type.length + 1) : tag
    return { type, value, action: target }
  })
}

export const normalizeRegion = (raw, index = 0) => ({
  id: isNonEmptyString(raw?.id) ? raw.id.trim() : `region-${index}`,
  name: isNonEmptyString(raw?.name) ? raw.name.trim() : `地区-${index + 1}`,
  rules: Array.isArray(raw?.rules)
    ? raw.rules.map(normalizeRegionRule).filter(Boolean)
    : migrateRegionRules(raw),
  catchAll: TARGETS.includes(raw?.catchAll)
    ? raw.catchAll
    : TARGETS.includes(raw?.fallback)
      ? raw.fallback
      : 'proxy',
})

export const normalizePolicy = (raw, index = 0) => {
  // 规则集链接:存的是网址,部署时下回来编成 <listTagForUrl(url)>.srs(见
  // system/rule-lists.mjs)。这里就把它折算成规则集名字并进 rulesets——下游的路由规则、
  // DNS 规则、域名穿透一律按"这个站点集引用了哪些规则集"办事,不必各自再认一遍链接。
  const ruleUrls = strList(raw?.ruleUrls).filter((u) => /^https?:\/\//i.test(u))
  return {
    id: isNonEmptyString(raw?.id) ? raw.id.trim() : `policy-${index}`,
    name: isNonEmptyString(raw?.name) ? raw.name.trim() : `策略-${index + 1}`,
    // 图标是纯界面的东西(国家代码或 globe:xxx),不进内核配置
    icon: isNonEmptyString(raw?.icon) ? raw.icon.trim() : '',
    // selector 首次生成时的默认选中项;空则由 config.mjs 用成员表里的第一个兜底
    default: isNonEmptyString(raw?.default) ? raw.default.trim() : '',
    // 停用的站点集留在档案里、界面上能看到,但不进内核配置(没有 selector、没有规则)
    enabled: raw?.enabled !== false,
    ruleUrls,
    rulesets: [...new Set([...strList(raw?.rulesets), ...ruleUrls.map(listTagForUrl)])],
    domain: strList(raw?.domain),
    domainSuffix: strList(raw?.domainSuffix),
    domainKeyword: strList(raw?.domainKeyword),
    ipCidr: strList(raw?.ipCidr),
    notes: normalizeNotes(raw?.notes),
  }
}

// 每条规则的备注(GitHub #238):{ '类型:值': '一句话' }。只给界面看,不进内核配置,也不算进分流指纹(routingFingerprint)
export const NOTE_MAX = 60
export const normalizeNotes = (raw) => {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (!isNonEmptyString(key) || !isNonEmptyString(value)) continue
    out[key.trim()] = value.trim().slice(0, NOTE_MAX)
  }
  return out
}

// 全新安装的种子站点集:国内域名 / IP 直连(以前由「中国大陆」这条内置地区翻译出来,现在直接写成站点集)。
// 只在 store 的 DEFAULT_PROFILE 里用:档案没有 policies 字段时补上它;用户删空了(policies: [])就不再补
export const CN_DIRECT_POLICY_SEED = normalizePolicy({
  id: 'region-cn-direct', name: '中国大陆·直连', icon: FALLBACK_ICON, default: 'direct', rulesets: [...CN_RULESETS],
})

// 分流设置的指纹。部署时把它记进 config.meta.json,规则页拿它和当前档案比:不一样就说明
// 分流改过但内核还在跑旧配置——那时「规则路由」(按当前设置推算)和「真实路由」(内核此刻
// 的实际行为)本来就会对不上,界面要能说清楚,而不是让人以为查出来是乱的。
// 归一化之后再算:同一份设置换个写法(缺省字段、老字段迁移)不该算成改过。
// 「默认出口」不算进去:代理页每切一次线路,选择就被写回档案当默认值(选择即默认,api/deploy-runner.mjs 的
// persistSelectionsAsDefaults),那不是改了分流设置。以前算进去,在代理线路之间换一下、规则页就一直提示「分流改过没重启」,
// 直到下次部署;热切换下连直连 / 代理互切也不再部署,这个误报就变成常态了
export const routingFingerprint = (routing) =>
  createHash('sha256').update(JSON.stringify(normalizeRouting(routing), (key, value) => (key === 'default' || key === 'fallbackDefault' || key === 'notes' || key === 'note' ? undefined : value))).digest('hex').slice(0, 16)

// 没传 builtin 时的默认(测试、预览):直连叫 direct、拒绝叫 block,都启用
export const DEFAULT_BUILTIN = Object.freeze({ direct: 'direct', block: 'block', directEnabled: true, blockEnabled: true })

// 一行 = 一个条件 + 它自己的出口。三样缺一不可:类型认得、值非空、选了出口。
// 值或出口空着的行直接丢掉,不是挑剔:空条件的规则在 sing-box 里等价于"全部命中",
// 而这些行排在所有站点集前面,一条就能把后面全盖住。
const normalizeCustomRule = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  if (!CUSTOM_RULE_TYPES.includes(raw.type)) return null
  if (!isNonEmptyString(raw.value) || !isNonEmptyString(raw.outbound)) return null
  const value = raw.value.trim()
  // 规则集链接必须是个网址,否则部署时按它去下载会直接失败
  if (raw.type === 'ruleUrl' && !/^https?:\/\//i.test(value)) return null
  // 端口写错的行同样丢掉:进了配置内核起不来
  if (raw.type === 'port' && !parsePortSpec(value)) return null
  const note = isNonEmptyString(raw.note) ? raw.note.trim().slice(0, NOTE_MAX) : ''
  return { type: raw.type, value, outbound: raw.outbound.trim(), ...(note ? { note } : {}) }
}

export const normalizeCustomPolicy = (raw) => {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    name: isNonEmptyString(r.name) ? r.name.trim() : CUSTOM_POLICY_NAME,
    icon: isNonEmptyString(r.icon) ? r.icon.trim() : CUSTOM_POLICY_ICON,
    iconScale: Number.isInteger(r.iconScale) ? r.iconScale : 0,
    enabled: r.enabled !== false,
    // 顺序即匹配顺序(内核首条命中生效),所以是数组
    rules: Array.isArray(r.rules) ? r.rules.map(normalizeCustomRule).filter(Boolean) : [],
  }
}

export const customPolicyActive = (custom) =>
  Boolean(custom) && custom.enabled !== false && Array.isArray(custom.rules) && custom.rules.length > 0

// 一行引用的规则集名字;纯域名 / IP 那几档没有规则集,返回空串
export const customRuleTag = (rule) => {
  if (rule.type === 'geosite' || rule.type === 'geoip') return `${rule.type}-${rule.value}`
  if (rule.type === 'ruleset') return rule.value
  if (rule.type === 'ruleUrl') return listTagForUrl(rule.value)
  return ''
}

// 出口存的可能是 direct / block 占位,换算成内核里此刻的实际 tag(内置出站可以改名)
export const customOutboundTag = (rule, builtin = DEFAULT_BUILTIN) =>
  rule.outbound === 'direct' ? builtin.direct : rule.outbound === 'block' ? builtin.block : rule.outbound

// 整份档案里用到的规则集链接:部署时要按这张表把它们下回来编译(见 system/rule-lists.mjs)。
// 停用的站点集不算——它本来就不进配置。
export const collectRuleListUrls = (routing) => {
  const seen = new Map()
  const conf = normalizeRouting(routing)
  // 前置自定义分流里的规则集链接也要下回来
  if (customPolicyActive(conf.custom)) {
    for (const rule of conf.custom.rules) {
      if (rule.type === 'ruleUrl' && !seen.has(rule.value)) seen.set(rule.value, listTagForUrl(rule.value))
    }
  }
  for (const p of conf.activePolicies) {
    for (const url of p.ruleUrls) if (!seen.has(url)) seen.set(url, listTagForUrl(url))
  }
  return [...seen.entries()].map(([url, tag]) => ({ url, tag }))
}

// 站点集引用的规则集,分别翻成路由规则和 DNS 规则各自该引用的 .srs 名字。
//
// ruleLists 是部署时从 rule-lists.json 得来的形状表:{ [list-xxxxxxxx]: { domain, ip } }
// (见 system/rule-lists.mjs 的 ensureRuleLists)。一条规则集链接编成域名 / IP 两份文件,
// 哪份存在就引用哪份;没有形状信息(预览、还没拉过)就按老样子引用一份。
export const routeRulesetTags = (policy, ruleLists = {}) => policy.rulesets.flatMap((tag) => {
  if (!isRuleListTag(tag)) return [tag]
  const shape = ruleLists && ruleLists[tag]
  if (!shape) return [tag]
  return [...(shape.domain ? [tag] : []), ...(shape.ip ? [ruleListIpTag(tag)] : [])]
})

// DNS 规则只要纯域名的规则集。geoip-* 和规则集链接的 IP 那份不能进来:sing-box 对含 IP 的
// 规则集是"先按这条规则的服务器解析一次、拿结果 IP 去对、对不上就丢掉重查"——等于每个路过的
// 域名都被这条策略的线路白查一遍,排在后面的规则再查第二遍。正式路由器上实测过:Netflix
// 站点集带着 geoip-netflix 排在 Speed 前面,Speed 名单里的域名先经台湾节点查(落到 Cloudflare
// 香港)、再经美国节点查,browserleaks 显示两个出口;「国内」带着 geoip-cn 更会把没列名的
// 国外域名明文送到运营商 DNS 问一遍。IP 该怎么分流,由路由规则里的同一批规则集去管。
export const dnsRulesetTags = (policy, ruleLists = {}) => policy.rulesets.filter((tag) => {
  if (tag.startsWith('geoip-')) return false
  if (!isRuleListTag(tag)) return true
  const shape = ruleLists && ruleLists[tag]
  return !shape || shape.domain
})

// 一条策略至少要有一个匹配条件,否则它生成的规则会匹配不到任何东西(或者更糟:
// 一条空条件的规则在 sing-box 里等价于"全部命中",把后面的规则全盖住)。
export const policyHasCondition = (p) =>
  p.rulesets.length > 0 ||
  p.domain.length > 0 ||
  p.domainSuffix.length > 0 ||
  p.domainKeyword.length > 0 ||
  p.ipCidr.length > 0

// 老档案 → 新模型。只在没有 policies 字段时走这条路。
const migrateLegacy = (routing) => {
  const categories = Array.isArray(routing?.categories) ? routing.categories : []
  const directRulesets = strList(routing?.directRulesets)
  const fallback = isNonEmptyString(routing?.fallback) ? routing.fallback.trim() : ''

  // 老的"始终直连"里带 geosite-cn 就是国内玩法;否则看兜底:兜底是 direct 说明
  // 用户已经在"只有指定的走代理"的模式下了,对应香港澳门那一档。
  const hasCn = directRulesets.some((t) => CN_RULESETS.includes(t))
  const regionId = hasCn ? 'cn' : fallback === 'direct' ? 'hkmo' : 'cn'

  const policies = []
  for (const cat of categories) {
    if (!isNonEmptyString(cat?.ruleset)) continue
    policies.push(
      normalizePolicy(
        {
          id: `legacy-${cat.ruleset}`,
          name: cat.ruleset,
          default: isNonEmptyString(cat.target) ? cat.target : '',
          rulesets: [cat.ruleset],
        },
        policies.length,
      ),
    )
  }
  // 老的"始终直连"里除 cn 之外的规则集:翻译成一条默认走直连的策略,行为不变
  const extraDirect = directRulesets.filter((t) => !CN_RULESETS.includes(t))
  if (extraDirect.length) {
    policies.push(
      normalizePolicy(
        { id: 'legacy-direct', name: '始终直连', default: 'direct', rulesets: extraDirect },
        policies.length,
      ),
    )
  }
  return { regionId, policies }
}

// 地区层退役了:选中的那条地区,按动作拆成一到两个站点集接在用户的站点集后面
// (地区规则本来就排在策略之后),兜底则变成兜底站点集的默认选中项。行为不变。
const migrateRegion = (raw) => {
  // 档案里压根没有地区数据(全新安装的种子在 store 的 DEFAULT_PROFILE 里)就不迁移,
  // 免得凭空长出两个站点集
  const hasRegionData =
    (Array.isArray(raw.regions) && raw.regions.length > 0) ||
    isNonEmptyString(raw.regionId) ||
    isNonEmptyString(raw.regionMode)
  if (!hasRegionData) return { policies: [], fallbackDefault: '' }

  const regions = Array.isArray(raw.regions) && raw.regions.length
    ? raw.regions.map(normalizeRegion)
    : BUILTIN_REGIONS.map(normalizeRegion)
  const wanted = isNonEmptyString(raw.regionId)
    ? raw.regionId.trim()
    : isNonEmptyString(raw.regionMode)
      ? REGION_MODE_TO_ID[raw.regionMode] || ''
      : ''
  const region = regions.find((r) => r.id === wanted) || regions[0]
  if (!region) return { policies: [], fallbackDefault: '' }

  const policies = []
  for (const action of ['direct', 'proxy']) {
    const rules = region.rules.filter((r) => r.action === action)
    if (!rules.length) continue
    policies.push(
      normalizePolicy({
        id: `region-${region.id}-${action}`,
        name: `${region.name}·${action === 'direct' ? '直连' : '代理'}`,
        icon: FALLBACK_ICON,
        default: action,
        rulesets: rules.filter((r) => r.type === 'geosite' || r.type === 'geoip').map(regionRuleTag),
        domain: rules.filter((r) => r.type === 'domain').map((r) => r.value),
        domainSuffix: rules.filter((r) => r.type === 'domainSuffix').map((r) => r.value),
        ipCidr: rules.filter((r) => r.type === 'ipcidr').map((r) => r.value),
      }, policies.length),
    )
  }
  return { policies, fallbackDefault: region.catchAll === 'proxy' ? 'proxy' : 'direct' }
}

// 改版前留在档案里的 routing 字段:地区层(regions / regionId / regionMode)、「出站」页签开关、广告拦截、
// 更早的 categories / directRulesets / fallback,以及主 selector 名 proxyTag。store 读档案时用
// migrateStoredRouting 翻译并删掉它们,写回一次之后档案里就不再出现
export const LEGACY_ROUTING_KEYS = Object.freeze([
  'regions', 'regionId', 'regionMode', 'outboundOptions', 'adBlock', 'adRuleset', 'categories', 'directRulesets', 'fallback', 'proxyTag',
])

// 老档案 → 存储形状。返回 { routing, changed }:changed 为 false 时 routing 就是传进来的对象。
//   · 没有 policies(或 policies 为空且 categories / directRulesets 里有东西)→ 老的分类翻译成站点集
//   · 没有 fallbackDefault 且有地区数据 → 选中的地区拆成站点集接在后面,兜底变成 fallbackDefault
//   · 最后删掉全部老字段
// 翻译只认档案里实际存着的东西:没有地区数据就不凭空长出站点集(全新安装的种子在 store 的 DEFAULT_PROFILE 里)
export const migrateStoredRouting = (routing) => {
  const raw = routing && typeof routing === 'object' ? routing : {}
  if (!LEGACY_ROUTING_KEYS.some((key) => key in raw)) return { routing: raw, changed: false }

  // store 的 deepMerge 会把 DEFAULT_PROFILE 里的 `policies: []` 补给老档案,所以
  // 不能只看"有没有 policies 字段":空数组 + 有老字段,同样是一份没迁过的老档案。
  const hasLegacy =
    (Array.isArray(raw.categories) && raw.categories.length > 0) ||
    (Array.isArray(raw.directRulesets) && raw.directRulesets.some((t) => !CN_RULESETS.includes(t)))
  const migrated = !Array.isArray(raw.policies) || (raw.policies.length === 0 && hasLegacy)
    ? migrateLegacy(raw)
    : null
  // fallbackDefault 一旦写进档案,就说明这份档案已经迁过了,不再重复翻译。
  const migratedRegion = isNonEmptyString(raw.fallbackDefault) ? null : migrateRegion(raw)

  const next = { ...raw }
  for (const key of LEGACY_ROUTING_KEYS) delete next[key]
  const policies = [
    ...(migrated ? migrated.policies : Array.isArray(raw.policies) ? raw.policies : []),
    ...(migratedRegion ? migratedRegion.policies : []),
  ]
  // 本来就没有 policies、翻译也没翻出东西(比如老客户端只 PUT 了一个 adBlock),就不写 policies:
  // 作为 patch 合并时不能把现有站点集清空;作为整份档案时留给默认值去种
  if (Array.isArray(raw.policies) || policies.length) next.policies = policies
  if (migratedRegion && isNonEmptyString(migratedRegion.fallbackDefault)) next.fallbackDefault = migratedRegion.fallbackDefault
  return { routing: next, changed: true }
}

export const normalizeRouting = (routing) => {
  const { routing: raw } = migrateStoredRouting(routing)

  // 兜底站点集:名字和图标可以改(名字就是内核里的出站 tag),只有存在本身是固定的
  const fallbackName = isNonEmptyString(raw.fallbackName) ? raw.fallbackName.trim() : FALLBACK_TAG
  const fallbackIcon = isNonEmptyString(raw.fallbackIcon) ? raw.fallbackIcon.trim() : FALLBACK_ICON

  const policies = (Array.isArray(raw.policies) ? raw.policies : [])
    .map(normalizePolicy)
    .filter(policyHasCondition)
    .filter((p) => p.name !== FALLBACK_TAG && p.name !== fallbackName)
  // 真正进内核的那部分:停用的不算
  const activePolicies = policies.filter((p) => p.enabled !== false)

  const fallback = {
    name: fallbackName,
    icon: fallbackIcon,
    // 没写就空着:config.mjs 的 effectiveOutbound 会取成员表的第一项
    default: isNonEmptyString(raw.fallbackDefault) ? raw.fallbackDefault.trim() : '',
  }

  return {
    custom: normalizeCustomPolicy(raw.custom),
    policies,
    activePolicies,
    fallback,
  }
}

// 站点集 selector 的成员表:「节点管理」里启用着的条目,按那里的顺序(内置的直连/
// 拒绝和节点组混排)。要不要某一项,就在节点管理里启用/停用它。
// 一个都不剩时回落成直连——空成员的组会让内核 FATAL(实测)。
//   groupTags  节点管理里出到配置的条目,按顺序;内置的两个也在其中,由 builtin 标出
//   builtin    { direct, block, directEnabled, blockEnabled }(见 user-groups.mjs)
export const policyOutboundOptions = (groupTags, builtin = DEFAULT_BUILTIN) => {
  const list = groupTags.filter((tag) => {
    if (tag === builtin.direct) return builtin.directEnabled
    if (tag === builtin.block) return builtin.blockEnabled
    return true
  })
  return list.length ? list : [builtin.direct]
}

// 迁移用的占位:老档案里地区的兜底只有"直连/代理"两种说法,而 selector 的成员是
// 具体的出站名。'proxy' 存进去表示"第一个节点组",真正是哪个组由生成配置时按成员表
// 定——用户在代理页点一下就变成具体的名字了。
export const PROXY_SENTINEL = 'proxy'

// 一个站点集实际会走哪个出站。default 空着(或指向一个已经不存在的组)时,内核会
// 落到成员表里的第一项——这里跟着算同一个结果,不然界面/DNS 的判断会和内核对不上。
// 档案里存的 'direct' / 'block' 是占位:内置出站可以改名,生成时换算成当时的名字。
export const effectiveOutbound = (policyDefault, members, builtin = DEFAULT_BUILTIN) => {
  const want = policyDefault === 'direct' ? builtin.direct : policyDefault === 'block' ? builtin.block : policyDefault
  if (members.includes(want)) return want
  if (policyDefault === PROXY_SENTINEL) {
    const group = members.find((m) => m !== builtin.direct && m !== builtin.block)
    if (group) return group
  }
  return members[0]
}

// dnsmasq 接管模式下该怎么转发查询。
//
// 默认做法是把 dnsmasq 的上游整个换成 sing-box(noresolv + 唯一上游),所有查询都进
// Open-Box。要做到"直连的 DNS 根本不经过 Open-Box",只能反过来:只把要走代理的域名按
// `server=/域名/127.0.0.1#7853` 逐条转给它,其余的 dnsmasq 自己解析、自己出网。
//
// 只在"代理面能被逐条列出来"时成立:
//   · 兜底走代理 —— 代理面是"除了列出来的一切",没法枚举
//   · 某个走代理的站点集用了 geosite/geoip 或域名关键词 —— dnsmasq 展开不了二进制
//     规则集,也不支持关键词匹配
// 列不出来就返回空数组,调用方回落到全局转发。
//
// 这份名单是**生成配置时**算的,和 DNS 规则一样按内核里此刻的选择(selections)判断
// 谁走代理;两次重启之间在代理页切了直连/代理,转发表要等下次重启才跟上——切换本身仍然
// 生效(流量照样走代理),只是那些域名这一轮还是本地解析的。
// members 是内核里那些 selector 的成员表(生成配置时算出来的那一份,直接传进来,
// 不在这里重算一遍——两处各算一次迟早会算歪)。
// 顺着内核里各 selector 的当前选择(selections:tag → now)一路下钻到叶子。
// DNS 规则和 dnsmasq 转发表都要按"此刻真走哪"判断,两处共用这一个,免得算歪。
export const resolveSelectionLeaf = (selections, name) => {
  const map = selections && typeof selections === 'object' ? selections : {}
  let current = name
  const seen = new Set()
  for (let i = 0; i < 16 && Object.prototype.hasOwnProperty.call(map, current) && !seen.has(current); i++) {
    seen.add(current)
    current = map[current]
  }
  return current
}

// 某个站点集(或兜底)此刻是不是直连:内核在跑就按它当前的选择,否则按档案默认
// 站点集此刻实际落到的出口:代理页里选过就按选择(顺着 selector 链找到叶子),没选过按档案默认
export const policyChosenOutbound = (name, policyDefault, members, builtin, selections) =>
  selections && Object.prototype.hasOwnProperty.call(selections, name)
    ? resolveSelectionLeaf(selections, name)
    : effectiveOutbound(policyDefault, members, builtin)
export const policyGoesDirect = (name, policyDefault, members, builtin, selections) =>
  policyChosenOutbound(name, policyDefault, members, builtin, selections) === builtin.direct

// 第一层 · DNS:哪些域名的查询要交给内核(其余留给路由器原有的 dnsmasq 和它的上游)。
//   none     代理面是空的(全部直连):一个都不转发,原 DNS 原样——不再"全量转发更简单"
//   domains  代理面能逐条列出:只转发这些域名。规则集(geosite / 规则集链接)不再自动等于 all——
//            它们被记在 expand 里,部署时由 system/dns-forward.mjs 解码成域名并入名单;解码后
//            发现关键词 / 逻辑规则这种 dnsmasq 表达不了的,那时才降成 all(第三轮 阶段 2)
//   all      代理面列不出来(兜底走代理、广告拦截、手写的关键词):只能全量转发,内核里再分
// 域名在这里就按 dnsmasq 能接受的形态规范化(IDNA → punycode),写不进去的域名直接判 all 并说明,
// 不留到应用阶段再悄悄降级(复审 S3)。三种情况以前都用 [] 表示(审核 B2);前置分流里走代理的
// 域名也没进名单(审核 B1)。
const CUSTOM_TYPE_LABEL = { domainKeyword: '域名关键词', ruleset: '规则集' }
// extra.rewriteDomains:DNS 重写的源域名(已按 dnsmasq 写法整理,泛域名写根域;engine/dns-rewrite.mjs 的
// rewriteForwardDomains)。它们不管走不走代理都得交给内核,不然在原上游就被正常解析、重写碰不到
export const dnsmasqForwardPlan = (routing, members = ['direct'], builtin = DEFAULT_BUILTIN, selections = {}, extra = {}) => {
  const conf = normalizeRouting(routing)
  const rewriteDomains = Array.isArray(extra.rewriteDomains) ? extra.rewriteDomains.filter((d) => typeof d === 'string' && d) : []
  const all = (reason) => ({ mode: 'all', domains: [], expand: [], reason })
  if (!policyGoesDirect(conf.fallback.name, conf.fallback.default, members, builtin, selections)) return all(`兜底「${conf.fallback.name}」走代理`)
  const domains = new Set()
  const expand = []
  const addDomain = (value, owner) => {
    const safe = dnsmasqSafeDomain(value)
    if (!safe) return `${owner}的域名「${value}」写不进 dnsmasq（非法字符 / 标签超长）`
    domains.add(safe)
    return ''
  }
  // 前置自定义分流:走代理和要拒绝的域名行都要进名单——拒绝的交给内核,内核的 DNS 规则会拒
  // (留在原上游它就被正常解析了);按 IP / 端口分流的行在解析阶段用不上,跳过
  if (customPolicyActive(conf.custom)) {
    for (const rule of conf.custom.rules) {
      const target = customOutboundTag(rule, builtin)
      if (target === builtin.direct) continue
      const owner = `前置自定义分流${target === builtin.block ? '要拒绝的' : ''}`
      if (rule.type === 'domain' || rule.type === 'domainSuffix') {
        const bad = addDomain(rule.value, owner)
        if (bad) return all(bad)
      } else if (rule.type === 'geosite' || rule.type === 'ruleUrl') {
        expand.push({ tag: customRuleTag(rule), owner: `${owner}「${rule.value}」` })
      } else if (CUSTOM_TYPE_LABEL[rule.type]) {
        return all(`${owner}「${rule.value}」是${CUSTOM_TYPE_LABEL[rule.type]},dnsmasq 展不开`)
      }
    }
  }
  for (const p of conf.activePolicies) {
    if (policyGoesDirect(p.name, p.default, members, builtin, selections)) continue
    if (p.domainKeyword.length) return all(`站点集「${p.name}」用了域名关键词,dnsmasq 展不开`)
    for (const d of [...p.domain, ...p.domainSuffix]) {
      const bad = addDomain(d, `站点集「${p.name}」`)
      if (bad) return all(bad)
    }
    // geoip 只按 IP 分,解析阶段用不上;geosite / 规则集链接(rulesets 里已经含链接对应的 tag)交给部署时展开
    for (const tag of p.rulesets) if (!/^geoip-/.test(tag)) expand.push({ tag, owner: `站点集「${p.name}」` })
  }
  for (const d of rewriteDomains) domains.add(d)
  if (!domains.size && !expand.length) return { mode: 'none', domains: [], expand: [], reason: '没有走代理的域名,DNS 全部由路由器原有上游解析' }
  return { mode: 'domains', domains: [...domains], expand, reason: '' }
}
// 老接口:只回名单。none / all 都是空数组——只给还没改到计划形状的调用方过渡用
export const dnsmasqForwardDomains = (routing, members = ['direct'], builtin = DEFAULT_BUILTIN, selections = {}, extra = {}) => {
  const plan = dnsmasqForwardPlan(routing, members, builtin, selections, extra)
  return plan.mode === 'domains' ? plan.domains : []
}

// 第一层 · 连接:哪些目标 IP 集合可以在系统入口(nft)就旁路掉、根本不进内核。
// 只收"此刻走直连"的站点集里的 geoip 规则集(geoip-cn 之类):它们是纯 IP 集合,能直接编进
// 内核的 route_exclude_address_set。域名集合(geosite)在入口没法按 IP 判,不收。
// 但只要存在任何比"按目标 IP 直连"优先级更高、且可能把这些 IP 送去别处的规则,旁路就会
// 越过它们:前置自定义分流(不管哪种类型——域名行解析出来的也可能是国内 IP)、走代理的终端
// 分流(该终端的全部流量都该走节点)、广告拦截(命中广告域名的国内 IP 该被拒)。这种情况下
// 不开旁路,直连目标进内核后由 direct 出站连(兼容路径),并把原因记进 config.meta.json。
// 每个站点集(含兜底)此刻实际落到哪一类出口:direct / block / proxy。DNS 分类(dnsPolicyClasses,只看
// 有域名条件的)、入口旁路(nativeBypassPlan)、IPv6 保护(config.mjs 的 rejectV6For)共用这一张表,选择
// 同步时也按它比——纯 IP 站点集在直连 / 代理之间切换,DNS 表看不出来,但 v6 保护和旁路都跟着变
// (第四轮 T3)
export const policyClasses = (routing, members = ['direct'], builtin = DEFAULT_BUILTIN, selections = {}) => {
  const conf = normalizeRouting(routing)
  const klass = (name, def) => {
    const chosen = policyChosenOutbound(name, def, members, builtin, selections)
    return chosen === builtin.direct ? 'direct' : chosen === builtin.block ? 'block' : 'proxy'
  }
  const out = {}
  for (const p of conf.activePolicies) out[p.name] = klass(p.name, p.default)
  out[conf.fallback.name] = klass(conf.fallback.name, conf.fallback.default)
  return out
}

// 入口模式(纯函数)。两种:
//   blacklist(默认进内核)—— 现在这套:只有此刻走直连的站点集引用的 IP 集合在入口放走,其余全进内核;
//   whitelist(默认放行)—— 反过来:只有"必须进内核"的目标进内核,其余在入口放走。必须进内核的 = FakeIP 占位池
//     (走代理的域名拿到的都是它)+ 此刻走代理 / 拒绝的站点集引用的 IP 集合和手写网段 + 前置自定义分流里
//     走代理 / 拒绝的 IP 行。兜底直连、按域名直连的目标不用任何 IP 条件就在入口放走,不再白付一次用户态转发
//     (GitHub #224 之后用户的诉求)。
// whitelist 的前提,少一条都退回 blacklist(原因写明):
//   · FakeIP 开着且终端查询经内核(dnsMode != off):走代理的域名必须拿占位地址,真实 IP 的流量才敢默认放走;
//   · 兜底走直连:兜底走代理时没命中的目标都得进内核,白名单列不出来;
//   · 没有终端被指定整机走代理;
//   · 前置自定义分流里走代理 / 拒绝的行只能是域名 / IP 段 / geoip:按端口分流的、规则集链接(里面有没有 IP 段
//     说不清)的在入口判不了。
// IPv6 这一版不放:v6 一律照旧进内核(ipv6 分层的语义不变),名单里的 v6 段只写 ::/0。
export const ENTRY_MODE_BLACKLIST = 'blacklist'
export const ENTRY_MODE_WHITELIST = 'whitelist'
// 没有 nft 重定向(纯 tun)时入口名单编进路由表、不能在线换,白名单一律不启用;部署元数据和热切换都用这一句
export const PURE_TUN_ENTRY_REASON = '没有 nft 重定向(纯 tun),入口名单不能在线换,只用黑名单'
// 后端设置「直连不进内核」(档案 directBypass,默认开)关掉时的原因:入口一律不旁路,所有流量进内核,统计才完整
export const DIRECT_BYPASS_OFF_REASON = '后端设置里关掉了「直连不进内核」:所有流量都进内核,入口不放行'
// directAnswer:直连应答放行(system/direct-answer-bypass.mjs:直连侧解析出来的真实地址写进入口放行集合)开不开。
// 白名单入口一直开;黑名单入口(兜底走代理)按用户 2026-09-29 定的原则也开——「选了直连的,只要开着直连不进内核和
// FakeIP,就不进内核」(#307)。前提和白名单一样(兜底直连那条除外):FakeIP 开着且查询经内核、没有被指定走代理的终端、
// 前置自定义分流没有按端口走代理 / 拒绝的行(入口按地址放走的连接,内核的端口规则就管不到了)
const directAnswerAllowed = (conf, { builtin, clientRoutes, fakeIp, dnsMode, enabled }) => {
  if (!enabled || !fakeIp || dnsMode === 'off') return false
  if (clientRoutes.some((cr) => cr && cr.outbound && cr.outbound !== builtin.direct)) return false
  if (customPolicyActive(conf.custom)) {
    for (const rule of conf.custom.rules) {
      if (rule.type === 'port' && customOutboundTag(rule, builtin) !== builtin.direct) return false
    }
  }
  return true
}

export const entryModePlan = (routing, { members = ['direct'], builtin = DEFAULT_BUILTIN, selections = {}, clientRoutes = [], fakeIp = false, dnsMode = 'dnsmasq', enabled = true } = {}) => {
  const conf = normalizeRouting(routing)
  const domainSafe = Boolean(fakeIp) && dnsMode !== 'off'
  const needSets = []
  const needCidrs = []
  const addSet = (tag) => { if (!needSets.includes(tag)) needSets.push(tag) }
  const directAnswer = directAnswerAllowed(conf, { builtin, clientRoutes, fakeIp, dnsMode, enabled })
  const black = (reason) => ({ mode: ENTRY_MODE_BLACKLIST, reason, fakeIp: domainSafe, needSets: [], needCidrs: [], directAnswer })
  if (!enabled) return black(DIRECT_BYPASS_OFF_REASON)
  if (!fakeIp) return black('没开 FakeIP:走代理的域名解析出来是真实 IP,入口分不出它和直连目标,不能默认放行')
  if (dnsMode === 'off') return black('DNS 禁用模式下终端的查询不一定经内核,走代理的域名拿不到占位地址,不能默认放行')
  if (!policyGoesDirect(conf.fallback.name, conf.fallback.default, members, builtin, selections)) return black(`兜底「${conf.fallback.name}」走代理:没命中的目标都要进内核,入口没法默认放行`)
  if (clientRoutes.some((cr) => cr && cr.outbound && cr.outbound !== builtin.direct)) return black('有终端被指定走代理,该终端的全部流量都要进内核')
  if (customPolicyActive(conf.custom)) {
    for (const rule of conf.custom.rules) {
      const target = customOutboundTag(rule, builtin)
      if (target === builtin.direct) continue
      if (rule.type === 'port') return black(`前置自定义分流「${rule.value}」按端口分流,入口按 IP 判不了`)
      if (rule.type === 'ruleUrl' || rule.type === 'ruleset') return black(`前置自定义分流「${rule.value}」是规则集链接 / 规则集,里面有没有 IP 段说不清`)
      if (rule.type === 'ipCidr') needCidrs.push(rule.value)
      else if (rule.type === 'geoip') addSet(`geoip-${rule.value}`)
      // 域名行:走代理的拿占位地址、拒绝的解析也拒,都不产生真实 IP
    }
  }
  for (const p of conf.activePolicies) {
    if (policyGoesDirect(p.name, p.default, members, builtin, selections)) continue
    for (const tag of p.rulesets) if (/^geoip-/.test(tag)) addSet(tag)
    for (const c of p.ipCidr) if (!needCidrs.includes(c)) needCidrs.push(c)
  }
  return { mode: ENTRY_MODE_WHITELIST, reason: 'FakeIP 开着、兜底直连:入口默认放行,只有 FakeIP 占位池和走代理 / 拒绝的 IP 集合进内核', fakeIp: domainSafe, needSets, needCidrs, directAnswer: true }
}

// 入口原生旁路的计划(纯函数)。基准是真实 IP:入口只看目标 IP,任何排在候选直连集合前面、可能把同一个
// IP 送去别处的规则都必须核对——
//   · 带域名条件的非直连规则(站点集的域名 / 关键词 / geosite,前置自定义分流的域名行)和走代理的兜底:域名解析
//     出来的 IP 可能正好落在候选集合里,入口分不出域名,一放走内核就救不回来。有域名的访问只按域名判(见文件末尾
//     noDomainGuard),所以不论排在候选前面还是后面都挡 → 整个不开(没有 FakeIP 时);
//   · 只带 IP 条件的较早非直连规则(geoip / ip_cidr):和候选集合有没有交集是可以算的 → 候选记成 pending,
//     部署时由 system/native-bypass.mjs 解码两边集合做区间重叠核对,没交集才旁路;
//   · 端口规则、形状未知的规则集链接、走代理的终端、广告拦截:按目标 IP 判不了 → 不开。
// fakeIp(隔离试验开关,engine/dns.mjs)且终端查询确实经内核(dnsMode 不是 off)时,走代理的域名拿到的是
// 占位地址,域名条件才不挡——这是试验路径的前提,不是保证:终端自带加密 DNS、开启前已缓存的真实地址、
// 转发漏匹配都不在范围内,原因里写明。DNS 禁用模式下即使开着 FakeIP 也按真实 IP 算(第四轮 T4)
export const nativeBypassPlan = (routing, { members = ['direct'], builtin = DEFAULT_BUILTIN, selections = {}, clientRoutes = [], fakeIp = false, dnsMode = 'dnsmasq', enabled = true } = {}) => {
  const conf = normalizeRouting(routing)
  const domainSafe = Boolean(fakeIp) && dnsMode !== 'off'
  if (!enabled) return { enabled: false, sets: [], pending: [], fakeIp: domainSafe, reason: DIRECT_BYPASS_OFF_REASON }
  const notes = []
  if (fakeIp && dnsMode === 'off') notes.push('DNS 禁用模式下终端的查询不一定经内核,FakeIP 不作旁路前提,按真实 IP 计算')
  if (domainSafe) notes.push('FakeIP 试验开着:走代理的域名规则按占位地址计,不挡直连集合（终端自带加密 DNS / 开启前已缓存的真实地址 / 转发漏匹配不在此保证内）')
  const off = (reason) => ({ enabled: false, sets: [], pending: [], fakeIp: domainSafe, reason: [reason, ...notes].join(';') })
  const earlier = []
  if (customPolicyActive(conf.custom)) {
    const cidrs = []
    const geoip = []
    const lists = []
    for (const rule of conf.custom.rules) {
      const target = customOutboundTag(rule, builtin)
      if (target === builtin.direct) continue
      if (rule.type === 'port') return off(`前置自定义分流「${rule.value}」按端口分流,任何目标 IP 都可能命中,入口旁路不能越过它`)
      if (rule.type === 'ipCidr') { cidrs.push(rule.value); continue }
      if (rule.type === 'geoip') { geoip.push(`geoip-${rule.value}`); continue }
      // 规则集链接:开着 FakeIP 时域名那份拿的是占位地址,不挡;IP 那份部署时解码出来扣掉重叠段(system/native-bypass.mjs,#302)
      if (rule.type === 'ruleUrl' && domainSafe) { lists.push(listTagForUrl(rule.value)); continue }
      if (rule.type === 'ruleUrl' || rule.type === 'ruleset') return off(`前置自定义分流「${rule.value}」是规则集链接 / 规则集,里面可能有 IP 段,入口旁路不能越过它`)
      // 域名 / 后缀 / 关键词行
      if (!domainSafe) return off(`前置自定义分流「${rule.value}」按域名分流,它解析出来的 IP 在入口分不出来,旁路不能越过它`)
    }
    if (cidrs.length || geoip.length || lists.length) earlier.push({ name: '前置自定义分流', geoip, cidrs, ...(lists.length ? { lists } : {}) })
  }
  if (clientRoutes.some((cr) => cr && cr.outbound && cr.outbound !== builtin.direct)) return off('有终端被指定走代理,该终端的全部流量都要进内核')
  // 有域名的访问只按域名判(见文件末尾 noDomainGuard 的说明):没有 FakeIP 时走代理的域名、没命中任何域名规则而落到
  // 走代理的兜底的域名,拿到的都是真实地址,可能落在任何直连集合里——内核按域名判它们走代理,入口按 IP 放走就放错了,
  // 不管这个站点集排在直连集合前面还是后面。开着 FakeIP 时它们拿的是占位地址,不挡
  if (!domainSafe) {
    const goes = (name, def) => policyGoesDirect(name, def, members, builtin, selections)
    const byDomain = conf.activePolicies.find((p) => !goes(p.name, p.default) && (p.domain.length > 0 || p.domainSuffix.length > 0 || p.domainKeyword.length > 0 || p.rulesets.some((tag) => !/^geoip-/.test(tag))))
    if (byDomain) return off(`站点集「${byDomain.name}」按域名走代理 / 拒绝:有域名的访问只按域名判,这些域名解析出来的真实地址在入口分不出来,按 IP 放走会放错（开 FakeIP 后它们拿的是占位地址,就不挡了）`)
    if (!goes(conf.fallback.name, conf.fallback.default)) return off(`兜底「${conf.fallback.name}」走代理:没命中域名规则的域名都走兜底,它们解析出来的真实地址在入口分不出来,按 IP 放走会放错（开 FakeIP 后它们拿的是占位地址,就不挡了）`)
  }
  const sets = []
  const pending = []
  for (const p of conf.activePolicies) {
    const geoip = p.rulesets.filter((tag) => /^geoip-/.test(tag))
    if (!policyGoesDirect(p.name, p.default, members, builtin, selections)) {
      // 规则集链接:能走到这里说明开着 FakeIP(没开时按域名走代理的站点集上面已经整个挡掉了),域名那份拿的是占位地址,
      // 不挡;IP 那份(list-xxx-ip.srs)和 geoip 一样,部署时解码出来,从后面的直连集合里扣掉重叠段(system/native-bypass.mjs)。
      // 以前一碰到规则集链接就把后面所有直连集合整个挡掉,「国内」的 geoip-cn 因此一份都不旁路(#302)
      const lists = p.rulesets.filter((tag) => isRuleListTag(tag))
      if (geoip.length || p.ipCidr.length || lists.length) earlier.push({ name: p.name, geoip, cidrs: [...p.ipCidr], ...(lists.length ? { lists } : {}) })
      continue
    }
    if (!geoip.length) continue
    if (earlier.length) pending.push({ policy: p.name, sets: geoip, against: earlier.map((e) => ({ name: e.name, geoip: [...e.geoip], cidrs: [...e.cidrs], ...(e.lists ? { lists: [...e.lists] } : {}) })) })
    else for (const tag of geoip) if (!sets.includes(tag)) sets.push(tag)
  }
  if (!sets.length && !pending.length) return off('走直连的站点集里没有 geoip 规则集,入口没有可用的 IP 集合')
  const reasons = [...notes]
  for (const x of pending) reasons.push(`站点集「${x.policy}」的集合要先和前面带 IP 条件的「${x.against.map((a) => a.name).join('」「')}」核对重叠,部署时决定`)
  return { enabled: sets.length > 0, sets, pending, fakeIp: domainSafe, reason: reasons.join(';') }
}

// 旁路计划的稳定指纹:候选集合、按顺序构成的核对对象(名字 + geoip 集合 + CIDR)、FakeIP 前提。部署时记进
// config.meta.json,选择同步时按它比——只比站点集名字会漏掉"核对对象从一条变成两条"这种变化(第四轮 T2)
export const bypassPlanKey = (plan) => {
  if (!plan || typeof plan !== 'object') return ''
  const sorted = (v) => [...(Array.isArray(v) ? v : [])].map(String).sort()
  return JSON.stringify({
    sets: sorted(plan.sets),
    pending: [...(Array.isArray(plan.pending) ? plan.pending : [])]
      .map((x) => ({ policy: x.policy, sets: sorted(x.sets), against: (x.against || []).map((a) => ({ name: a.name, geoip: sorted(a.geoip), cidrs: sorted(a.cidrs), ...(a.lists && a.lists.length ? { lists: sorted(a.lists) } : {}) })) }))
      .sort((a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : 0)),
    fakeIp: Boolean(plan.fakeIp),
  })
}

// sing-box 1.14 起(route/rule/rule_item_rule_set.go 的 mergeableRuleIn):同一条规则里的规则集只有在「规则集
// 只含一条 default 规则、不带 invert、不嵌套规则集」时才和这条规则自己的域名 / IP 条件合并成「或」;其它形状
// (多条规则、逻辑规则、取反)按独立条件求值,和域名 / IP 条件是「与」——1.13 之前一律按「或」。Open-Box 从来
// 都按「任一命中」理解(用户在界面上也是这么看的),又不能替每个规则集判形状(MetaCubeX 的 geosite 是一条,自己
// 编的 .list / .mrs 不一定),所以规则集和域名 / IP 条件拆成紧邻的两条、动作 / 来源 / 端口条件原样各带一份:
// 首条命中生效,两条任一命中效果和原来一条「或」完全一样。只有规则集或只有域名 / IP 条件的不拆。
// DNS 规则和路由规则共用(engine/dns.mjs、engine/routing.mjs)
const RULE_DEST_KEYS = ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'ip_cidr']
export const splitRuleSetConditions = (rule) => {
  if (!rule || typeof rule !== 'object' || !rule.rule_set) return [rule]
  const destKeys = RULE_DEST_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(rule, k))
  if (!destKeys.length) return [rule]
  const rest = { ...rule }
  delete rest.rule_set
  for (const k of destKeys) delete rest[k]
  const withSet = { rule_set: rule.rule_set, ...rest }
  const withDest = {}
  for (const k of destKeys) withDest[k] = rule[k]
  return [withSet, { ...withDest, ...rest }]
}

// 「IP 只管 IP、域名只管域名,不管是哪里的分流」(用户 2026-09-26 定的规则):一个有域名的访问先按域名把前置自定义
// 分流、站点集从上往下对一遍,都没命中就走兜底「其他」,按兜底的出口走——和 DNS 那一层一样(engine/dns.mjs 只按
// 域名条件分解析器,兜底直连就问直连 DNS)。按 IP 判的条件(IP 段、geoip 集合、规则集链接编出来的 IP 那份)只管
// **没有域名**的连接:终端直接按 IP 连、内核嗅探不到 SNI / Host、DNS 反查(reverse_mapping)也没记下域名的那种。
// 以前两类条件在一条规则里「任一命中」,没列进任何名单的域名(正式路由器上的 brainhost.ai)按兜底问直连 DNS 拿到
// Cloudflare 的地址,又被「国外」的 geoip-cloudflare 抢去走节点:解析走直连、连接走节点,用户说这是 DNS 泄露。
// 内置的私网直连、订阅和节点站点直连、tun 防回环不是分流,是保命规则,照旧对所有连接生效。
//
// 内核里「连接有域名」= metadata.Domain(嗅探到的、DNS 反查记下的)或 Destination.Fqdn(FakeIP 找回的)有值
// (sing-box route/rule/rule_item_domain_regex.go)。HTTP 的 Host 直接写 IP 时嗅探出来的是 IP 字面量,不算域名:
// 要求至少一个字母、且没有冒号(IPv4 字面量没有字母,IPv6 字面量有冒号;域名到这里已经转成小写)
export const DOMAIN_PRESENT_REGEX = '^[^:]*[a-z][^:]*$'
// 「连接没有域名」这个前提:放进 logical AND 里和 IP 条件并列
export const noDomainGuard = () => ({ domain_regex: [DOMAIN_PRESENT_REGEX], invert: true })
export const isNoDomainGuard = (sub) => Boolean(sub) && typeof sub === 'object' && sub.invert === true && Array.isArray(sub.domain_regex) &&
  sub.domain_regex.length === 1 && sub.domain_regex[0] === DOMAIN_PRESENT_REGEX && Object.keys(sub).length === 2
// 读规则的各处(规则页推算)用:这条规则带不带「连接没有域名」的前提;带的话去掉它,剩下的条件照常判。
// 只剩一条普通规则时并回普通规则(动作 / 出口照抄),还带开关等其它子规则的保留 logical 结构交给 flattenFlipRule
export const splitNoDomainGuard = (rule) => {
  if (!rule || rule.type !== 'logical' || rule.mode !== 'and' || !Array.isArray(rule.rules) || !rule.rules.some(isNoDomainGuard)) return { rule, noDomain: false }
  const rest = rule.rules.filter((r) => !isNoDomainGuard(r))
  const { type: _t, mode: _m, rules: _r, ...tail } = rule
  void _t
  void _m
  void _r
  if (rest.length === 1 && rest[0] && rest[0].type !== 'logical') return { rule: { ...rest[0], ...tail }, noDomain: true }
  return { rule: { ...rule, rules: rest }, noDomain: true }
}

// 内核连接记录里的规则原文(rule.String()):logical 规则各子规则用 " && " 连,取反的写成 "!(…)"。给界面看时把这段前提
// 去掉、改成一个标记,免得用户在「查看详情」里看到一串正则
const NO_DOMAIN_RULE_TEXT = ` && !(domain_regex=${DOMAIN_PRESENT_REGEX})`
export const stripNoDomainGuardText = (text) => {
  // 终端分流规则的「入站不是共享网络」(engine/client-routes.mjs)同样不给界面看
  const s = stripShareGuardText(text)
  return s.includes(NO_DOMAIN_RULE_TEXT) ? { rule: s.split(NO_DOMAIN_RULE_TEXT).join(''), noDomain: true } : { rule: s, noDomain: false }
}

// 规则集按看什么分:geoip-* 和规则集链接编出来的 IP 那份看目标 IP,其余(geosite-*、规则集链接的域名那份、
// 形状未知的规则集链接)看域名
export const isIpRuleSetTag = (tag) => typeof tag === 'string' && (/^geoip-/.test(tag) || (isRuleListTag(tag) && tag.endsWith(RULE_LIST_IP_SUFFIX)))

// 站点集的匹配条件分成「看域名」「看 IP」两份,各是一条还没拆规则集的路由规则条件(拆分见 splitRuleSetConditions);
// 没有就是 null
export const policyRouteMatches = (policy, ruleLists = {}) => {
  const tags = routeRulesetTags(policy, ruleLists)
  const domain = {}
  const domainTags = tags.filter((t) => !isIpRuleSetTag(t))
  if (domainTags.length) domain.rule_set = domainTags
  if (policy.domain.length) domain.domain = policy.domain
  if (policy.domainSuffix.length) domain.domain_suffix = policy.domainSuffix
  if (policy.domainKeyword.length) domain.domain_keyword = policy.domainKeyword
  const ip = {}
  const ipTags = tags.filter(isIpRuleSetTag)
  if (ipTags.length) ip.rule_set = ipTags
  if (policy.ipCidr.length) ip.ip_cidr = policy.ipCidr
  return { domain: Object.keys(domain).length ? domain : null, ip: Object.keys(ip).length ? ip : null }
}
