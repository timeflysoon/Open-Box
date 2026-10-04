import { flattenFlipRule } from '../engine/flip.mjs'
import { readFlipState } from '../system/flip-files.mjs'
import express from 'express'
import { builtinTags } from '../engine/user-groups.mjs'
import { loadEntries } from './rulesets.mjs'
import { decideDnsServer } from './route-test.mjs'
import { normalizeDnsRewrite } from '../engine/dns-rewrite.mjs'
import { normalizeRouting, routingFingerprint, splitNoDomainGuard } from '../engine/routing-model.mjs'
import { isCustomRule, ruleOwner } from '../engine/rule-owner.mjs'
import { readRuleListShapes } from '../system/rule-lists.mjs'
import { configMetaPath } from '../system/deploy.mjs'
import { macForIp } from './traffic.mjs'
import { isPrivateOrLoopbackIp } from './net-guard.mjs'
import { cidrContains } from '../system/local-subnets.mjs'
import { buildCurrentConfig, flipStateFromProfile } from './deploy-runner.mjs'
import net from 'node:net'
import { Resolver } from 'node:dns/promises'
import { FAKEIP_V4, FAKEIP_V6 } from '../engine/dns.mjs'
import { DNS_INBOUND_PORT } from '../engine/config.mjs'
import { ipIndexHas, loadRuleSetIndex, matchDomain, matchedDomainEntries, matchedIpEntries } from '../system/ruleset-index.mjs'
import { NODE_DIRECT_IP_TAG } from '../engine/direct-hosts.mjs'

export const CLASH_API_BASE = 'http://127.0.0.1:9095'

// 字面 IP 私有/回环/链路本地/CGNAT 判定抽到 net-guard.mjs,和 subscriptions.mjs 共用同一份
// 范围表与 IPv4-mapped IPv6 归一化逻辑(P4a 复审 Important 1:两处判定曾经各自维护,
// 逐渐产生偏差、留下绕过缺口)。

// 核心回归点:`sing-box rule-set match` 命中与不命中退出码都是 0,严禁用退出码判定命中。
// 经验事实(2026-07-27 对 sing-box 1.13.14 二进制实测):"match rules." 那一行
// 实际写在 **stderr**,stdout 恒为空——
//   $ sing-box rule-set match -f binary v.srs baidu.cn 2>/dev/null      → (stdout 为空)
//   $ sing-box rule-set match -f binary v.srs baidu.cn 2>&1 1>/dev/null → match rules.[0]: ...
// 因此判定必须同时看 stdout + stderr(而不是只看 stdout),这样即便未来版本把这行
// 挪回 stdout 也不会再次回归。不要"简化"回只测 stdout。
//
// P4b 终审 Important 1:`ctx.exec` 的真实实现(system/context-real.mjs)从不 throw——
// 二进制缺失、.srs 文件缺失、execFile 本身失败,统统折叠成 `{code:1, stdout:'', stderr:''}`,
// 和"进程正常跑完、只是没命中"在字节上完全无法区分。此前的实现把这种情况当成"未命中"返回,
// 于是穿透工具在自己都没能跑起来检查的时候,还会自信地告诉用户"没有规则命中,流量走
// PROXY"——这正是这个工具应该帮用户排查的那类故障,却在这里说了谎。
//
// 因此这里返回一个 { hit, error } 结构(而不是裸 boolean),三态而非两态:
//   - hit:true                  → 确认命中(看到 "match rules.")
//   - hit:false, error 未设置   → 确认不命中(进程正常跑完,没找到匹配——退出码 0)
//   - hit:false, error 已设置   → 没能确认(二进制/.srs 缺失,或进程异常退出且没有任何输出)
// 调用方(下面的路由 handler)必须把第三种情况当成"不知道",不能当成"确认不命中"。
export const matchRuleSet = async (ctx, paths, srsPath, target) => {
  // 前置存在性检查:比"跑了程序、看退出码/输出"更直接地区分"根本没能跑起来"这种情况,
  // 也不依赖 execFile 失败时 code/stdout/stderr 恰好长什么样子。
  const [singboxExists, srsExists] = await Promise.all([ctx.exists(paths.singbox), ctx.exists(srsPath)])
  if (!singboxExists) return { hit: false, error: `sing-box binary not found: ${paths.singbox}` }
  if (!srsExists) return { hit: false, error: `ruleset file not found: ${srsPath}` }

  // source 格式的本地规则集(订阅和节点站点直连)是 .json
  const format = String(srsPath).endsWith('.json') ? 'source' : 'binary'
  const { code, stdout, stderr } = await ctx.exec(paths.singbox, ['rule-set', 'match', '-f', format, srsPath, target])
  const combined = `${stdout || ''}${stderr || ''}`
  if (/^match rules\./m.test(combined)) return { hit: true }

  // 命中信息不在输出里。退出码本身对"命中与否"没有意义(见上),但一次真正跑完并给出
  // 明确"不命中"结果的调用,退出码是 0(即便这行以后又从 stderr 挪回别处,"跑完了、没
  // 报错"依然应该是 code 0)。code 非 0 又完全没有输出,是"进程没能正常跑完"最朴素的信号
  // ——例如 execFile 本身 spawn 失败(命令不存在/不可执行)时,context-real.mjs 就是这样
  // 折叠的:{code:1, stdout:'', stderr:''}。这种情况不能读成"确认不命中"。
  if (code !== 0 && !stdout && !stderr) {
    return { hit: false, error: `sing-box rule-set match exited ${code} with no output` }
  }
  return { hit: false }
}

// 策略带来的四类条件都能在本地判定,不必去 exec 内核。
const LOCAL_CONDITION_KEYS = ['domain', 'domain_suffix', 'domain_keyword', 'ip_cidr']

export const hasLocalCondition = (rule) =>
  LOCAL_CONDITION_KEYS.some((k) => Object.prototype.hasOwnProperty.call(rule, k))

// 「172.16.0.0/12 是否包含 172.20.1.1」这类判断,IPv4 / IPv6 都认(system/local-subnets.mjs 的
// 同一套解析器;以前只认 v4,写了 v6 段的规则查出来永远是"落到兜底"——复审 R5)
export const ipv4InCidr = (ip, cidr) => cidrContains(cidr, ip)

