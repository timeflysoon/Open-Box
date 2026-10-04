// 规则集的进程内索引:一份 .srs 交给内核 decompile 一次,域名条目建成集合(精确 / 后缀 / 关键词 / 正则)、IP 网段建成
// 合并后的区间表,规则页推算分流规则和 DNS 规则时直接在进程内比,不再为每个规则集起一个 `sing-box rule-set match`
// 进程。起进程本身不贵,贵在内存紧的路由器上:每起一次都要把几十 MB 的内核二进制重新读进来,一次域名推算要起
// 四五十个——2026-09-17 正式路由器(1 GB)内存抖动时磁盘读到 100 MB/s 就有它的份。
// 匹配语义对着内核实测过(1.14.0):domain 全等;domain_suffix 按标签边界(example.com 命中自身和子域,不命中
// notexample.com),以点开头的只命中子域;domain_keyword 是子串;domain_regex 是 Go 的 RE2;域名比较不分大小写。
// 解不开、集合形状不是"只看目标地址"(逻辑 / 取反 / 带端口、来源等附加条件)的返回 null;正则里有 JS 编不了的写法时
// 域名那一半报 unknown——两种情况调用方都退回内核去判,由它按三态报告(没能确认 ≠ 确认不命中)。
// 内存:geosite-cn 十一万条后缀约 10 MB,其余集合加起来一两 MB;缓存 10 分钟,规则集一天才更新一次。
import net from 'node:net'
import { parseCidr } from './local-subnets.mjs'

const TTL_MS = 10 * 60 * 1000
// 规则集链接可以指向任意大的名单:条目多到这个数就不在进程内建域名集合了,交回内核
const MAX_DOMAIN_ENTRIES = 400_000
const cache = new Map()
const DOMAIN_KEYS = ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex']
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])

const mergeRanges = (ranges) => {
  const sorted = ranges.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out = []
  for (const [start, end] of sorted) {
    const last = out[out.length - 1]
    if (last && start <= last[1] + 1n) { if (end > last[1]) last[1] = end } else out.push([start, end])
  }
  return out
}

