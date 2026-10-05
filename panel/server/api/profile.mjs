import express from 'express'
import { TUN_STACKS, TUN_MTU_MIN, TUN_MTU_MAX, TUN_MSS_MIN, TUN_MSS_MAX, isTunStack, isTunMtu, isTunMss } from '../engine/tun-options.mjs'
import { validateDnsFilter } from '../engine/dns-filter.mjs'
import { DNS_REWRITE_DEFAULTS, validateDnsRewrite } from '../engine/dns-rewrite.mjs'
import { RESERVED_PORTS, SERVER_PROTOCOLS, SS_METHODS } from '../engine/servers.mjs'
import { normalizeServerInfo, validateServerInfo } from '../engine/server-info.mjs'
import { validateShareRegions } from '../engine/share-regions.mjs'
import { clientMatch, isIpOrCidr, isMac } from '../engine/client-routes.mjs'
import { validateChainProxies } from '../engine/chain-proxy.mjs'
import { CUSTOM_RULE_TYPES, FALLBACK_TAG, parsePortSpec } from '../engine/routing-model.mjs'
import { normalizeDnsUpstream, DNS_PROTOCOLS, DNS_REGIONS, MAX_DNS_EXTRAS, isValidDnsPort, isValidDnsUpstream, isWanUpstream, regionDnsError } from '../engine/dns-upstream.mjs'
import { cancelRegionDetect } from '../system/router-region.mjs'
import { ICON_SCALE_LIMIT, builtinTags, normalizeGroups } from '../engine/user-groups.mjs'
import { DNSMASQ_OUTBOUND_TAG } from '../engine/config.mjs'
import { appliedSummary } from './subscriptions.mjs'
import { saveNameError } from '../engine/name-guard.mjs'