// 目标地址这一组条件:domain 全等、domain_suffix 后缀(含"就是它本身")、domain_keyword 子串、
// ip_cidr 网段包含。同一条规则里这几个字段是"或"的关系——sing-box 1.13.14 把它们都归进
// destinationAddressItems,任一命中就算目标地址命中(route/rule/rule_abstract.go)
// 1.14 起规则集和这些字段不再稳定地「或」(只有单条 default 规则的规则集才合并),所以生成器把规则集和域名 / IP
// 条件拆成紧邻的两条(routing-model.mjs 的 splitRuleSetConditions);这里按内核里的实际规则逐条判,自然对得上
export const matchLocalConditions = (rule, target) => {
  const host = String(target).toLowerCase()
  const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v])

  if (list(rule.domain).some((d) => String(d).toLowerCase() === host)) return true
  if (list(rule.domain_suffix).some((d) => {
    const suffix = String(d).toLowerCase()
    return host === suffix || host.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`)
  })) return true
  if (list(rule.domain_keyword).some((k) => host.includes(String(k).toLowerCase()))) return true
  if (list(rule.ip_cidr).some((c) => cidrContains(c, host))) return true
  return false
}

// 端口条件:port 是单个端口列表,port_range 是 "a:b"
const portMatches = (rule, port) => {
  const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v])
  if (list(rule.port).some((p) => Number(p) === port)) return true
  return list(rule.port_range).some((r) => {
    const [a, b] = String(r).split(':').map(Number)
    return Number.isInteger(a) && Number.isInteger(b) && port >= a && port <= b
  })
}

// 一条规则里不同类的条件是"与"的关系(sing-box 1.13.14:来源地址 / 来源端口 / 目标地址 / 目标端口
// 各自一组,组内任一命中即算该组命中,规则命中要求每个出现了的组都命中):
//   { ip_cidr: [tun 网段], port: [53] } 是"目标在 tun 网段 且 端口 53",不是二选一。
// 查询时没给来源 IP / 目标端口,而规则又要看它们:老实说"判不了"(undetermined),不能当成没命中
// 继续往下数——那样会把后面本不该命中的规则报成命中(复审 R5)。
// destMatch:目标地址那一组的结果(域名 / IP / ip_is_private / 规则集),由调用方算好传进来
export const evaluateRuleGroups = (rule, { destMatch, sourceIp, sourceMac, port, ipVersion }) => {
  const has = (k) => Object.prototype.hasOwnProperty.call(rule, k)
  const needs = []
  let miss = false
  // ip_version:连接的目标地址族(IPv6 分层里"走代理的 v6 明确拒绝"那几条规则用它)。目标是 IP 字面量时
  // 就是它的地址族;域名目标看调用方给的 ipVersion(终端拿到 A 还是 AAAA 才决定),没给就判不了
  if (has('ip_version')) {
    if (ipVersion === 4 || ipVersion === 6) {
      if (Number(rule.ip_version) !== ipVersion) miss = true
    } else needs.push('ipVersion')
  }
  if (has('source_ip_cidr')) {
    if (sourceIp) {
      const list = Array.isArray(rule.source_ip_cidr) ? rule.source_ip_cidr : [rule.source_ip_cidr]
      if (!list.some((c) => cidrContains(c, sourceIp))) miss = true
    } else needs.push('sourceIp')
  }
  // 终端分流按 MAC 的(source_mac_address):终端的 MAC 由调用方按来源 IP 从 DHCP 租约 / 邻居表查(traffic.mjs 的 macForIp)
  if (has('source_mac_address')) {
    if (sourceMac) {
      const list = (Array.isArray(rule.source_mac_address) ? rule.source_mac_address : [rule.source_mac_address]).map((m) => String(m).toLowerCase())
      if (!list.includes(sourceMac)) miss = true
    } else needs.push('sourceMac')
  }
  if (has('port') || has('port_range')) {
    if (Number.isInteger(port)) {
      if (!portMatches(rule, port)) miss = true
    } else needs.push('port')
  }
  if (destMatch === false) miss = true
  if (miss) return { result: 'miss' }
  if (needs.length) return { result: 'undetermined', needs }
  return { result: 'hit' }
}
// 目标地址这一组要不要判:规则里有没有目标地址类条件
export const hasDestinationCondition = (rule) =>
  hasLocalCondition(rule) || Object.prototype.hasOwnProperty.call(rule, 'ip_is_private') || Object.prototype.hasOwnProperty.call(rule, 'rule_set')
// 来源 / 端口这两组
const hasContextCondition = (rule) => ['source_ip_cidr', 'source_mac_address', 'port', 'port_range', 'ip_version'].some((k) => Object.prototype.hasOwnProperty.call(rule, k))

// 单条条目(规则集解出来的,或站点集里手写的)是否命中目标——和 matchLocalConditions
// 同一套语义,多认一个 domain_regex。给「命中了哪一条具体的域名/IP」用。
export const entryMatches = (type, value, target) => {
  const host = String(target).toLowerCase()
  const v = String(value)
  switch (type) {
    case 'domain': return v.toLowerCase() === host
    case 'domain_suffix': {
      const suffix = v.toLowerCase()
      return host === suffix || host.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`)
    }
    case 'domain_keyword': return host.includes(v.toLowerCase())
    case 'domain_regex': try { return new RegExp(v).test(host) } catch { return false }
    case 'ip_cidr': return cidrContains(v, host)
    default: return false
  }
}