// Go(RE2)的正则换成 JS 的:开头的 (?i)、命名组 (?P<…>)、\z / \A 能换;别的内联标志、POSIX 类、\p{…} 编不了,返回 null
export const toJsRegex = (source) => {
  let s = String(source)
  let flags = ''
  const lead = /^\(\?([a-zA-Z]+)\)/.exec(s)
  if (lead) {
    if (!/^i+$/.test(lead[1])) return null
    flags = 'i'
    s = s.slice(lead[0].length)
  }
  if (/\(\?[a-zA-Z-]+[:)]/.test(s) || /\[\[:|\\[pP]\{|\\[CQE]/.test(s)) return null
  s = s.replace(/\(\?P</g, '(?<').replace(/\\z/g, '$').replace(/\\A/g, '^')
  try { return new RegExp(s, flags) } catch { return null }
}

// 规则集 JSON → { ip, domain, entries };形状不支持返回 null
//   ip:     { v4: { starts, ends }(合并后的区间,Uint32Array), v6: [[start, end]], raw4 / raw6(原始网段,列命中条目用) }
//   domain: { exact, suffix, subOnly(Set), keywords, regexes, regexSources, regexUnknown, size };条目太多时为 null
export const buildRuleSetIndex = (json, { maxDomainEntries = MAX_DOMAIN_ENTRIES } = {}) => {
  const v4 = []
  const v6 = []
  const exact = new Set()
  const suffix = new Set()
  const subOnly = new Set()
  const keywords = []
  const regexes = []
  const regexSources = []
  let regexUnknown = false
  let domainEntries = 0
  for (const rule of (json && json.rules) || []) {
    if (!rule || typeof rule !== 'object') continue
    if (rule.type === 'logical' || rule.rules || rule.invert) return null
    for (const key of Object.keys(rule)) if (key !== 'ip_cidr' && key !== 'type' && !DOMAIN_KEYS.includes(key)) return null
    for (const cidr of list(rule.ip_cidr)) {
      const p = parseCidr(cidr)
      if (!p) continue
      const bits = p.family === 4 ? 32n : 128n
      const end = p.net + (1n << (bits - BigInt(p.prefix))) - 1n
      ;(p.family === 4 ? v4 : v6).push([p.net, end, String(cidr)])
    }
    for (const d of list(rule.domain)) { exact.add(String(d).toLowerCase()); domainEntries++ }
    for (const d of list(rule.domain_suffix)) {
      const s = String(d).toLowerCase()
      if (s.startsWith('.')) subOnly.add(s.slice(1)); else suffix.add(s)
      domainEntries++
    }
    for (const k of list(rule.domain_keyword)) { keywords.push(String(k).toLowerCase()); domainEntries++ }
    for (const r of list(rule.domain_regex)) {
      const re = toJsRegex(r)
      if (re) { regexes.push(re); regexSources.push(String(r)) } else regexUnknown = true
      domainEntries++
    }
  }
  const m4 = mergeRanges(v4)
  const starts = new Uint32Array(m4.length)
  const ends = new Uint32Array(m4.length)
  m4.forEach(([s, e], i) => { starts[i] = Number(s); ends[i] = Number(e) })
  const raw4 = { starts: new Uint32Array(v4.length), ends: new Uint32Array(v4.length), cidrs: v4.map((r) => r[2]) }
  v4.forEach(([s, e], i) => { raw4.starts[i] = Number(s); raw4.ends[i] = Number(e) })
  const ip = { v4: { starts, ends }, v6: mergeRanges(v6), raw4, raw6: v6, count: v4.length + v6.length }
  const domain = domainEntries > maxDomainEntries ? null : { exact, suffix, subOnly, keywords, regexes, regexSources, regexUnknown, size: domainEntries }
  return { ip, domain, entries: ip.count + domainEntries }
}

const ipValue = (ip) => {
  const family = net.isIP(String(ip))
  if (!family) return null
  const p = parseCidr(ip)
  return p ? { family, value: p.net } : null
}

export const ipIndexHas = (ipIndex, ip) => {
  const v = ipIndex && ipValue(ip)
  if (!v) return false
  if (v.family === 4) {
    const value = Number(v.value)
    const { starts, ends } = ipIndex.v4
    let lo = 0
    let hi = starts.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid] > value) hi = mid - 1
      else if (ends[mid] < value) lo = mid + 1
      else return true
    }
    return false
  }
  let lo = 0
  let hi = ipIndex.v6.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (ipIndex.v6[mid][0] > v.value) hi = mid - 1
    else if (ipIndex.v6[mid][1] < v.value) lo = mid + 1
    else return true
  }
  return false
}

// 命中的原始网段(界面上"命中了哪一条"用),最多 limit 条
export const matchedIpEntries = (ipIndex, ip, limit = 20) => {
  const v = ipIndex && ipValue(ip)
  const out = []
  if (!v) return out
  if (v.family === 4) {
    const value = Number(v.value)
    const { starts, ends, cidrs } = ipIndex.raw4
    for (let i = 0; i < starts.length && out.length < limit; i++) if (starts[i] <= value && value <= ends[i]) out.push({ type: 'ip_cidr', value: cidrs[i] })
    return out
  }
  for (const [start, end, cidr] of ipIndex.raw6) {
    if (out.length >= limit) break
    if (start <= v.value && v.value <= end) out.push({ type: 'ip_cidr', value: cidr })
  }
  return out
}

// 域名在这份集合里命中的条目;collect=false 时找到第一条就返回
const domainHits = (d, host, collect) => {
  const h = String(host).toLowerCase()
  const out = []
  const push = (type, value) => { out.push({ type, value }); return !collect }
  if (d.exact.has(h) && push('domain', h)) return out
  let rest = h
  for (;;) {
    if (d.suffix.has(rest) && push('domain_suffix', rest)) return out
    if (rest !== h && d.subOnly.has(rest) && push('domain_suffix', `.${rest}`)) return out
    const dot = rest.indexOf('.')
    if (dot < 0) break
    rest = rest.slice(dot + 1)
  }
  for (const k of d.keywords) if (h.includes(k) && push('domain_keyword', k)) return out
  for (let i = 0; i < d.regexes.length; i++) if (d.regexes[i].test(h) && push('domain_regex', d.regexSources[i])) return out
  return out
}