// 站点集不能叫的名字:节点组名、内置直连/拒绝现在的名字、dnsmasq 回送出站——都是同一个出站命名空间
export const reservedPolicyNames = (groups) => {
  const normalized = normalizeGroups(groups || [])
  const builtin = builtinTags(groups || [])
  return [...new Set([...normalized.map((g) => g.name), builtin.direct, builtin.block, DNSMASQ_OUTBOUND_TAG])]
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
const isBoolean = (v) => typeof v === 'boolean'
const isStringArray = (v) => Array.isArray(v) && v.every(isString)

const DNS_MODES = new Set(['off', 'hijack', 'dnsmasq'])
const isHttpUrl = (v) => isString(v) && /^https?:\/\/[^\s]+$/.test(v.trim())

// 规则集 tag(policies[].rulesets / 前置自定义分流的规则集行)最终会原样拼进生成配置的
// rule_set.path,并作为参数传给 `sing-box rule-set match`(见 engine/routing.mjs、
// api/penetration.mjs)。execFile 不经 shell,所以不是命令注入,但放过 "../../../etc/passwd"
// 这类值意味着任意路径读取尝试 + 生成配置本身被写坏,必须在写入 store 之前拦截。
// 上游的规则集名里有 @ 和 !(geosite-36kr@ads、geosite-geolocation-!cn 这类,
// 1876 个里占 348 个),两者都能原样出现在 URL 路径和文件名里。挡住的是 / 和 ..
// ——那才是路径穿越。
const RULESET_TAG_PATTERN = /^[A-Za-z0-9._!@-]+$/
const isValidRulesetTag = (v) => isString(v) && RULESET_TAG_PATTERN.test(v)

// 只校验 patch 里"出现"的字段——深合并本身保证未提及字段维持已有值(来自 DEFAULT_PROFILE
// 或此前已通过校验的写入),所以一个只碰 ipv6 的 patch 不应因为没带 dns 而报错。
// 校验通过返回 null;失败返回一条可直接塞进 400 响应体的错误说明。
// reservedNames:站点集不能用的名字——节点组的名字、内置直连/拒绝现在叫什么、dnsmasq 回送出站。
// 站点集名就是内核里的出站 tag,和这些撞上会生成两个同名出站(内核 FATAL)。
// 图标缩放:整数像素偏移,范围直接用 engine/user-groups.mjs 的 ICON_SCALE_LIMIT,两边不会各改各的
const isIconScale = (v) => Number.isInteger(v) && Math.abs(v) <= ICON_SCALE_LIMIT

export const validateProfilePatch = (patch, { reservedNames = [] } = {}) => {
  if (!isPlainObject(patch)) return 'patch must be an object'
  if (isPlainObject(patch.dns) && 'filter' in patch.dns) {
    const error = validateDnsFilter(patch.dns.filter)
    if (error) return error
  }

  if ('ipv6' in patch && !isBoolean(patch.ipv6)) {
    return 'ipv6 must be a boolean'
  }
  if ('ipv6Proxy' in patch && !['node', 'ipv4', 'bypass'].includes(patch.ipv6Proxy)) {
    return 'ipv6Proxy must be one of node, ipv4, bypass'
  }
  if ('rejectQuic' in patch && !isBoolean(patch.rejectQuic)) {
    return 'rejectQuic must be a boolean'
  }
  if ('directBypass' in patch && !isBoolean(patch.directBypass)) {
    return 'directBypass must be a boolean'
  }
  // tun 参数(engine/tun-options.mjs):协议栈三选一,MTU / MSS 是 0(默认 / 不钳制)或范围内的整数
  if ('tun' in patch) {
    if (!isPlainObject(patch.tun)) return 'tun must be an object'
    if ('autoRedirect' in patch.tun && !isBoolean(patch.tun.autoRedirect)) return 'tun.autoRedirect must be a boolean'
    if ('stack' in patch.tun && !isTunStack(patch.tun.stack)) return `tun.stack must be one of ${TUN_STACKS.join(', ')}`
    if ('mtu' in patch.tun && !isTunMtu(patch.tun.mtu)) return `tun.mtu must be 0 (kernel default) or an integer between ${TUN_MTU_MIN} and ${TUN_MTU_MAX}`
    if ('tcpMss' in patch.tun && !isTunMss(patch.tun.tcpMss)) return `tun.tcpMss must be 0 (off) or an integer between ${TUN_MSS_MIN} and ${TUN_MSS_MAX}`
  }
  for (const key of ['bypassPorts', 'bypassPortsWhitelist']) {
    if (key in patch && !(isString(patch[key]) && (!patch[key].trim() || parsePortSpec(patch[key])))) {
      return `${key} must be empty or ports / ranges like "21114-21119, 2233"`
    }
  }
  if ('bypassPortsMode' in patch && !(patch.bypassPortsMode === 'blacklist' || patch.bypassPortsMode === 'whitelist')) {
    return 'bypassPortsMode must be "blacklist" or "whitelist"'
  }
  // 「直连和代理切换重启内核」开关的两个老键(v0.1.207 的 restartOnClassFlip、v0.1.208 ~ v0.1.209 的 restartOnFlip):
  // v0.1.210 起没有这个开关、一律热切换。老版本导出的备份里会带着,放行;落库时由 store 删掉
  if ('restartOnFlip' in patch && !isBoolean(patch.restartOnFlip)) {
    return 'restartOnFlip must be a boolean'
  }
  if ('restartOnClassFlip' in patch && !isBoolean(patch.restartOnClassFlip)) {
    return 'restartOnClassFlip must be a boolean'
  }
  if ('directForNodes' in patch && !isBoolean(patch.directForNodes)) {
    return 'directForNodes must be a boolean'
  }

  for (const key of ['testUrl', 'directTestUrl']) {
    if (key in patch && !isHttpUrl(patch[key])) return `${key} must be an http(s) URL`
  }

  // 站点集里的规则集链接:必须是 http(s) 网址(部署时会去拉,拉回来的东西要编成规则集)
  if ('routing' in patch && isPlainObject(patch.routing) && Array.isArray(patch.routing.policies)) {
    for (const p of patch.routing.policies) {
      if (!isPlainObject(p) || !('ruleUrls' in p)) continue
      if (!Array.isArray(p.ruleUrls)) return 'routing.policies[].ruleUrls must be an array'
      if (p.ruleUrls.some((u) => typeof u !== 'string' || !/^https?:\/\/[^\s]+$/i.test(u.trim()))) {
        return 'routing.policies[].ruleUrls must be http(s) URLs'
      }
    }
  }

  // 分析数据保留时长(月)
  if ('traffic' in patch) {
    const tr = patch.traffic
    if (!isPlainObject(tr)) return 'traffic must be an object'
    if ('keepMonths' in tr && !(Number.isInteger(tr.keepMonths) && tr.keepMonths >= 1 && tr.keepMonths <= 36)) {
      return 'traffic.keepMonths must be an integer 1-36'
    }
  }

  // 自动更新计划:openbox {auto, hour, days, channel} / geo {auto, hour, days, channel}
  if ('updates' in patch) {
    const u = patch.updates
    if (!isPlainObject(u)) return 'updates must be an object'
    const isHour = (v) => Number.isInteger(v) && v >= 0 && v <= 23
    if ('openbox' in u) {
      const o = u.openbox
      if (!isPlainObject(o)) return 'updates.openbox must be an object'
      if ('auto' in o && !isBoolean(o.auto)) return 'updates.openbox.auto must be a boolean'
      if ('hour' in o && !isHour(o.hour)) return 'updates.openbox.hour must be an integer 0-23'
      if ('channel' in o && !['auto', 'direct', 'mirror'].includes(o.channel)) return 'updates.openbox.channel must be auto, direct or mirror'
      if ('checkChannel' in o && !['auto', 'direct', 'mirror'].includes(o.checkChannel)) return 'updates.openbox.checkChannel must be auto, direct or mirror'
      if ('days' in o && !(Number.isInteger(o.days) && o.days >= 1 && o.days <= 30)) return 'updates.openbox.days must be an integer 1-30'
    }
    if ('geo' in u) {
      const g = u.geo
      if (!isPlainObject(g)) return 'updates.geo must be an object'
      if ('auto' in g && !isBoolean(g.auto)) return 'updates.geo.auto must be a boolean'
      if ('hour' in g && !isHour(g.hour)) return 'updates.geo.hour must be an integer 0-23'
      if ('days' in g && !(Number.isInteger(g.days) && g.days >= 1 && g.days <= 30)) return 'updates.geo.days must be an integer 1-30'
      if ('channel' in g && !['auto', 'direct', 'mirror'].includes(g.channel)) return 'updates.geo.channel must be auto, direct or mirror'
      if ('checkChannel' in g && !['auto', 'direct', 'mirror'].includes(g.checkChannel)) return 'updates.geo.checkChannel must be auto, direct or mirror'
    }
  }

  // 共享网络手机客户端的「地区分流」(engine/share-regions.mjs):不进路由器内核配置
  if ('shareRegions' in patch) {
    const error = validateShareRegions(patch.shareRegions)
    if (error) return error
  }
  if ('servers' in patch) {
    const error = validateServers(patch.servers)
    if (error) return error
  }
  // 设置 · 客户端的「路由器标识」(engine/server-info.mjs):App 里节点 / 配置卡片显示的名称、图标、地区
  if ('serverInfo' in patch) {
    const error = validateServerInfo(patch.serverInfo)
    if (error) return error
  }

  if ('clientRoutes' in patch) {
    const error = validateClientRoutes(patch.clientRoutes)
    if (error) return error
  }

  // 链式代理(engine/chain-proxy.mjs):形状 + 节点内容解析得出来;和现有节点 / 节点组重名在下面的路由里查(要读库)
  if ('chainProxies' in patch) {
    const error = validateChainProxies(patch.chainProxies)
    if (error) return error
  }

  if ('dns' in patch) {
    const dns = patch.dns
    if (!isPlainObject(dns)) return 'dns must be an object'
    if ('mode' in dns && !DNS_MODES.has(dns.mode)) {
      return 'dns.mode must be one of off, hijack, dnsmasq'
    }
    if ('fakeIpForProxy' in dns && !isBoolean(dns.fakeIpForProxy)) return 'dns.fakeIpForProxy must be a boolean'
    // 路由器在哪:cn 中国大陆 / intl 中国大陆之外(engine/dns-upstream.mjs 的 DNS_REGIONS)
    if ('region' in dns && !DNS_REGIONS.includes(dns.region)) return `dns.region must be one of ${DNS_REGIONS.join(', ')}`
    // 两个上游只收裸 IP(带域名的上游还得另找 DNS 去解析它)或「上游 DNS」记号 wan(系统的上游 DNS);协议单独一个字段
    // (engine/dns-upstream.mjs)。路由器在中国大陆时代理侧不能用上游 DNS,要和档案合并之后才判得了,在 PUT 里判(regionDnsError)
    for (const key of ['direct', 'proxy']) {
      if (key in dns && !isWanUpstream(dns[key]) && !isValidDnsUpstream(dns[key])) return `dns.${key} must be an IP address or "wan"`
    }
    for (const key of ['directProtocol', 'proxyProtocol']) {
      if (key in dns && !DNS_PROTOCOLS.includes(dns[key])) return `dns.${key} must be one of ${DNS_PROTOCOLS.join(', ')}`
    }
    for (const key of ['directPort', 'proxyPort']) {
      if (key in dns && !isValidDnsPort(dns[key])) return `dns.${key} must be an integer between 1 and 65535`
    }
    // 两侧的备用上游:各最多 3 个,每个和主上游一样只收裸 IP + udp/tcp + 端口,而且不能和同侧的重复
    for (const [key, primaryKey] of [['directExtras', 'direct'], ['proxyExtras', 'proxy']]) {
      if (!(key in dns)) continue
      const list = dns[key]
      if (!Array.isArray(list) || list.length > MAX_DNS_EXTRAS) return `dns.${key} must be an array of at most ${MAX_DNS_EXTRAS} upstreams`
      for (const item of list) {
        if (!isPlainObject(item)) return `dns.${key}[] must be objects`
        if (!isWanUpstream(item.server) && !isValidDnsUpstream(item.server)) return `dns.${key}[].server must be an IP address or "wan"`
        if ('protocol' in item && !DNS_PROTOCOLS.includes(item.protocol)) return `dns.${key}[].protocol must be one of ${DNS_PROTOCOLS.join(', ')}`
        if ('port' in item && !isValidDnsPort(item.port)) return `dns.${key}[].port must be an integer between 1 and 65535`
      }
      const keyOf = (v) => (isWanUpstream(v) ? v : normalizeDnsUpstream(v || ''))
      const all = [keyOf(dns[primaryKey]), ...list.map((x) => keyOf(x.server))].filter(Boolean)
      if (new Set(all).size !== all.length) return `dns.${key}[] must not repeat an upstream address`
    }
    if ('rewrite' in dns) {
      const bad = validateDnsRewrite(dns.rewrite)
      if (bad) return bad
    }
  }

  if ('routing' in patch) {
    const routing = patch.routing
    if (!isPlainObject(routing)) return 'routing must be an object'

    // 兜底站点集的默认选中项。'proxy' 是迁移留下的占位(第一个节点组),
    // 其余就是一个出站名(direct / 某个节点组 / block),叫什么由用户的组名决定。
    if ('fallbackDefault' in routing && !isString(routing.fallbackDefault)) {
      return 'routing.fallbackDefault must be a string'
    }

    // 兜底站点集的名字/图标。名字就是内核里的出站 tag,不能为空
    if ('fallbackName' in routing && (!isString(routing.fallbackName) || !routing.fallbackName.trim())) {
      return 'routing.fallbackName must be a non-empty string'
    }
    if ('fallbackIcon' in routing && !isString(routing.fallbackIcon)) {
      return 'routing.fallbackIcon must be a string'
    }
    if ('fallbackIconScale' in routing && !isIconScale(routing.fallbackIconScale)) {
      return `routing.fallbackIconScale must be an integer within ±${ICON_SCALE_LIMIT}`
    }

    // 代理页「策略」页签的显示顺序(站点集名字的数组),和命中顺序(policies 的顺序)分开存。
    // 只校验形状;名单里对不上的名字,前端读的时候会忽略
    if ('displayOrder' in routing && !isStringArray(routing.displayOrder)) {
      return 'routing.displayOrder must be an array of strings'
    }

    if ('custom' in routing) {
      const error = validateCustomPolicy(routing.custom)
      if (error) return error
    }

    if ('policies' in routing) {
      const error = validatePolicies(routing.policies, isString(routing.fallbackName) ? routing.fallbackName.trim() : '', reservedNames)
      if (error) return error
    }
  }

  return null
}

// 终端分流:来源必须是合法 IP / 网段;出口是个出站名(存不存在生成配置时再看)
export const validateClientRoutes = (list) => {
  if (!Array.isArray(list)) return 'clientRoutes must be an array'
  const ids = new Set()
  for (const r of list) {
    if (!isPlainObject(r)) return 'clientRoutes entries must be objects'
    if (!isString(r.id) || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id)) return 'clientRoutes[].id must match /^[A-Za-z0-9_-]{1,40}$/'
    if (ids.has(r.id)) return `clientRoutes[].id duplicated: ${r.id}`
    ids.add(r.id)
    if ('enabled' in r && !isBoolean(r.enabled)) return 'clientRoutes[].enabled must be a boolean'
    if (!isString(r.name) || !r.name.trim() || r.name.length > 40) return 'clientRoutes[].name must be a non-empty string (<= 40 chars)'
    if ('match' in r && r.match !== 'ip' && r.match !== 'mac') return 'clientRoutes[].match must be ip or mac'
    if ('sources' in r && !isStringArray(r.sources)) return 'clientRoutes[].sources must be an array of strings'
    if ('macs' in r && !isStringArray(r.macs)) return 'clientRoutes[].macs must be an array of strings'
    if ('bypass' in r && !isBoolean(r.bypass)) return 'clientRoutes[].bypass must be a boolean'
    if ('admit' in r && !isBoolean(r.admit)) return 'clientRoutes[].admit must be a boolean'
    if (r.bypass === true && r.admit === true) return 'clientRoutes[] cannot be both bypass and admit'
    // 终端按 IP 或按 MAC 认,二选一(engine/client-routes.mjs 的 clientMatch;老档案没有 match 时按老规矩推断)。
    // 两份都校验格式,按哪种认的那份不能空
    const bad = (r.sources || []).find((x) => !isIpOrCidr(x))
    if (bad !== undefined) return `clientRoutes[].sources contains an invalid IP/CIDR: ${bad}`
    const badMac = (r.macs || []).find((x) => !isMac(x))
    if (badMac !== undefined) return `clientRoutes[].macs contains an invalid MAC: ${badMac}`
    if (clientMatch(r) === 'mac') {
      if (!Array.isArray(r.macs) || !r.macs.length) return 'clientRoutes[].macs must be a non-empty array when matching by MAC'
    } else if (!Array.isArray(r.sources) || !r.sources.length) {
      return 'clientRoutes[].sources must be a non-empty array of strings'
    }
    // 不进内核 / 只让这些进内核不用填出站;指定出站的要填
    if (r.bypass !== true && r.admit !== true && (!isString(r.outbound) || !r.outbound.trim())) {
      return 'clientRoutes[].outbound must be a non-empty string'
    }
  }
  return null
}

