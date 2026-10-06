// 「地区分流」:共享网络(A 模式)手机客户端按人所在地区决定哪些流量本地直连、哪些回路由器。
// 默认三组(中国大陆 / 港澳 / 其他)和客户端内置的是同一份:defaults/share-regions-default.json 是
// clients/core/regions-default.json 的拷贝(测试核对两份一字不差)。档案里存 shareRegions,没存 / 存了空数组 = 用默认。
// 方案:docs/superpowers/specs/2026-09-27-client-apps-design.md §4.3。它不进路由器自己的内核配置,改了不用重启内核
//
// 一组(用户 2026-10-03 改过):name 一个名字(去掉了多语种)、description 说明(App 里显示在这一组下面)、regions、
// regionMatch、default、rules、catchAll(规则都没命中的流量)、dns(见 shareGroupDnsDefaults 上面)。老写法读的时候换算
// (normalizeShareGroup):name 是 { zh-CN, zh-TW, en } 的取简体 → 繁体 → 英文第一个有的;dns 是 { directResolver } 的换成两侧上游。
//
// regionMatch(用户 2026-10-03「所在地区要做个页签:在这些地区 / 在这些地区之外」):没写 = 在 regions 这些地区时用这一组;
// 'outside' = 在这些地区之外时用(至少列一个地区)。按定位选组的顺序:先找「在这些地区」里列明了这个地区的组,再按顺序找
// 「之外」的组,都不中用默认组;定位不到也用默认组。「一个地区只能归一组」只在「在这些地区」的组之间查——「之外」的组本来就是
// 列别的组的地区(比如其他地区 = 中国、香港、澳门之外)
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { normalizeCidr } from './client-routes.mjs'
import { listTagForUrl } from './rule-list.mjs'
import {
  DEFAULT_DNS_PORT, MAX_DNS_EXTRAS, WAN_UPSTREAM, isDnsProtocol, isValidDnsPort, isValidDnsUpstream, isWanUpstream, regionDnsDefaults,
} from './dns-upstream.mjs'

export const SHARE_REGIONS_DEFAULT_FILE = new URL('../defaults/share-regions-default.json', import.meta.url)
// 规则类型和目标分流对齐(用户 2026-10-05):多了域名关键词(domainKeyword)和规则集链接(ruleUrl,路由器下载编译,
// App 从路由器取编好的 .srs,见 system/share-region-lists.mjs)
export const SHARE_REGION_RULE_TYPES = Object.freeze(['geosite', 'geoip', 'domain', 'domainSuffix', 'domainKeyword', 'ipcidr', 'ruleUrl'])
// 老 App 只认这五种,遇到别的类型整组配置都生成不出来:请求地区分流不带 rules=2 的,新类型的规则先删掉再发(shareRegionsForClient)
export const SHARE_REGION_LEGACY_RULE_TYPES = Object.freeze(['geosite', 'geoip', 'domain', 'domainSuffix', 'ipcidr'])
// direct = 本地直连;proxy = 回路由器(经共享网络节点,由路由器按自己的规则出去)
export const SHARE_REGION_ACTIONS = Object.freeze(['direct', 'proxy'])
export const SHARE_GROUP_NAME_MAX = 30
export const SHARE_GROUP_DESCRIPTION_MAX = 120
const LEGACY_NAME_LOCALES = ['zh-CN', 'zh-TW', 'en']
const MAX_GROUPS = 12
const MAX_RULES = 200
const GEO_NAME = /^[a-z0-9!@._-]{1,80}$/
const DOMAIN = /^[A-Za-z0-9*_.-]{1,253}$/
// 和站点集的规则集链接一样(api/rulesets.mjs 的预览接口)
const RULE_URL = /^https?:\/\/\S+$/i
const RULE_URL_MAX = 2048
const SIDES = ['direct', 'proxy']

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// 一组的 DNS(用户 2026-10-03:「直连 DNS / 代理 DNS 的设计按 Open-Box 路由器版设置」):和路由器的 DNS 上游(engine/dns-upstream.mjs、
// DNS 设置页的「DNS 上游」)同一个设计——直连 / 代理两侧各一条主上游 + 最多 MAX_DNS_EXTRAS 条备用(并发查,谁先给出 NOERROR 用谁的),
// 字段名和档案的 dns 段一样:direct / directProtocol / directPort / directExtras、proxy / proxyProtocol / proxyPort / proxyExtras。
// 一条上游是一个 IP(UDP / TCP + 端口),或记号 wan = 手机此刻所在网络的系统 DNS(路由器那边叫「上游 DNS」):固定 UDP 53、
// 直接问,代理侧的也不经节点。代理侧填的 IP 经共享网络节点回路由器再出去查。
// 手机在中国大陆(这一组的地区里有 CN)时代理侧不能用系统 DNS——中国大陆的 DNS 对境外域名有污染,和路由器在中国大陆时一样。
// 默认值也照路由器:有 CN 的组按「中国大陆」(直连系统 DNS、代理 TCP 1.1.1.1),别的组按「中国大陆之外」(两侧都是系统 DNS)
// 「之外」的组没列中国就算(它会用在中国大陆),列了就不算
export const shareGroupInCn = (g) => {
  const listed = Array.isArray(g && g.regions) && g.regions.includes('CN')
  return g && g.regionMatch === 'outside' ? !listed : listed
}
export const shareGroupDnsDefaults = (inCn) => regionDnsDefaults(inCn ? 'cn' : 'intl')

