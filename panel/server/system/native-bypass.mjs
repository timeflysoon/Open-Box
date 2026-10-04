// 入口原生旁路的第二步(部署时):纯函数 nativeBypassPlan(engine/routing-model.mjs)给出候选集合和 pending
// ("这个直连集合要和前面哪些带 IP 条件的规则核对重叠")。这里把每一份候选集合都解码成 CIDR 做内容校验,
// 再对 pending 做区间重叠核对。**按集合各自判**,一份集合不合格不牵连同一站点集里的兄弟集合:
//   · 含逻辑 / 取反规则、不是纯目标 IP(带域名 / 端口 / 来源条件)、解不开、没有 ip_cidr 的集合 → 不旁路;
//   · 含"一直到地址空间末尾"区间的(240.0.0.0/4、224.0.0.0/3、ff00::/8 之类)→ 以前整份不旁路(sing-tun 把区间写成
//     [起点, 终点+1),终点+1 溢出后用起点当终点键,和别的区间同在集合里就 EEXIST、auto_redirect 起不来,开发路由器
//     实测),现在把终点收回一个地址再旁路;
//   · FakeIP 试验开着时,集合和占位地址池(198.19.0.0/16 / fc00::/18)有交集 → 以前整份不旁路(占位地址进了直连
//     集合会在入口先被放走,后面的域名规则没机会执行,第四轮 T4),现在扣掉占位地址池再旁路;
//   · pending:和前面某条带 IP 条件规则的范围有交集 → 以前整份不旁路,现在**扣掉重叠的那几段再旁路**,原因写明
//     扣了什么。前面那条规则要的地址照旧进内核按顺序匹配,安全性不变。
// 扣过的集合不能再用原来的 geoip-* 文件:剩下的 CIDR 编成一份裁剪过的 .srs 写进 data/flip/(system/flip-files.mjs),
// 结果里带 trimmed。GitHub #224:默认分流「国内」= geoip-cn + geoip-private,以前 geoip-private 的 224.0.0.0/3
// 一挡整个站点集都不旁路,geoip-cn 又和「国外」的 geoip-cloudfront 有一段重叠——默认配置下入口旁路从来没开过,
// 国内直连流量全进用户态,吞吐只有内核转发的一半。
import { decodeRuleSetJson } from './dns-forward.mjs'
import { parseCidr } from './local-subnets.mjs'
import { readRuleListShapes } from './rule-lists.mjs'
import { rulesetPath } from './rulesets.mjs'
import { FAKEIP_V4, FAKEIP_V6 } from '../engine/dns.mjs'
import { ruleListIpTag } from '../engine/rule-list.mjs'

const V4_BITS = 32n
const V6_BITS = 128n
const MAX = { 4: (1n << V4_BITS) - 1n, 6: (1n << V6_BITS) - 1n }
const rangeOf = (c) => {
  const p = parseCidr(c)
  if (!p) return null
  const bits = p.family === 4 ? V4_BITS : V6_BITS
  const size = 1n << (bits - BigInt(p.prefix))
  return { family: p.family, start: p.net, end: p.net + size - 1n, cidr: c }
}
const formatRange = (r) => (r.family === 4 ? `${[24, 16, 8, 0].map((s) => Number((r.start >> BigInt(s)) & 255n)).join('.')}…` : `${r.start.toString(16).slice(0, 8)}…`)
// 两组 CIDR 有没有交集:按起点排序后扫一遍
export const cidrListsOverlap = (a, b) => {
  const ra = a.map(rangeOf).filter(Boolean)
  const rb = b.map(rangeOf).filter(Boolean)
  for (const family of [4, 6]) {
    const xs = ra.filter((r) => r.family === family).sort((p, q) => (p.start < q.start ? -1 : 1))
    const ys = rb.filter((r) => r.family === family).sort((p, q) => (p.start < q.start ? -1 : 1))
    let i = 0
    let j = 0
    while (i < xs.length && j < ys.length) {
      const x = xs[i]
      const y = ys[j]
      if (x.end < y.start) i++
      else if (y.end < x.start) j++
      else return `${formatRange(x)} × ${formatRange(y)}`
    }
  }
  return ''
}
// 有没有区间一直到地址空间末尾(sing-tun 编不进 nft 集合)
export const reachesEndOfSpace = (cidrs) => {
  for (const c of cidrs) {
    const r = rangeOf(c)
    if (r && r.end === MAX[r.family]) return String(c)
  }
  return ''
}