const MAX_MATCHED_ENTRIES = 20
// 命中的那条规则里,具体是哪些域名/IP 条目匹配上了:手写条件直接比,规则集用内核解码
// 后逐条比(rulesets.mjs 里有缓存)。解不开的规则集跳过——命中结论已经由 rule-set match
// 定了,这里只是把"为什么命中"摆出来。
// targets:域名目标时是 [域名, 解析出的目标 IP],IP 目标就是 [IP]——按 IP 判的条目(geoip / ip_cidr)比的是 IP
// onlyTags:已经知道是哪个集合命中的就只看它——一条规则挂十个集合时不必为了列条目全解一遍。
// srsPathByTag:给了就先用进程内索引(system/ruleset-index.mjs)找命中的条目,索引答不了的才解码整份条目表
const collectMatchedEntries = async (ctx, paths, rule, targets, fetchImpl, { onlyTags, srsPathByTag } = {}) => {
  const out = []
  let total = 0
  const push = (type, value, source) => { total++; if (out.length < MAX_MATCHED_ENTRIES) out.push({ type, value, source }) }
  const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v])
  const hits = (type, value) => targets.some((t) => entryMatches(type, value, t))
  for (const type of LOCAL_CONDITION_KEYS) {
    for (const value of list(rule[type])) if (hits(type, value)) push(type, value, 'custom')
  }
  for (const tag of list(rule.rule_set)) {
    if (onlyTags && !onlyTags.includes(tag)) continue
    const srsPath = srsPathByTag ? srsPathByTag.get(tag) : undefined
    const index = srsPath ? await loadRuleSetIndex(ctx, paths, tag, srsPath) : null
    // 索引能把每个候选目标都答全(域名那一半没有编不了的正则)才用它,否则退回逐条比
    const answerable = index && targets.every((t) => (net.isIP(String(t)) ? Boolean(index.ip) : Boolean(index.domain && !index.domain.regexUnknown)))
    if (answerable) {
      for (const t of targets) {
        const found = net.isIP(String(t)) ? matchedIpEntries(index.ip, t) : matchedDomainEntries(index.domain, t)
        for (const e of found) push(e.type, e.value, tag)
      }
      continue
    }
    let entries
    try { entries = await loadEntries(ctx, paths, tag, fetchImpl) } catch { continue }
    for (const e of entries) if (hits(e.type, e.value)) push(e.type, e.value, tag)
  }
  return { entries: out, entriesTotal: total }
}

// 这几个规则集里有没有按 IP 判的条目。规则集的 tag 都是自己生成的,按名字就分得出:geoip-* 全是 IP,
// 规则集链接拆出来的 list-*-ip 也是;geosite-*、list-*(域名那份)、dns-filter-* 没有。认不出的名字才解码看
// 一眼(rulesets.mjs 有缓存);解不开就当有——宁可多跑一次 rule-set match,不能漏判
const IP_ONLY_TAG = /^geoip-|-ip$/
const DOMAIN_ONLY_TAG = /^(geosite-|dns-filter-)|^list-(?!.*-ip$)/
const ruleSetsMayMatchIp = async (ctx, paths, tags) => {
  for (const tag of tags) {
    if (IP_ONLY_TAG.test(tag)) return true
    if (DOMAIN_ONLY_TAG.test(tag)) continue
    try {
      const entries = await loadEntries(ctx, paths, tag)
      if (entries.some((e) => e.type === 'ip_cidr')) return true
    } catch {
      return true
    }
  }
  return false
}

// 按域名判:只含 IP 条目的集合(geoip-* / list-*-ip)不可能命中域名,跳过;其余用进程内的域名索引比
// (system/ruleset-index.mjs,不起进程);内核 / 文件不在、解不开、形状复杂、有 JS 编不了的正则又没命中别的条目时,
// 才退回 `rule-set match`,由它按三态报告。分流规则和 DNS 规则(api/route-test.mjs 的 decideDnsServer)都走这里
export const matchRuleSetsByDomain = async (ctx, paths, srsPathByTag, tags, domain) => {
  for (const tag of tags) {
    if (IP_ONLY_TAG.test(tag)) continue
    const srsPath = srsPathByTag.get(tag)
    if (!srsPath) continue
    const index = await loadRuleSetIndex(ctx, paths, tag, srsPath)
    const verdict = index ? matchDomain(index.domain, domain) : 'unknown'
    if (verdict === 'hit') return { hit: true, tag }
    if (verdict === 'miss') continue
    const result = await matchRuleSet(ctx, paths, srsPath, domain)
    if (result.error) return result
    if (result.hit) return { hit: true, tag }
  }
  return { hit: false }
}

// 按 IP 判:只含域名的集合跳过;其余用进程内解码好的区间表比(system/ruleset-index.mjs,不起进程);内核 / 文件不在、
// 解不开、集合形状复杂时才退回 `rule-set match`,由它按三态报告(没能确认 ≠ 确认不命中)
const matchRuleSetsByIp = async (ctx, paths, srsPathByTag, tags, ip) => {
  for (const tag of tags) {
    if (DOMAIN_ONLY_TAG.test(tag)) continue
    const srsPath = srsPathByTag.get(tag)
    if (!srsPath) continue
    const index = await loadRuleSetIndex(ctx, paths, tag, srsPath)
    if (index && index.ip) {
      if (ipIndexHas(index.ip, ip)) return { hit: true, tag }
      continue
    }
    const result = await matchRuleSet(ctx, paths, srsPath, ip)
    if (result.error) return result
    if (result.hit) return { hit: true, tag }
  }
  return { hit: false }
}

const isFakeIpAddress = (ip) => cidrContains(FAKEIP_V4, ip) || cidrContains(FAKEIP_V6, ip)
// 域名目标先按内核此刻的 DNS 解析成 IP。内核里按 IP 判的规则(geoip 集合、ip_cidr、ip_is_private)看的是
// 连接的目标 IP,不是域名——终端本来就是先问 DNS 再连,这里问同一台内核 DNS(dns-in),走的也是同一套 DNS
// 规则。内核没在跑、解析不到,或者拿到的是 FakeIP 占位地址(内核会按它找回域名再判,不是真实目标),都算
// 没解析到,后面按 IP 判的规则记成前提。
export const resolveViaKernelDns = async (ctx, paths, host, { timeoutMs = 2500 } = {}) => {
  let port = DNS_INBOUND_PORT
  try {
    const config = JSON.parse(await ctx.readFile(paths.configPath))
    const inbound = (config.inbounds || []).find((i) => i && i.tag === 'dns-in')
    if (inbound && Number(inbound.listen_port)) port = Number(inbound.listen_port)
  } catch { /* 还没生成过配置:按默认端口问 */ }
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })
  resolver.setServers([`127.0.0.1:${port}`])
  let failure = ''
  const attempt = (p) => p.catch((err) => { failure = failure || (err && err.code) || String(err); return [] })
  const [v4, v6] = await Promise.all([attempt(resolver.resolve4(host)), attempt(resolver.resolve6(host))])
  const addresses = [...v4, ...v6]
  if (!addresses.length) return { addresses: [], error: `内核 DNS 127.0.0.1:${port} 没有解析出地址（${failure || 'empty'}）` }
  if (addresses.every(isFakeIpAddress)) return { addresses, fakeIp: true }
  return { addresses: addresses.filter((a) => !isFakeIpAddress(a)) }
}
// 连接的目标 IP:终端一般拿第一个 A 记录去连;查询指定了地址族就按那个族取
const pickPrimaryIp = (addresses, ipVersion) => {
  if (ipVersion === 6) return addresses.find((a) => net.isIP(a) === 6)
  if (ipVersion === 4) return addresses.find((a) => net.isIP(a) === 4)
  return addresses.find((a) => net.isIP(a) === 4) || addresses[0]
}