// 没写协议 / 端口的补默认;写了不对的原样留着,让校验报出来
const upstreamOf = (server, protocol, port, fallbackProtocol) => (isWanUpstream(server)
  ? { server: WAN_UPSTREAM, protocol: 'udp', port: DEFAULT_DNS_PORT }
  : { server: String(server).trim(), protocol: protocol ?? fallbackProtocol, port: port ?? DEFAULT_DNS_PORT })
const FALLBACK_PROTOCOL = { direct: 'udp', proxy: 'tcp' }

// 补齐 / 换算成上面的形状。只整理形状,值对不对留给 validateShareRegions(读的时候不拦)
const normalizeShareGroupDns = (dns, inCn) => {
  const d = shareGroupDnsDefaults(inCn)
  if (!isPlainObject(dns)) return d
  if (!SIDES.some((side) => side in dns)) {
    // 老写法 { directResolver }:空 = 系统 DNS;代理侧那时候没有(回路由器的只发占位地址),按默认
    const resolver = typeof dns.directResolver === 'string' ? dns.directResolver.trim() : ''
    return resolver ? { ...d, direct: resolver, directProtocol: 'udp', directPort: DEFAULT_DNS_PORT } : d
  }
  const out = {}
  for (const side of SIDES) {
    const head = typeof dns[side] === 'string' && dns[side].trim()
      ? upstreamOf(dns[side], dns[`${side}Protocol`], dns[`${side}Port`], FALLBACK_PROTOCOL[side])
      : { server: d[side], protocol: d[`${side}Protocol`], port: d[`${side}Port`] }
    const extras = (Array.isArray(dns[`${side}Extras`]) ? dns[`${side}Extras`] : [])
      .filter((x) => isPlainObject(x) && typeof x.server === 'string' && x.server.trim())
      .map((x) => upstreamOf(x.server, x.protocol, x.port, FALLBACK_PROTOCOL[side]))
    Object.assign(out, { [side]: head.server, [`${side}Protocol`]: head.protocol, [`${side}Port`]: head.port, [`${side}Extras`]: extras })
  }
  return out
}

const legacyName = (name) => {
  const pick = LEGACY_NAME_LOCALES.map((l) => name[l]).find((v) => typeof v === 'string' && v.trim())
    ?? Object.values(name).find((v) => typeof v === 'string' && v.trim())
  return typeof pick === 'string' ? pick.trim() : ''
}