// 共享网络的服务器。id 会拼进入站 tag 和 uci 段名,限定字符;端口不能撞面板/内核自用的,
// 也不能互相重复;各协议缺了凭据就开不起来,直接挡在保存这一步。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const validateServers = (servers) => {
  if (!Array.isArray(servers)) return 'servers must be an array'
  const ports = new Set()
  const ids = new Set()
  for (const s of servers) {
    if (!isPlainObject(s)) return 'servers entries must be objects'
    if (!isString(s.id) || !/^[A-Za-z0-9_-]{1,40}$/.test(s.id)) return 'servers[].id must match /^[A-Za-z0-9_-]{1,40}$/'
    if (ids.has(s.id)) return `servers[].id duplicated: ${s.id}`
    ids.add(s.id)
    if ('enabled' in s && !isBoolean(s.enabled)) return 'servers[].enabled must be a boolean'
    if (!isString(s.name) || !s.name.trim() || s.name.length > 40) return 'servers[].name must be a non-empty string (<= 40 chars)'
    if (!SERVER_PROTOCOLS.includes(s.protocol)) return `servers[].protocol must be one of ${SERVER_PROTOCOLS.join(', ')}`
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return 'servers[].port must be an integer 1-65535'
    if (RESERVED_PORTS.has(s.port)) return `servers[].port ${s.port} is reserved`
    if (ports.has(s.port)) return `servers[].port duplicated: ${s.port}`
    ports.add(s.port)
    if ('address' in s && !isString(s.address)) return 'servers[].address must be a string'
    if ('tls' in s && !isBoolean(s.tls)) return 'servers[].tls must be a boolean'
    if ('obfs' in s && !isString(s.obfs)) return 'servers[].obfs must be a string'
    if ('username' in s && !isString(s.username)) return 'servers[].username must be a string'
    // mixed 的认证可选,但用户名和密码要成对:只有其中一个,客户端那边没法填
    if (s.protocol === 'mixed' && Boolean(s.username) !== Boolean(s.password)) {
      return 'servers[].username and password must be set together for mixed'
    }
    const needPassword = s.protocol === 'shadowsocks' || s.protocol === 'tuic' || s.protocol === 'hysteria2'
    if (needPassword && (!isString(s.password) || !s.password)) return `servers[].password is required for ${s.protocol}`
    const needUuid = s.protocol === 'vless' || s.protocol === 'tuic'
    if (needUuid && (!isString(s.uuid) || !UUID_RE.test(s.uuid))) return `servers[].uuid must be a UUID for ${s.protocol}`
    if (s.protocol === 'shadowsocks' && !SS_METHODS.includes(s.method)) return `servers[].method must be one of ${SS_METHODS.join(', ')}`
  }
  return null
}