const errorMessage = (err) => (err instanceof Error ? err.message : String(err))

// target 最终会作为参数传给 `sing-box rule-set match`(execFile,无 shell,不是命令注入),
// 但以 "-" 开头的值会被 CLI 解析成一个 flag(参数注入)。域名/IP 本身的合法字符集里不含
// 空格等 shell 元字符,这里只需要一个宽松但明确的形态校验:允许的字符集 + 不能以 "-" 开头,
// 不需要做完整的域名/IP 语法解析。
const PENETRATION_TARGET_PATTERN = /^[A-Za-z0-9._:-]+$/
const isValidPenetrationTarget = (value) => {
  return typeof value === 'string' && !value.startsWith('-') && PENETRATION_TARGET_PATTERN.test(value)
}

// 沿 clash_api 的 `now` 字段逐层下钻直到叶子节点(响应里不再有 now)。
// 任何一步失败(网络不可达/非 2xx/JSON 解析失败)都不让整个请求失败——
// 降级为只保留已知的 chain(至少含起始的组名本身)+ chainError 说明。
const resolveChain = async ({ tag, fetchImpl, secret }) => {
  const chain = [tag]
  const seen = new Set([tag])
  let current = tag
  const MAX_DEPTH = 16 // 防御性上限,避免 now 字段成环时无限循环

  for (let i = 0; i < MAX_DEPTH; i++) {
    let res
    try {
      res = await fetchImpl(`${CLASH_API_BASE}/proxies/${encodeURIComponent(current)}`, {
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      })
    } catch (err) {
      return { chain, chainError: `clash_api unreachable: ${errorMessage(err)}` }
    }
    if (!res || !res.ok) {
      return { chain, chainError: `clash_api responded HTTP ${res ? res.status : 'unknown'}` }
    }
    let body
    try {
      body = await res.json()
    } catch (err) {
      return { chain, chainError: `clash_api response parse failed: ${errorMessage(err)}` }
    }
    const now = body && typeof body.now === 'string' && body.now ? body.now : null
    if (!now || seen.has(now)) break
    seen.add(now)
    chain.push(now)
    current = now
  }
  return { chain }
}

// 部署时节点 / 订阅的域名解析成的地址(api/deploy-runner.mjs 的 resolveDirectHostCidrs)只在已部署的配置里:「订阅和节点站点直连」
// 那条规则 = 出口是内置直连、只带 domain / ip_cidr 的普通规则。推算时补进去,按 IP 查节点服务器才和内核一致
// 部署的配置引用规则集文件(engine/direct-hosts.mjs 的 NODE_DIRECT_IP_TAG)时按文件内容取;老配置按内联规则取
export const readDeployedDirectHostCidrs = async (ctx, config, directTag) => {
  const entry = ((config && config.route && config.route.rule_set) || []).find((e) => e && e.tag === NODE_DIRECT_IP_TAG)
  if (!entry) return deployedDirectHostCidrs(config, directTag)
  try {
    return (JSON.parse(await ctx.readFile(entry.path)).rules || []).flatMap((r) => [].concat(r.ip_cidr || []))
  } catch {
    return []
  }
}
export const deployedDirectHostCidrs = (config, directTag) => {
  const rules = config && config.route && Array.isArray(config.route.rules) ? config.route.rules : []
  const rule = rules.find((r) => r && r.outbound === directTag && Array.isArray(r.ip_cidr) && Object.keys(r).every((k) => k === 'outbound' || k === 'domain' || k === 'ip_cidr'))
  return rule ? rule.ip_cidr : []
}