// ---- 区间运算(BigInt) ----
const familyOf = (r) => r.family
// 合并:按起点排序,重叠 / 相邻的并成一段
export const mergeRanges = (ranges) => {
  const out = []
  for (const family of [4, 6]) {
    const xs = ranges.filter((r) => familyOf(r) === family).sort((p, q) => (p.start < q.start ? -1 : p.start > q.start ? 1 : 0))
    for (const r of xs) {
      const last = out[out.length - 1]
      if (last && last.family === family && r.start <= last.end + 1n) { if (r.end > last.end) last.end = r.end } else out.push({ family, start: r.start, end: r.end })
    }
  }
  return out
}
// a 减 b:两边都先合并;返回剩下的区间和被扣掉的区间
export const subtractRanges = (a, b) => {
  const cuts = mergeRanges(b)
  const kept = []
  const removed = []
  for (const r of mergeRanges(a)) {
    let cur = { ...r }
    for (const c of cuts.filter((c) => c.family === r.family && c.end >= r.start && c.start <= r.end)) {
      if (c.start > cur.start) kept.push({ family: r.family, start: cur.start, end: c.start - 1n })
      removed.push({ family: r.family, start: c.start > cur.start ? c.start : cur.start, end: c.end < cur.end ? c.end : cur.end })
      if (c.end >= cur.end) { cur = null; break }
      cur = { family: r.family, start: c.end + 1n, end: cur.end }
    }
    if (cur) kept.push(cur)
  }
  return { kept, removed }
}
const bitsOf = (family) => (family === 4 ? V4_BITS : V6_BITS)
const ipOf = (family, n) => {
  if (family === 4) return [24, 16, 8, 0].map((s) => Number((n >> BigInt(s)) & 255n)).join('.')
  const hex = n.toString(16).padStart(32, '0')
  const groups = hex.match(/.{4}/g).map((g) => g.replace(/^0+(?=.)/, ''))
  // 最长的一串 0 组压成 ::(和内核写法一致就行,不求最短)
  let best = { at: -1, len: 0 }
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== '0') continue
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > best.len) best = { at: i, len: j - i }
    i = j
  }
  if (best.len < 2) return groups.join(':')
  return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.len).join(':')}`
}
// 区间 → 最少的 CIDR
export const rangesToCidrs = (ranges) => {
  const out = []
  for (const r of ranges) {
    const bits = bitsOf(r.family)
    let start = r.start
    while (start <= r.end) {
      // 从最大的块往小找:起点对齐、又装得进剩余长度的第一个就是最大块
      let size = 0n
      for (let p = 0n; p <= bits; p++) {
        const blk = 1n << (bits - p)
        if (start % blk === 0n && start + blk - 1n <= r.end) { size = blk; out.push(`${ipOf(r.family, start)}/${p}`); break }
      }
      if (!size) break
      start += size
    }
  }
  return out
}
export const cidrsToRanges = (cidrs) => cidrs.map(rangeOf).filter(Boolean)
const describeRanges = (ranges) => ranges.slice(0, 3).map((r) => `${ipOf(r.family, r.start)}…`).join('、') + (ranges.length > 3 ? ` 等 ${ranges.length} 段` : '')

const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
const DOMAIN_KEYS = ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex']
// 一份规则集的内容形状(第四轮 U2)。入口旁路只认"仅目标 IP"的规则:sing-tun 从规则集里提取地址集合时
// 只取 ip_cidr,不带 port / source_ip_cidr / network 这些附加条件,整份拿去入口旁路就会把"只对 443 端口 /
// 只对某个来源直连"放大成全部直连。所以:
//   cidrs        规则里的 ip_cidr
//   unbounded    含逻辑 / 取反规则,范围说不清
//   domainKeys   含域名类条件(按内容认,不看集合叫不叫 geoip-*)
//   otherKeys    含 port / source_ip_cidr / network / process 等其它条件
const shapeOfRuleSet = (json) => {
  const out = { cidrs: [], unbounded: false, domainKeys: [], otherKeys: [] }
  for (const rule of (json && json.rules) || []) {
    if (!rule || typeof rule !== 'object') continue
    if (rule.type === 'logical' || rule.rules || rule.invert) { out.unbounded = true; continue }
    for (const key of Object.keys(rule)) {
      if (key === 'ip_cidr' || key === 'type') continue
      if (DOMAIN_KEYS.includes(key)) { if (!out.domainKeys.includes(key)) out.domainKeys.push(key) } else if (!out.otherKeys.includes(key)) out.otherKeys.push(key)
    }
    out.cidrs.push(...list(rule.ip_cidr))
  }
  return out
}

export const resolveNativeBypass = async (ctx, paths, plan) => {
  const base = { enabled: false, sets: [], trimmed: {}, pending: [], fakeIp: Boolean(plan && plan.fakeIp), checked: [], reason: (plan && plan.reason) || '' }
  if (!plan || typeof plan !== 'object') return base
  const candidates = [
    ...list(plan.sets).map((tag) => ({ policy: '', sets: [tag], against: [] })),
    ...list(plan.pending),
  ]
  if (!candidates.length) return base
  const cache = new Map()
  const decode = async (tag) => {
    if (cache.has(tag)) return cache.get(tag)
    const r = await decodeRuleSetJson(ctx, paths, tag)
    const v = r.error ? { error: r.error } : shapeOfRuleSet(r.json)
    cache.set(tag, v)
    return v
  }
  const sets = []
  const trimmed = {}
  const checked = []
  const reasons = plan.reason ? [plan.reason] : []
  const where = (item) => (item.policy ? `站点集「${item.policy}」` : '')
  // 规则集链接的形状(拆成了域名 / IP 哪几份,system/rule-lists.mjs 部署前刚写好);老版式没拆的不在表里
  let shapes = null
  const shapeOf = async (tag) => {
    if (!shapes) shapes = await readRuleListShapes(ctx, paths).catch(() => ({}))
    return shapes[tag] || null
  }
  // 前面走代理的规则集链接要的地址(#302):开着 FakeIP 时域名那份拿的是占位地址,不挡;IP 那份(list-xxx-ip.srs)解码出来
  // 当成它的 IP 条件扣掉。老版式没拆的名单整份解码,只取里面的 ip_cidr。说不清就返回 { error }
  const listRanges = async (tag) => {
    const shape = await shapeOf(tag)
    if (shape && !shape.ip) return { ranges: [] }
    const ipTag = shape ? ruleListIpTag(tag) : tag
    if (shape && !(await ctx.exists(rulesetPath(paths, ipTag)))) return { ranges: [] }
    const d = await decode(ipTag)
    if (d.error) return { error: d.error }
    if (d.unbounded) return { error: '含逻辑 / 取反规则,范围说不清' }
    return { ranges: cidrsToRanges(d.cidrs) }
  }
  for (const item of candidates) {
    // 前面带 IP 条件的规则的范围(整个 item 共用):任何一条说不清,这个 item 里的集合都不能算
    let againstBlocked = ''
    const other = []
    for (const e of list(item.against)) {
      const own = { name: e.name, ranges: cidrsToRanges(list(e.cidrs)) }
      if (e.lists && e.lists.length) {
        // 没开 FakeIP 时名单里的域名解析出来是真实地址,入口分不出来:整个挡住(计划阶段其实已经挡掉了,这里兜底)
        if (!plan.fakeIp) { againstBlocked = `「${e.name}」用了规则集链接「${e.lists[0]}」,里面有没有 IP 段说不清`; break }
        for (const tag of e.lists) {
          const r = await listRanges(tag)
          if (r.error) { againstBlocked = `「${e.name}」的规则集链接「${tag}」${r.error}`; break }
          own.ranges.push(...r.ranges)
        }
        if (againstBlocked) break
      }
      for (const tag of list(e.geoip)) {
        const d = await decode(tag)
        if (d.error) { againstBlocked = `「${e.name}」的集合「${tag}」${d.error}`; break }
        if (d.unbounded) { againstBlocked = `「${e.name}」的集合「${tag}」含逻辑 / 取反规则,范围说不清`; break }
        // 较早规则的集合按内容认:里面有域名条件,它就是一条域名规则,解析出来的 IP 在入口分不出来 → 挡住
        if (d.domainKeys.length) { againstBlocked = `「${e.name}」的集合「${tag}」含域名条件（${d.domainKeys.join(' / ')}）,它解析出来的 IP 在入口分不出来`; break }
        // 端口 / 来源等附加条件只会让较早规则更窄:仍按它的 IP 段核对重叠(保守)
        own.ranges.push(...cidrsToRanges(d.cidrs))
      }
      if (againstBlocked) break
      other.push(own)
    }
    for (const tag of list(item.sets)) {
      let blocked = againstBlocked
      const removed = []
      let cidrs = []
      if (!blocked) {
        const d = await decode(tag)
        if (d.error) blocked = `集合「${tag}」${d.error}`
        else if (d.unbounded) blocked = `集合「${tag}」含逻辑 / 取反规则,范围说不清`
        // 候选集合必须是"仅目标 IP":带域名 / 端口 / 来源等条件的规则,入口只按 IP 放行会放大直连范围
        else if (d.domainKeys.length || d.otherKeys.length) blocked = `集合「${tag}」不是纯目标 IP 规则（含 ${[...d.domainKeys, ...d.otherKeys].join(' / ')} 条件）,入口只按 IP 放行会放大它的范围`
        else if (!d.cidrs.length) blocked = `集合「${tag}」里没有 ip_cidr`
        else cidrs = d.cidrs
      }
      let ranges = blocked ? [] : mergeRanges(cidrsToRanges(cidrs))
      if (!blocked) {
        // 到地址空间末尾的区间:终点收回一个地址(sing-tun 编不进 nft 集合)
        const tail = reachesEndOfSpace(cidrs)
        if (tail) {
          ranges = ranges.map((r) => (r.end === MAX[r.family] ? { ...r, end: r.end - 1n } : r)).filter((r) => r.start <= r.end)
          removed.push(`到地址空间末尾的区间（${tail}）的最后一个地址`)
        }
        // FakeIP 试验开着:占位地址池扣掉(占位地址要进内核走域名规则)
        if (plan.fakeIp) {
          const cut = subtractRanges(ranges, cidrsToRanges([FAKEIP_V4, FAKEIP_V6]))
          if (cut.removed.length) { ranges = cut.kept; removed.push('FakeIP 占位地址池') }
        }
        // 前面带 IP 条件的规则要的地址:扣掉,让它们照旧进内核按顺序匹配
        for (const o of other) {
          const cut = subtractRanges(ranges, o.ranges)
          if (cut.removed.length) { ranges = cut.kept; removed.push(`和前面「${o.name}」重叠的 ${describeRanges(cut.removed)}`) }
        }
        if (!ranges.length) blocked = `集合「${tag}」${removed.length ? `扣掉 ${removed.join('、')} 之后一个地址都不剩` : '里没有可旁路的地址'}`
      }
      checked.push({ policy: item.policy || '', sets: [tag], ok: !blocked, trimmed: !blocked && removed.length > 0, reason: blocked || (removed.length ? `扣掉 ${removed.join('、')} 后旁路` : '') })
      if (blocked) { reasons.push(`${where(item)}${blocked},按兼容路径进内核`); continue }
      if (!sets.includes(tag)) sets.push(tag)
      if (removed.length) {
        const out = rangesToCidrs(ranges)
        trimmed[tag] = { cidrs: out, removed, original: cidrs.length }
        reasons.push(`${where(item)}集合「${tag}」扣掉 ${removed.join('、')} 后入口旁路（保留 ${out.length} 段）`)
      }
    }
  }
  return { enabled: sets.length > 0, sets, trimmed, pending: [], fakeIp: Boolean(plan.fakeIp), checked, reason: reasons.join(';') }
}