// 一组整理成现在的形状(老写法换算掉);不是对象的原样还回去,由校验去拦
export const normalizeShareGroup = (g) => {
  if (!isPlainObject(g)) return g
  return {
    id: g.id,
    name: typeof g.name === 'string' ? g.name.trim() : isPlainObject(g.name) ? legacyName(g.name) : '',
    description: typeof g.description === 'string' ? g.description.trim() : '',
    regions: g.regions,
    ...(g.regionMatch === 'outside' ? { regionMatch: 'outside' } : {}),
    ...(g.default === true ? { default: true } : {}),
    rules: g.rules,
    catchAll: g.catchAll,
    dns: normalizeShareGroupDns(g.dns, shareGroupInCn(g)),
  }
}

export const DEFAULT_SHARE_REGIONS = Object.freeze(JSON.parse(fs.readFileSync(SHARE_REGIONS_DEFAULT_FILE, 'utf8')).groups.map(normalizeShareGroup))

// 现在生效的几组(老写法已换算);App 和面板拿到的都是这份
export const effectiveShareRegions = (profile) =>
  (Array.isArray(profile && profile.shareRegions) && profile.shareRegions.length ? profile.shareRegions : DEFAULT_SHARE_REGIONS).map(normalizeShareGroup)

// 客户端拿它判断要不要重新拉(内容一变就变)
export const shareRegionsVersion = (groups) => createHash('sha256').update(JSON.stringify(groups)).digest('hex').slice(0, 16)

// 一组的 DNS 有没有问题(英文,和别的校验一致);没问题返回 null
const shareGroupDnsError = (g) => {
  const d = g.dns
  for (const side of SIDES) {
    const extras = d[`${side}Extras`]
    if (extras.length > MAX_DNS_EXTRAS) return `shareRegions[${g.id}].dns.${side}Extras allows at most ${MAX_DNS_EXTRAS} backups`
    const entries = [{ server: d[side], protocol: d[`${side}Protocol`], port: d[`${side}Port`] }, ...extras]
    for (const e of entries) {
      if (isWanUpstream(e.server)) continue
      if (!isValidDnsUpstream(e.server)) return `shareRegions[${g.id}].dns.${side} must be an IP address or the system DNS: ${JSON.stringify(e.server)}`
      if (!isDnsProtocol(e.protocol)) return `shareRegions[${g.id}].dns.${side} protocol must be udp or tcp`
      if (!isValidDnsPort(e.port)) return `shareRegions[${g.id}].dns.${side} port must be 1-65535`
    }
    const keys = entries.map((e) => e.server)
    if (new Set(keys).size !== keys.length) return `shareRegions[${g.id}].dns.${side} lists the same upstream twice`
  }
  if (shareGroupInCn(g) && [d.proxy, ...d.proxyExtras.map((x) => x.server)].some(isWanUpstream)) {
    return `shareRegions[${g.id}]: a group for Mainland China cannot use the system DNS on the proxy side (it is polluted for foreign domains)`
  }
  return null
}