// 首包预判放行(engine/routing.mjs 的 preMatchBypassRules:不带出口的 bypass,正面条件是节点服务器地址或直连终端的来源,取反
// 挂着前置自定义分流里走代理 / 拒绝的 IP 段、规则集、端口,和内置的 DNS 端口 / tun 网段)。按内核的顺序判这条连接:
//   verdict 'bypass'  在入口放行,不进内核(ipUnknown:目标地址不知道,命中取反的那几条时照常进内核);
//   verdict 'kernel'  照常进内核:reason 'fakeip'(这台终端查这个域名拿到的是占位地址)/ 'port' / 'ip' / 'set';
//   verdict 'unknown' 规则集判不了。
// kind:'nodes'(目标是订阅 / 节点服务器)/ 'terminal'(来源是直连终端)。一条都不沾回 null
export const preMatchVerdict = async (ctx, paths, rules, srsPathByTag, { sourceIp = '', sourceMac = '', targetIp = '', port, fakeIp = false } = {}) => {
  let excluded = null
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]
    if (!r || r.action !== 'bypass' || r.outbound || r.type !== 'logical' || !Array.isArray(r.rules) || !r.rules.length) continue
    const [head, ...keep] = r.rules
    let kind = ''
    if (Array.isArray(head.ip_cidr)) {
      // 节点服务器:目标是 IP 才对得上(拿到占位地址的域名进内核后按规则走)
      if (fakeIp || !targetIp || !head.ip_cidr.some((c) => cidrContains(c, targetIp))) continue
      kind = 'nodes'
    } else if (Array.isArray(head.rule_set)) {
      // 部署的配置里节点服务器的地址在规则集文件里(engine/direct-hosts.mjs 的 NODE_DIRECT_IP_TAG)
      if (fakeIp || !targetIp) continue
      const m = await matchRuleSetsByIp(ctx, paths, srsPathByTag, head.rule_set, targetIp)
      if (m.error) return { index: i, kind: 'nodes', verdict: 'unknown', reason: 'error', error: m.error }
      if (!m.hit) continue
      kind = 'nodes'
    } else {
      const hit = Array.isArray(head.source_ip_cidr)
        ? Boolean(sourceIp) && head.source_ip_cidr.some((c) => cidrContains(c, sourceIp))
        : Array.isArray(head.source_mac_address) && Boolean(sourceMac) && head.source_mac_address.includes(sourceMac)
      if (!hit) continue
      kind = 'terminal'
      if (fakeIp) return { index: i, kind, verdict: 'kernel', reason: 'fakeip' }
    }
    let why = null
    for (const k of keep) {
      if ((k.port || k.port_range) && port !== undefined) {
        const inRange = (k.port_range || []).some((range) => { const [a, b] = String(range).split(':').map(Number); return port >= a && port <= b })
        if ((k.port || []).includes(port) || inRange) { why = { reason: 'port', port }; break }
      }
      if (k.ip_cidr && targetIp) {
        const cidr = k.ip_cidr.find((c) => cidrContains(c, targetIp))
        if (cidr) { why = { reason: 'ip', cidr }; break }
      }
      if (k.rule_set && targetIp) {
        const m = await matchRuleSetsByIp(ctx, paths, srsPathByTag, k.rule_set, targetIp)
        if (m.error) return { index: i, kind, verdict: 'unknown', reason: 'error', error: m.error }
        if (m.hit) { why = { reason: 'set', tag: m.tag }; break }
      }
    }
    if (!why) return { index: i, kind, verdict: 'bypass', ...(targetIp ? {} : { ipUnknown: true }) }
    // 取反的条件命中:这一条不放行,内核接着往下比(后面那条的取反条件一样,结论相同)
    if (!excluded) excluded = { index: i, kind, verdict: 'kernel', ...why }
  }
  return excluded
}