// 策略的规则集 tag 和老的 categories 一样会被拼进 .srs 路径,同一条安全边界。
// 其余条件(域名/关键词/CIDR)只会进 JSON 配置的值位,不参与路径拼接,所以只做
// 类型检查,不限制字符——域名里带下划线、CIDR 带斜杠都是合法的。
const POLICY_LIST_FIELDS = ['domain', 'domainSuffix', 'domainKeyword', 'ipCidr']

// 前置自定义分流(routing.custom):固定置顶那一条,一行一条规则、一行一个出口。
// 名字只是界面上的标题,不当出站 tag 用,所以不查重名;但每行的 outbound 会原样写进内核
// 规则的 outbound 字段,规则集名会被拼进 .srs 路径,这两处照站点集同一道校验来。
const validateCustomPolicy = (custom) => {
  if (!isPlainObject(custom)) return 'routing.custom must be an object'
  if ('name' in custom && (!isString(custom.name) || !custom.name.trim())) {
    return 'routing.custom.name must be a non-empty string'
  }
  if ('icon' in custom && !isString(custom.icon)) return 'routing.custom.icon must be a string'
  if ('iconScale' in custom && !isIconScale(custom.iconScale)) {
    return `routing.custom.iconScale must be an integer within ±${ICON_SCALE_LIMIT}`
  }
  if ('enabled' in custom && !isBoolean(custom.enabled)) return 'routing.custom.enabled must be a boolean'
  if ('rules' in custom) {
    if (!Array.isArray(custom.rules)) return 'routing.custom.rules must be an array'
    for (const r of custom.rules) {
      if (!isPlainObject(r)) return 'routing.custom.rules entries must be objects'
      if (!CUSTOM_RULE_TYPES.includes(r.type)) {
        return `routing.custom.rules[].type must be one of ${CUSTOM_RULE_TYPES.join(', ')}`
      }
      if (!isString(r.value) || !r.value.trim()) return 'routing.custom.rules[].value is required'
      if (!isString(r.outbound) || !r.outbound.trim()) return 'routing.custom.rules[].outbound is required'
      if ('note' in r && !isString(r.note)) return 'routing.custom.rules[].note must be a string'
      if (r.type === 'ruleUrl' && !/^https?:\/\//i.test(r.value.trim())) {
        return 'routing.custom.rules[].value must be an http(s) URL when type is ruleUrl'
      }
      if (r.type === 'port' && !parsePortSpec(r.value)) {
        return 'routing.custom.rules[].value must be ports like 51820 or 1000-2000 (comma separated) when type is port'
      }
      if (r.type === 'geosite' || r.type === 'geoip' || r.type === 'ruleset') {
        const tag = r.type === 'ruleset' ? r.value.trim() : `${r.type}-${r.value.trim()}`
        if (!isValidRulesetTag(tag)) {
          return 'routing.custom.rules[] ruleset name must match /^[A-Za-z0-9._-]+$/'
        }
      }
    }
  }
  return null
}