// 返回错误说明(英文,和 validateProfilePatch 其余项一致);合法返回 null。空数组合法:回到默认三组。
// 先按 normalizeShareGroup 整理再查,老写法(多语种名字、directResolver)也收——比如以前导出的备份
export const validateShareRegions = (input) => {
  if (!Array.isArray(input)) return 'shareRegions must be an array'
  if (input.length > MAX_GROUPS) return `shareRegions allows at most ${MAX_GROUPS} groups`
  if (!input.length) return null
  if (input.some((g) => !isPlainObject(g))) return 'shareRegions entries must be objects'
  if (input.some((g) => 'default' in g && typeof g.default !== 'boolean')) return 'shareRegions[].default must be a boolean'
  if (input.some((g) => 'regionMatch' in g && !['inside', 'outside'].includes(g.regionMatch))) return 'shareRegions[].regionMatch must be inside or outside'
  const groups = input.map(normalizeShareGroup)
  const ids = new Set()
  const claimed = new Map()
  let defaults = 0
  for (const g of groups) {
    if (typeof g.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(g.id)) return 'shareRegions[].id must match /^[a-z0-9_-]{1,32}$/'
    if (ids.has(g.id)) return `shareRegions[].id duplicated: ${g.id}`
    ids.add(g.id)
    if (!g.name) return `shareRegions[${g.id}].name is required`
    if (g.name.length > SHARE_GROUP_NAME_MAX) return `shareRegions[${g.id}].name must be <= ${SHARE_GROUP_NAME_MAX} chars`
    if (g.description.length > SHARE_GROUP_DESCRIPTION_MAX) return `shareRegions[${g.id}].description must be <= ${SHARE_GROUP_DESCRIPTION_MAX} chars`
    if (!Array.isArray(g.regions) || g.regions.some((r) => typeof r !== 'string' || !/^[A-Z]{2}$/.test(r))) {
      return `shareRegions[${g.id}].regions must be ISO 3166-1 alpha-2 codes`
    }
    if (g.regionMatch === 'outside') {
      if (!g.regions.length) return `shareRegions[${g.id}] is used outside its regions, so it needs at least one region`
    } else {
      // 自动定位按地区选组:同一个地区只能归一个「在这些地区」的组
      for (const r of g.regions) {
        if (claimed.has(r)) return `region ${r} is in both ${claimed.get(r)} and ${g.id}`
        claimed.set(r, g.id)
      }
    }
    if (g.default === true) defaults++
    if (!SHARE_REGION_ACTIONS.includes(g.catchAll)) return `shareRegions[${g.id}].catchAll must be one of ${SHARE_REGION_ACTIONS.join(', ')}`
    const dnsError = shareGroupDnsError(g)
    if (dnsError) return dnsError
    if (!Array.isArray(g.rules) || g.rules.length > MAX_RULES) return `shareRegions[${g.id}].rules must be an array (<= ${MAX_RULES})`
    for (const r of g.rules) {
      if (!isPlainObject(r)) return `shareRegions[${g.id}].rules entries must be objects`
      if (!SHARE_REGION_RULE_TYPES.includes(r.type)) return `shareRegions[${g.id}].rules[].type must be one of ${SHARE_REGION_RULE_TYPES.join(', ')}`
      if (!SHARE_REGION_ACTIONS.includes(r.action)) return `shareRegions[${g.id}].rules[].action must be one of ${SHARE_REGION_ACTIONS.join(', ')}`
      const value = typeof r.value === 'string' ? r.value.trim() : ''
      const ok = r.type === 'geosite' || r.type === 'geoip' ? GEO_NAME.test(value)
        : r.type === 'ipcidr' ? normalizeCidr(value) !== ''
          : r.type === 'ruleUrl' ? RULE_URL.test(value) && value.length <= RULE_URL_MAX
            : DOMAIN.test(value)
      if (!ok) return `shareRegions[${g.id}] has an invalid ${r.type} rule: ${JSON.stringify(r.value)}`
    }
  }
  if (defaults !== 1) return 'shareRegions needs exactly one default group (used when no region matches)'
  return null
}

// 地区组引用的规则集链接(去重)。optional:地区分流只给手机用,拉不到不能让路由器自己的部署失败(system/rule-lists.mjs)
export const collectShareRegionRuleUrls = (groups) => {
  const seen = new Map()
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const r of Array.isArray(g && g.rules) ? g.rules : []) {
      const url = r && r.type === 'ruleUrl' && typeof r.value === 'string' ? r.value.trim() : ''
      if (url && !seen.has(url)) seen.set(url, listTagForUrl(url))
    }
  }
  return [...seen.entries()].map(([url, tag]) => ({ url, tag, optional: true }))
}

// 发给 App 的那份。rulesVersion 2(新 App,请求带 rules=2):全部类型,规则集链接带上路由器编好的几份
// sets: [{ tag, kind: domain | ip, sha256 }](还没编好就是空的,App 当这条不生效);1(老 App):只留它认得的五种
export const shareRegionsForClient = (groups, { rulesVersion = 1, setsFor = () => [] } = {}) => groups.map((g) => ({
  ...g,
  rules: (Array.isArray(g.rules) ? g.rules : [])
    .filter((r) => rulesVersion >= 2 || SHARE_REGION_LEGACY_RULE_TYPES.includes(r.type))
    .map((r) => (r.type === 'ruleUrl' ? { ...r, sets: setsFor(String(r.value || '').trim()) } : r)),
}))