// 'hit' / 'miss' / 'unknown'(有 JS 编不了的正则,没命中别的条目时说不准,交回内核)
export const matchDomain = (domainIndex, host) => {
  if (!domainIndex) return 'unknown'
  if (domainHits(domainIndex, host, false).length) return 'hit'
  return domainIndex.regexUnknown ? 'unknown' : 'miss'
}
export const matchedDomainEntries = (domainIndex, host) => (domainIndex ? domainHits(domainIndex, host, true) : [])

// 取一份规则集的索引(10 分钟缓存)。返回 null:内核 / 文件不在、解码失败、形状不支持——交回调用方用内核判
export const loadRuleSetIndex = async (ctx, paths, tag, srsPath, { now = Date.now } = {}) => {
  const hit = cache.get(tag)
  if (hit && hit.srsPath === srsPath && now() - hit.at < TTL_MS) return hit.index
  // source 格式的本地规则集(订阅和节点站点直连,engine/direct-hosts.mjs)本身就是 JSON,直接读。文件还没写(没部署过)就是
  // 一个地址都没有;部署 / 在线更新写文件时会把这里的缓存作废(system/node-direct-files.mjs)
  if (String(srsPath).endsWith('.json')) {
    let json = { version: 3, rules: [] }
    try { json = JSON.parse(await ctx.readFile(srsPath)) } catch { /* 没有文件 = 空集合 */ }
    let index = null
    try { index = buildRuleSetIndex(json) } catch { return null }
    cache.set(tag, { at: now(), srsPath, index })
    scheduleSweep()
    return index
  }
  const [hasKernel, hasSrs] = await Promise.all([ctx.exists(paths.singbox), ctx.exists(srsPath)])
  if (!hasKernel || !hasSrs) return null
  const jsonPath = `${paths.dataDir}/tmp/${tag}.index.json`
  let index = null
  try {
    await ctx.mkdirp(`${paths.dataDir}/tmp`)
    const r = await ctx.exec(paths.singbox, ['rule-set', 'decompile', '--output', jsonPath, srsPath])
    if (r.code !== 0) return null
    index = buildRuleSetIndex(JSON.parse(await ctx.readFile(jsonPath)))
  } catch {
    return null
  } finally {
    try { await ctx.remove(jsonPath) } catch { /* 临时文件,删不掉不影响 */ }
  }
  // 形状不支持(index === null)也记下来,免得每次查询都重新解码一遍再发现不支持
  cache.set(tag, { at: now(), srsPath, index })
  scheduleSweep()
  return index
}

// 过期的索引要真的放掉:只在下次访问时才判过期的话,查过一次就再没人用的集合会一直占着内存
// (正式路由器那一套规则集的索引约 9 MB)。有缓存时挂一个到点清理的定时器,不阻止进程退出
let sweepTimer = null
export const sweepExpired = (now = Date.now()) => {
  for (const [tag, entry] of cache) if (now - entry.at >= TTL_MS) cache.delete(tag)
  return cache.size
}
const scheduleSweep = () => {
  if (sweepTimer) return
  sweepTimer = setTimeout(() => {
    sweepTimer = null
    if (sweepExpired() > 0) scheduleSweep()
  }, TTL_MS + 1000)
  sweepTimer.unref?.()
}

// 某几份规则集的文件刚被重编过:它们的索引不等 10 分钟过期,立刻作废(规则页的推算才和内核看到的一致)
export const dropRuleSetIndex = (tags) => {
  for (const tag of tags || []) cache.delete(tag)
}

export const clearRuleSetIndexCache = () => {
  cache.clear()
  if (sweepTimer) clearTimeout(sweepTimer)
  sweepTimer = null
}