const validatePolicies = (policies, fallbackName = '', reservedNames = []) => {
  if (!Array.isArray(policies)) return 'routing.policies must be an array'
  const reserved = new Set(reservedNames)
  const seen = new Set()
  for (const p of policies) {
    if (!isPlainObject(p)) return 'routing.policies entries must be objects'
    if (!isString(p.name) || !p.name.trim()) return 'routing.policies[].name is required'
    if (seen.has(p.name.trim())) return `routing.policies[].name "${p.name.trim()}" is duplicated`
    seen.add(p.name.trim())
    if (reserved.has(p.name.trim())) {
      return `routing.policies[].name "${p.name.trim()}" collides with a node group / built-in outbound name`
    }
    // 兜底站点集占着的名字(默认「其他」,或用户改过的):重名会在内核里生成两个同名出站
    if (p.name.trim() === FALLBACK_TAG || (fallbackName && p.name.trim() === fallbackName)) {
      return `routing.policies[].name "${p.name.trim()}" is reserved for the built-in fallback`
    }
    if ('enabled' in p && !isBoolean(p.enabled)) return 'routing.policies[].enabled must be a boolean'
    if ('default' in p && !isString(p.default)) return 'routing.policies[].default must be a string'
    if ('icon' in p && !isString(p.icon)) return 'routing.policies[].icon must be a string'
    if ('iconScale' in p && !isIconScale(p.iconScale)) return `routing.policies[].iconScale must be an integer within ±${ICON_SCALE_LIMIT}`
    if ('rulesets' in p) {
      if (!isStringArray(p.rulesets)) return 'routing.policies[].rulesets must be an array of strings'
      if (!p.rulesets.every(isValidRulesetTag)) {
        return 'routing.policies[].rulesets entries must match /^[A-Za-z0-9._-]+$/'
      }
    }
    for (const field of POLICY_LIST_FIELDS) {
      if (field in p && !isStringArray(p[field])) {
        return `routing.policies[].${field} must be an array of strings`
      }
    }
    // 每条规则的备注(GitHub #238):键是「类型:值」,值是一句话;只进档案、不进内核配置
    if ('notes' in p && !(isPlainObject(p.notes) && Object.values(p.notes).every(isString))) {
      return 'routing.policies[].notes must be an object of strings'
    }
  }
  return null
}