// 规则页「域名穿透」和概览的站点延时卡片共用:给一个目标(域名 / IP,可带来源 IP、端口、地址族),按当前设置
// 生成的规则表推算它会走哪条规则、哪个出站,再沿 clash_api 的 now 下钻到叶子节点。返回 { status, body },
// status 不是 200 时 body 只有 message
// profilePatch(可选):按打过补丁的档案生成规则表再判——客户端配置(api/client-config.mjs)判代理 DNS 上游的线路时,按手机那份规则判
export const predictRoute = async ({ store, ctx, paths, fetchImpl = globalThis.fetch, resolveTarget = resolveViaKernelDns, profilePatch }, input = {}) => {
  const target = input.target
  if (typeof target !== 'string' || !target.trim()) {
    return { status: 400, body: { message: 'target is required' } }
  }
  if (!isValidPenetrationTarget(target)) {
    return { status: 400, body: { message: 'target must be a valid domain or IP address' } }
  }

  // 查询上下文(可选):终端来源 IP、目标端口。规则里有来源 / 端口条件而这里没给,那条规则判不了,
  // 结果会如实标成"判不了"而不是猜
  const sourceIpRaw = typeof input.sourceIp === 'string' ? input.sourceIp.trim() : ''
  if (sourceIpRaw && !net.isIP(sourceIpRaw)) return { status: 400, body: { message: 'sourceIp must be an IP address' } }
  const sourceIp = sourceIpRaw || ''
  // 按 MAC 的终端规则要终端的 MAC:从来源 IP 查(DHCP 租约 / 邻居表),查不到那几条就如实算判不了
  const sourceMac = sourceIp ? await macForIp(ctx, paths, sourceIp) : ''
  const portRaw = input.port !== undefined && input.port !== null && input.port !== '' ? Number(input.port) : undefined
  if (portRaw !== undefined && !(Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535)) return { status: 400, body: { message: 'port must be 1-65535' } }
  const port = portRaw
  // 连接的目标地址族:目标是 IP 就是它自己的;域名目标可选带 ipVersion(终端拿到 A 还是 AAAA 才决定),
  // 没给而规则又看 ip_version(IPv6 分层里"走代理的 v6 明确拒绝"那几条)就如实说判不了
  const ipVersionRaw = input.ipVersion !== undefined && input.ipVersion !== null && input.ipVersion !== '' ? Number(input.ipVersion) : undefined
  if (ipVersionRaw !== undefined && ipVersionRaw !== 4 && ipVersionRaw !== 6) return { status: 400, body: { message: 'ipVersion must be 4 or 6' } }
  // 连接走 TCP 还是 UDP:规则页推算的是 TCP(实测也是 TCP / HTTP);代理 DNS 上游按它选的协议推算(api/dns-upstream-route.mjs)
  const network = input.network === 'udp' ? 'udp' : 'tcp'
  const isIpTarget = net.isIP(target) !== 0
  // 域名目标也先解析一次:前置自定义分流的 IP 行、私网直连对有域名的连接照样生效,要拿解析出的地址比;站点集的
  // geoip / IP 段只管没有域名的连接,查域名时不参与(下面循环里跳过)。解析结果也回给前端,DNS 那一步照实显示
  let resolved = null
  if (!isIpTarget) {
    try {
      resolved = await resolveTarget(ctx, paths, target.toLowerCase())
    } catch (err) {
      resolved = { addresses: [], error: errorMessage(err) }
    }
  }
  const destIps = isIpTarget ? [target] : (resolved && !resolved.fakeIp && Array.isArray(resolved.addresses) ? resolved.addresses : [])
  const primaryIp = isIpTarget ? target : pickPrimaryIp(destIps, ipVersionRaw)
  const ipVersion = isIpTarget ? net.isIP(target) : (ipVersionRaw ?? (primaryIp ? net.isIP(primaryIp) : undefined))
  // 判目标地址那一组时拿去比的候选:域名条件比域名,IP 条件比解析出的目标 IP
  const candidates = isIpTarget ? [target] : (primaryIp ? [target, primaryIp] : [target])

  const profile = store.getProfile()
  const builtin = builtinTags(store.getGroups ? store.getGroups() : [])
  // 规则表走生成配置的同一条管线(api/deploy-runner.mjs 的 buildCurrentConfig → engine/config.mjs):
  // 内置直连 / 拒绝的实际 tag、订阅 / 节点站点直连、终端分流、tun 防回环网段、dnsmasq 回送、
  // 有效出站集合(指向已删节点的规则会被丢掉)、规则集链接的形状表——全部和内核里的一样,
  // 数出来的"第几条"才对得上(审核 C1 / 复审 R5)。部署时解析出的节点 IP(directHostCidrs)从已部署的配置里取
  // (deployedDirectHostCidrs):以前推算时没有它,按 IP 查节点服务器会漏掉那条直连规则、落到兜底。
  // 已部署的配置 DNS 那一步和首包预判也要用;还没部署过就是 null
  let deployed = null
  try { deployed = JSON.parse(await ctx.readFile(paths.configPath)) } catch { deployed = null }
  let route
  try {
    // 订阅和节点站点直连的地址直接写进推算用的规则(inlineDirectHosts):不依赖部署时写的规则集文件,条数和部署的一样
    const directHostCidrs = await readDeployedDirectHostCidrs(ctx, deployed, builtin.direct)
    ;({ route } = buildCurrentConfig(store, [], { rulesetDir: paths.rulesetDir, ruleLists: await readRuleListShapes(ctx, paths), directHostCidrs, inlineDirectHosts: 'aligned', ...(profilePatch ? { profilePatch } : {}) }).config)
  } catch (err) {
    return { status: 500, body: { message: `无法按当前设置生成规则:${errorMessage(err)}` } }
  }

  // 热切换结构(engine/flip.mjs):出口是站点集的规则前面多了挂着开关的拒绝规则(v6 / QUIC),此刻算不算数看开关状态。
  // 以运行中的内核为准(部署元数据里记着,翻面时更新);运行中的还不是这种结构(老版本生成的、还没重新部署)就按档案默认出口算。
  // 开关 OFF 的那条跳过、ON 的展平成普通规则再判——以前遇到 logical 规则是静默跳过,等于永远当开关没命中
  let flipState = await readFlipState(ctx, paths)
  if (!Object.keys(flipState).length) {
    try { flipState = flipStateFromProfile(store) } catch { flipState = {} }
  }

  // tag → 本地 .srs 路径:直接复用 buildRoute 已经算好的 rule_set 映射,
  // 不再重复拼接(避免与 buildRoute 内部拼接规则出现两处不一致)。
  const srsPathByTag = new Map(route.rule_set.map((r) => [r.tag, r.path]))

  // 策略组 tag 集合。用来判定
  // 一个 outbound 是"策略组"(需要经 clash_api 下钻)还是叶子节点/direct(无需下钻)。
  // 用户自建的节点组、每个站点集的 selector、以及兜底的「其他」也都是"策略组",
  // 一样要能往下钻:只列地区组的话,命中一个站点集之后就断在那儿,看不到它当前
  // 选的是哪个节点;而"一条都没命中"落到的正是兜底那个 selector。
  const routingConf = normalizeRouting(profile.routing)
  const groupTags = new Set([
    // 内置的直连/拒绝是出站不是 selector,没有 now 可下钻,不算策略组
    ...(store.getGroups() || []).filter((g) => !g.kind).map((g) => g.name).filter(Boolean),
    ...routingConf.activePolicies.map((p) => p.name),
    routingConf.fallback.name,
  ])

  let matched = null
  // 三条规则里第几条(1-based,仅用于 matchError 里的人类可读定位)没能确认检查结果。
  let matchError
  // 要看来源 IP / 目标端口 / 地址族才能判、而这次查询没给的规则:不在这里中断(那样后面明明命中的
  // 规则永远轮不到,查一个 geoip-cn 里的 IP 也只能得到"判不了"),而是明确记成前提——按"不满足这条
  // 规则的情况"(不在该来源里的终端 / 不是该端口)继续推算,前端把这些前提原样列出来
  const assumed = []
  let preResolve = false
  for (let i = 0; i < route.rules.length; i++) {
    // 站点集按 IP 判的那一份带着「连接没有域名」的前提(engine/routing-model.mjs 的 noDomainGuard):有域名的访问只按
    // 域名判,都没命中就走兜底,不会被站点集的 geoip / IP 段抢走。查的是域名(不论解析成真实地址还是 FakeIP)就跳过这种
    // 规则;查的是 IP(终端直接按 IP 连)才照常判
    // 首包预判放行(不带出口的 bypass)只在预判里生效,正常路由时内核跳过它:这里也跳过,入口那一步另外说(preMatchVerdict)
    if (route.rules[i] && route.rules[i].action === 'bypass' && !route.rules[i].outbound) continue
    const { rule: unguarded, noDomain } = splitNoDomainGuard(route.rules[i])
    if (noDomain && !isIpTarget) continue
    // 序号仍是内核规则表里的真实序号;判定和回给前端的规则用展平后的(前端才读得懂条件)
    const rule = flattenFlipRule(unguarded, flipState)
    if (!rule) continue
    // 推算的是一条 TCP 连接(规则页的实测也是 TCP / HTTP):只管 UDP 的规则——屏蔽 QUIC 那条「同条件 + UDP 443 → 拒绝」——
    // 和它无关。以前这里不认 network,带 443 端口查询走代理的站点时会被说成「命中拒绝」
    if (rule.network !== undefined && ![].concat(rule.network).includes(network)) continue
    // 目标地址那一组:域名 / IP / ip_is_private / 规则集,任一命中即算命中;没有这一组就是 null
    const needsDest = hasDestinationCondition(rule)
    if (!needsDest && !hasContextCondition(rule)) {
      continue // action:'sniff' / protocol:'dns' hijack-dns 等无条件规则,不参与穿透判定
    }
    // resolve 动作不是终点:它只把域名目标先解析成真实 IP 供后面的 IP 规则判(engine/routing.mjs 的预解析),
    // 匹配继续往下走。预测按"目标已有真实 IP"处理,和 tun 路径一致;这里只记一下有没有这类规则
    if (rule.action === 'resolve') {
      preResolve = true
      continue
    }
    // 来源 / 端口这两组已知不命中时不用再去 exec 规则集
    const context = evaluateRuleGroups(rule, { destMatch: null, sourceIp, sourceMac, port, ipVersion })
    if (context.result === 'miss') continue
    let destMatch = null
    // 这条规则靠带 IP 条目的规则集(geoip-* 之类)判,而域名这次没解析到:目标这一组判不了,下面记成前提、
    // 按不命中继续。手写的 ip_cidr / ip_is_private 不这样记:tun 网段、节点服务器 IP、私网这类条件和一个
    // 随便的域名撞上的机会极小,每次解析不到都把它们列成前提只会淹掉真正有用的那条;解析到了就全部按 IP 实判。
    // 内核回的是 FakeIP 占位地址时不是"没解析到":连接进内核后按占位地址找回域名,目标就是域名,按 IP 判的
    // 规则本来就不参与——确认不命中,不记前提
    let destUnknown = false
    const fakeIpTarget = Boolean(resolved && resolved.fakeIp)
    // 命中是靠解析出的 IP(域名本身没命中任何域名条件)
    let viaIp = ''
    // 命中的是哪个规则集(列条目时只看它)
    let hitTag = ''
    if (needsDest) {
      destMatch = false
      if (Object.prototype.hasOwnProperty.call(rule, 'ip_is_private') && primaryIp && isPrivateOrLoopbackIp(primaryIp)) {
        destMatch = true
        if (!isIpTarget) viaIp = primaryIp
      }
      // 策略带来的域名/关键词/CIDR 条件:纯字符串与网段比较,本地算得出来,不用去 exec 内核;域名条件比域名,
      // CIDR 比解析出的目标 IP
      if (!destMatch && hasLocalCondition(rule)) {
        for (const c of candidates) {
          if (matchLocalConditions(rule, c)) { destMatch = true; if (c !== target) viaIp = c; break }
        }
      }
      // 同一条规则里还可能带规则集,本地条件没命中时继续用 .srs 判一次:先比域名,域名没命中再拿目标 IP
      // 比一次(geoip 集合只认 IP)
      if (!destMatch && Object.prototype.hasOwnProperty.call(rule, 'rule_set')) {
        const tags = Array.isArray(rule.rule_set) ? rule.rule_set : [rule.rule_set]
        const srsPath = tags.length === 1 ? srsPathByTag.get(tags[0]) : 'multi'
        if (srsPath) {
          const result = isIpTarget
            ? await matchRuleSetsByIp(ctx, paths, srsPathByTag, tags, target)
            : await matchRuleSetsByDomain(ctx, paths, srsPathByTag, tags, target)
          if (result.error) {
            // 没能确认这一条规则是否命中——sing-box 按顺序首条命中生效,这一条排在
            // matched/route.final 判定之前,一旦它没法确认,后面所有规则的求值结果和
            // "落到 final"的结论都不再可信,不能假装什么都没发生地继续走下去(那正是
            // chainError 在 resolveChain 里遇到中途失败时的处理方式:保留已经确定的部分,
            // 剩下的老实说"不知道",而不是替用户瞎猜一个看起来完整的答案)。
            matchError = `rule #${i + 1} (${tags.join(', ')}): ${result.error}`
            break
          }
          destMatch = result.hit
          if (result.hit && result.tag) hitTag = result.tag
          if (!destMatch && !isIpTarget && await ruleSetsMayMatchIp(ctx, paths, tags)) {
            if (primaryIp) {
              const byIp = await matchRuleSetsByIp(ctx, paths, srsPathByTag, tags, primaryIp)
              if (byIp.error) {
                matchError = `rule #${i + 1} (${tags.join(', ')}): ${byIp.error}`
                break
              }
              if (byIp.hit) { destMatch = true; viaIp = primaryIp; if (byIp.tag) hitTag = byIp.tag }
            } else if (!fakeIpTarget) destUnknown = true
          }
        }
      }
      if (!destMatch && destUnknown) destMatch = null
    }
    const verdict = evaluateRuleGroups(rule, { destMatch, sourceIp, sourceMac, port, ipVersion })
    if (verdict.result === 'miss') continue
    if (verdict.result === 'undetermined' || destUnknown) {
      const a = { index: i, rule, needs: [...(destUnknown ? ['destIp'] : []), ...(verdict.needs || [])] }
      if (rule.outbound !== undefined) a.outbound = rule.outbound
      if (rule.action !== undefined) a.action = rule.action
      assumed.push(a)
      continue
    }
    const hit = true
    if (hit) {
      matched = { index: i, rule }
      if (rule.outbound !== undefined) matched.outbound = rule.outbound
      if (rule.action !== undefined) matched.action = rule.action
      if (viaIp) matched.viaIp = viaIp
      if (!Object.prototype.hasOwnProperty.call(rule, 'ip_is_private')) {
        Object.assign(matched, await collectMatchedEntries(ctx, paths, rule, candidates, fetchImpl, { srsPathByTag, ...(hitTag ? { onlyTags: [hitTag] } : {}) }))
      }
      break
    }
  }

  // matchError 已设置时 matched 必然仍是 null(上面的循环在设置 matchError 后立刻
  // break,不会再有机会命中)——但这时的 null 和"确认查完所有规则、真的没有命中"的 null
  // 含义不同,finalOutbound 不能再自信地报告 route.final(那条没能确认的规则,如果真的
  // 命中了,结果会完全不同)。
  // 界面上「站点集」后面显示的是"命中的是哪一条分流条目"。站点集的出站就是它自己的同名
  // selector,所以那里一直直接拿 outbound 当条目名用;前置自定义分流不生成 selector、
  // 出站是具体的节点或直连,再拿 outbound 就成了「站点集 直连」,看不出命中的是哪一条。
  // 这里把条目名单独回传,出站仍由 finalOutbound 表示。
  if (matched && isCustomRule(matched.rule, routingConf.custom, builtin)) {
    matched.ownerName = routingConf.custom.name
  }
  // 命中的规则归谁(站点集 / 前置自定义 / 内置规则);没命中就是兜底站点集。界面第 4 步显示它,第 5 步据此把链路
  // 开头的站点集去掉——出口就只写出口(engine/rule-owner.mjs,真实路由那边用同一套)
  const owner = matched ? ruleOwner(matched.rule, profile.routing, builtin) : (route.final ? { kind: 'policy', name: route.final } : null)

  const finalOutbound = matchError ? null : matched ? (matched.outbound !== undefined ? matched.outbound : null) : route.final

  let chain = finalOutbound !== null && finalOutbound !== undefined ? [finalOutbound] : []
  let chainError
  if (finalOutbound && groupTags.has(finalOutbound)) {
    const secret = store.getClashSecret()
    const result = await resolveChain({ tag: finalOutbound, fetchImpl, secret })
    chain = result.chain
    chainError = result.chainError
  }
  // 每条前提都标一下"它命中时的去向和这里推算出的结果是不是同一个出口":一样的(比如终端分流让某几台设备
  // 全部直连,而查的目标本来就归国内直连)对这次查询没有影响,前端不当提示放主行;只有会改变出口的才提示
  if (assumed.length && !matchError) {
    const secret = store.getClashSecret()
    const finalLeaf = chain.length ? chain[chain.length - 1] : finalOutbound
    for (const a of assumed) {
      if (a.action === 'reject') { a.sameOutcome = Boolean(matched && matched.action === 'reject'); continue }
      if (!a.outbound) { a.sameOutcome = false; continue }
      let leaf = a.outbound
      if (groupTags.has(a.outbound)) {
        try {
          const r = await resolveChain({ tag: a.outbound, fetchImpl, secret })
          if (!r.chainError && r.chain && r.chain.length) leaf = r.chain[r.chain.length - 1]
        } catch { /* 拿不到就按名字比 */ }
      }
      a.leaf = leaf
      a.sameOutcome = Boolean(finalLeaf) && leaf === finalLeaf
    }
  }

  // 内核跑的还是不是当前这份分流设置。不一样时「规则路由」(按当前设置推算)和下面的
  // 「真实路由」(内核此刻的实际行为)本来就会对不上——比如刚删掉一条前置分流还没重启,
  // 上面已经按新规则走站点集,下面还在按旧规则走那条被删的线路。不说清楚就像查出来是乱的。
  // 老版本部署出来的 meta 没有这个字段,那就不判,免得误报。
  let routingStale = false
  let firstLayer = null
  try {
    const meta = JSON.parse(await ctx.readFile(configMetaPath(paths)))
    if (typeof meta.routingHash === 'string' && meta.routingHash) {
      routingStale = meta.routingHash !== routingFingerprint(profile.routing)
    }
    // 这次部署时第一层的判定(DNS 怎么分、入口有没有原生旁路),规则页照实说明——它是部署时
    // 的记录,不是此刻推算;分流改了没重启的话以 routingStale 为准
    if (meta.firstLayer && typeof meta.firstLayer === 'object') firstLayer = meta.firstLayer
  } catch {
    // 没有 meta / 读不动:不判
  }

  // 首包预判放行(节点服务器 / 直连终端):入口那一步按它说。域名目标拿不拿到占位地址,有来源时按这台终端自己的 DNS 规则判
  // (劫持模式、或者入口把它的查询转给了内核时,它有自己的一套;engine/dns.mjs),判不了就按上面解析的结果
  let preMatch = null
  if (route.rules.some((r) => r && r.action === 'bypass' && !r.outbound)) {
    let fakeIp = Boolean(resolved && resolved.fakeIp)
    if (!isIpTarget && sourceIp && deployed) {
      try {
        const d = await decideDnsServer(ctx, paths, deployed, target.toLowerCase(), { sourceIp, sourceMac, flipState })
        if (d && !d.error) fakeIp = d.fakeIpRule !== undefined
      } catch {
        // 判不了:按上面的解析结果
      }
    }
    preMatch = await preMatchVerdict(ctx, paths, route.rules, srsPathByTag, { sourceIp, sourceMac, targetIp: primaryIp || '', port, fakeIp })
  }

  const body = { matched, chain, finalOutbound }
  if (preMatch) body.preMatch = preMatch
  // 域名目标这次解析成了什么(按 IP 判的规则就是拿它比的);解析不到 / 拿到 FakeIP 时前端据此说明
  if (resolved) body.resolved = resolved
  if (owner && !matchError) body.owner = owner
  if (assumed.length) body.assumed = assumed
  if (routingStale) body.routingStale = true
  if (firstLayer) body.firstLayer = firstLayer
  // 规则表里有预解析(有按 IP 判的规则排在域名规则前面):以域名进内核的连接会先解析再判,预测按"目标已有真实 IP"算
  if (preResolve) body.preResolve = true
  if (chainError) body.chainError = chainError
  if (matchError) body.matchError = matchError

  // 顺带按内核里正在跑的配置(etc/config.json)推一下这个域名会用哪台 DNS:
  // 直连解析还是经某个站点集的 DoH。目标是 IP 就没有解析这一步。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target) || target.includes(':')) {
    body.dns = { skipped: true }
  } else {
    try {
      if (!deployed) throw new Error('没有已部署的配置')
      const rewrite = typeof store?.getProfile === 'function' ? normalizeDnsRewrite(store.getProfile().dns) : { enabled: true, rules: [] }
      body.dns = await decideDnsServer(ctx, paths, deployed, target.toLowerCase(), { sourceIp, sourceMac, rewriteRules: rewrite.enabled ? rewrite.rules : [] })
    } catch (err) {
      body.dns = { error: `还没有生成过配置,无法判断 DNS（${errorMessage(err)}）` }
    }
  }
  return { status: 200, body }
}

export const registerPenetrationRoutes = (app, { store, ctx, paths, fetchImpl = globalThis.fetch, resolveTarget = resolveViaKernelDns } = {}) => {
  const router = express.Router({ caseSensitive: true })
  router.use(express.json({ limit: '1mb' }))

  router.post('/penetration', async (req, res) => {
    const input = req.body || {}
    const result = await predictRoute({ store, ctx, paths, fetchImpl, resolveTarget }, { target: input.target, sourceIp: input.sourceIp, port: input.port, ipVersion: input.ipVersion })
    res.status(result.status).json(result.body)
  })

  app.use('/api/openbox', router)
}