// 首次引导用的区域推荐默认值。首次引导只回答一件事:"其余流量走哪"——人在国内(CN)没被站点集
// 挑走的走代理,香港澳门 / 其他地区反过来。中国大陆那些具体规则由内置的站点集种子提供
// (见 store/openbox-store.mjs),这里不替用户改写规则。
const REGION_CODES = new Set(['CN', 'HKMO', 'OTHER'])
const buildRegionDefaults = (regionParam) => {
  const raw = isString(regionParam) && regionParam.trim() ? regionParam.trim().toUpperCase() : 'CN'
  // 不认识的地区按中国大陆算(引导页只有这三个选项,别的值只可能是手输/老链接)
  const region = REGION_CODES.has(raw) ? raw : 'CN'
  const fallbackDefault = region === 'CN' ? 'proxy' : 'direct'
  return {
    fallbackDefault,
    dns: { split: true },
    routing: { fallbackDefault },
  }
}

// 链式代理按 id 认出改名(同 id、名字变了),把所有按旧名字引用它的地方改成新名字。节点组直接写库;
// 档案里的引用改在 patch 上,和这次提交一起落库。返回 [{ from, to }]
export const applyChainRenames = (store, patch) => {
  const profile = store.getProfile() || {}
  const previous = new Map((Array.isArray(profile.chainProxies) ? profile.chainProxies : []).map((e) => [String(e && e.id || ''), e]))
  const renames = new Map()
  for (const e of patch.chainProxies) {
    if (!e || typeof e !== 'object') continue
    const old = previous.get(String(e.id || ''))
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (old && name && old.name !== name) renames.set(old.name, name)
  }
  if (!renames.size) return []
  const rename = (n) => (renames.has(n) ? renames.get(n) : n)
  store.setGroups(store.getGroups().map((g) => ({
    ...g,
    members: Array.isArray(g.members) ? g.members.map(rename) : g.members,
    lanes: Array.isArray(g.lanes) ? g.lanes.map((l) => ({ ...l, members: Array.isArray(l.members) ? l.members.map(rename) : l.members })) : g.lanes,
  })))
  const routing = profile.routing && typeof profile.routing === 'object' ? profile.routing : {}
  const policies = Array.isArray(patch.routing && patch.routing.policies) ? patch.routing.policies : routing.policies
  if (Array.isArray(policies) && policies.some((x) => x && typeof x === 'object' && renames.has(x.default))) {
    patch.routing = { ...(patch.routing || {}), policies: policies.map((x) => (x && typeof x === 'object' && renames.has(x.default) ? { ...x, default: rename(x.default) } : x)) }
  }
  const fallbackDefault = patch.routing && typeof patch.routing.fallbackDefault === 'string' ? patch.routing.fallbackDefault : routing.fallbackDefault
  if (renames.has(fallbackDefault)) patch.routing = { ...(patch.routing || {}), fallbackDefault: rename(fallbackDefault) }
  const routes = Array.isArray(patch.clientRoutes) ? patch.clientRoutes : profile.clientRoutes
  if (Array.isArray(routes) && routes.some((r) => r && typeof r === 'object' && renames.has(r.outbound))) {
    patch.clientRoutes = routes.map((r) => (r && typeof r === 'object' && renames.has(r.outbound) ? { ...r, outbound: rename(r.outbound) } : r))
  }
  patch.chainProxies = patch.chainProxies.map((e) => (e && typeof e === 'object' && renames.has(e.upstream) ? { ...e, upstream: rename(e.upstream) } : e))
  return [...renames].map(([from, to]) => ({ from, to }))
}

// 链式代理的名字就是内核里的出站 tag:和订阅节点、节点组、站点集(含兜底)重名的话,生成配置时链式节点会被当成
// 重复项丢掉。返回第一个撞上的名字,没有就是空串。PUT /profile 和导入(api/backup.mjs)共用
export const chainNameClash = ({ chainProxies, nodes, groups, policies }) => {
  const taken = new Set([
    ...(Array.isArray(nodes) ? nodes : []).map((n) => n && n.tag),
    ...(Array.isArray(groups) ? groups : []).map((g) => g && g.name),
    ...(Array.isArray(policies) ? policies : []).map((p) => p && p.name),
    FALLBACK_TAG,
  ].filter(Boolean))
  const hit = (Array.isArray(chainProxies) ? chainProxies : []).find((e) => e && taken.has(String(e.name || '').trim()))
  return hit ? String(hit.name).trim() : ''
}

// applyNow:链式代理 / 测速地址 / 站点集这些落在出站上的改动,存完在线换进内核再回复(api/hot-apply.mjs)
export const registerProfileRoutes = (app, { store, applyNow = null } = {}) => {
  const router = express.Router({ caseSensitive: true })
  router.use(express.json({ limit: '1mb' }))

  // 区域推荐默认——放在 GET / 前面注册,和 subscriptions.mjs 里 /preview 先于 / 的顺序一致,
  // 虽然这里都是字面量路径不存在遮蔽问题,但保持同样的可读习惯。
  router.get('/defaults', (req, res) => {
    // dnsRewriteDefaults:「DNS 重写」卡片的「恢复默认」按它把两条默认项放回去
    res.json({ defaults: buildRegionDefaults(req.query.region), dnsRewriteDefaults: DNS_REWRITE_DEFAULTS })
  })

  // 老档案的翻译(地区层 → 站点集、DoH 上游 → 裸地址)在 store 读档案时做并写回,这里拿到的已经是干净的
  router.get('/', (_req, res) => {
    res.json({ profile: store.getProfile() })
  })

  router.put('/', async (req, res) => {
    const patch = req.body || {}
    const error = validateProfilePatch(patch, { reservedNames: reservedPolicyNames(store.getGroups()) })
    if (error) {
      res.status(400).json({ error })
      return
    }
    // 链式代理的名字就是内核里的出站 tag:不能和订阅节点、节点组(含内置直连 / 拒绝)、站点集重名
    if (Array.isArray(patch.chainProxies)) {
      const routing = (patch.routing && typeof patch.routing === 'object' ? patch.routing : store.getProfile().routing) || {}
      const clash = chainNameClash({ chainProxies: patch.chainProxies, nodes: store.getNodes(), groups: store.getGroups(), policies: routing.policies })
      if (clash) {
        res.status(400).json({ error: `链式代理的名称「${clash}」已被节点、节点组或站点集占用,请换一个` })
        return
      }
    }
    // 站点集 / 链式代理和订阅节点、节点组、内置出口之间撞名就不能存(PM 2026-10-04:遇到重名不能保存;判断和 App 共用
    // engine/name-guard.mjs)。上面两道是老的细分检查,这一道补上站点集和订阅节点、只改站点集时和已有链式代理撞名
    if ((patch.routing && typeof patch.routing === 'object') || Array.isArray(patch.chainProxies)) {
      const current = store.getProfile() || {}
      const nameError = saveNameError({
        nodes: store.getNodes(),
        subscriptions: typeof store.getSubscriptions === 'function' ? store.getSubscriptions() : [],
        groups: store.getGroups(),
        routing: { ...(current.routing || {}), ...(patch.routing && typeof patch.routing === 'object' ? patch.routing : {}) },
        chainProxies: Array.isArray(patch.chainProxies) ? patch.chainProxies : current.chainProxies,
      }, [...(patch.routing && typeof patch.routing === 'object' ? ['policy'] : []), ...(Array.isArray(patch.chainProxies) ? ['chain'] : [])])
      if (nameError) {
        res.status(400).json({ error: nameError })
        return
      }
    }
    // 链式代理改名:名字就是出站 tag,节点组成员 / 故障转移页签成员 / 站点集默认出口 / 兜底 / 终端分流 / 别的链式代理的
    // 上游都按名字引用,和节点组改名(api/groups.mjs)一样按 id 认出改名、把引用一并迁移
    // 路由器在中国大陆时代理 DNS 不能用上游 DNS(中国大陆的 DNS 对境外域名有污染,用户 2026-10-02):按合并之后的整份判,
    // 只改地区、或只改代理上游都会被挡住
    if (patch.dns && typeof patch.dns === 'object') {
      const regionError = regionDnsError({ ...((store.getProfile() || {}).dns || {}), ...patch.dns })
      if (regionError) {
        res.status(400).json({ error: regionError })
        return
      }
    }
    const renamed = Array.isArray(patch.chainProxies) ? applyChainRenames(store, patch) : []
    if ('serverInfo' in patch) patch.serverInfo = normalizeServerInfo(patch.serverInfo)
    // App 里节点的图标、名称统一在「路由器标识」里设(用户 2026-10-04),共享服务器自己不再带图标:老数据里的一起丢掉
    if (Array.isArray(patch.servers)) patch.servers = patch.servers.map((server) => Object.fromEntries(Object.entries(server).filter(([key]) => key !== 'icon' && key !== 'iconSvg')))
    const profile = store.setProfile(patch)
    // 用户自己选了地区:后台按出口 IP 自动判的那一次就不做了(system/router-region.mjs)
    if (patch.dns && typeof patch.dns === 'object' && 'region' in patch.dns) cancelRegionDetect(store)
    let applied
    if (typeof applyNow === 'function' && ['chainProxies', 'testUrl', 'routing'].some((key) => key in patch)) {
      try { applied = appliedSummary(await applyNow()) } catch (error) { applied = { ok: false, changed: 0, reason: error instanceof Error ? error.message : String(error) } }
    }
    res.json({ profile, ...(renamed.length ? { renamed } : {}), ...(applied ? { applied } : {}) })
  })

  app.use('/api/openbox/profile', router)
}
