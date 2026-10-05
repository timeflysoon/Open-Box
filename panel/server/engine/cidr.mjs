// CIDR 计算(纯函数,不碰系统):解析、重叠、包含、减法。生成配置要用(engine/config.mjs 算 tun 排除段、
// engine/direct-hosts.mjs 认共享任播段),这套代码也打进 App(client-engine,PM 2026-10-04:手机本机刷新订阅,
// 用和路由器同一套代码)。App 里的 QuickJS(zipline 1.20.1)没编 BigInt,所以地址用 16 位一组的数组表示
// (IPv4 2 组、IPv6 8 组),不用 BigInt。结果和 system/local-subnets.mjs 那份 BigInt 写法逐条一样
// (engine/cidr.test.mjs 随机对拍);路由器自己的旁路 / 规则集索引还用那份(它们要拿地址做区间运算)。

const BITS = { 4: 32, 6: 128 }

const parseV4 = (s) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (o.some((x) => x > 255)) return null
  return [(o[0] << 8) | o[1], (o[2] << 8) | o[3]]
}

const parseV6 = (s) => {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return null
  // 末尾可能是 IPv4 写法(::ffff:1.2.3.4),先换成两组 hex
  let text = s
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    const w = parseV4(v4[1])
    if (w === null) return null
    text = text.slice(0, -v4[1].length) + w[0].toString(16) + ':' + w[1].toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && head.length !== 8) return null
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const words = []
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    words.push(parseInt(g, 16))
  }
  return words
}

const formatV4 = (w) => `${w[0] >> 8}.${w[0] & 0xff}.${w[1] >> 8}.${w[1] & 0xff}`
const formatV6 = (w) => {
  const groups = w.map((x) => x.toString(16))
  // 压缩最长的一段连续 0
  let best = { start: -1, len: 0 }
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== '0') continue
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > best.len) best = { start: i, len: j - i }
    i = j
  }
  if (best.len < 2) return groups.join(':')
  const left = groups.slice(0, best.start).join(':')
  const right = groups.slice(best.start + best.len).join(':')
  return `${left}::${right}`
}

// 前 prefix 位保留,后面的位全清 0(网段起点)/ 全置 1(网段终点)
const maskWords = (w, prefix) => w.map((x, i) => {
  const keep = prefix - i * 16
  if (keep >= 16) return x
  if (keep <= 0) return 0
  return x & ((0xffff << (16 - keep)) & 0xffff)
})
const fillWords = (w, prefix) => w.map((x, i) => {
  const keep = prefix - i * 16
  if (keep >= 16) return x
  if (keep <= 0) return 0xffff
  return x | (0xffff >> keep)
})
const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}
// 把从高位数第 index 位(0 起)置 1
const setBit = (w, index) => w.map((x, i) => (i === index >> 4 ? x | (0x8000 >> (index & 15)) : x))

// 'a.b.c.d/n' / 'x::y/n' → { family, net(已按掩码取整,16 位一组的数组), prefix } ;不合法返回 null
export const parseCidr = (cidr) => {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(String(cidr || '').trim())
  if (!m) return null
  const v4 = parseV4(m[1])
  const v6 = v4 === null ? parseV6(m[1]) : null
  const family = v4 !== null ? 4 : v6 !== null ? 6 : 0
  if (!family) return null
  const bits = BITS[family]
  const prefix = m[2] === undefined ? bits : Number(m[2])
  if (prefix < 0 || prefix > bits) return null
  return { family, net: maskWords(family === 4 ? v4 : v6, prefix), prefix }
}

export const formatCidr = ({ family, net, prefix }) => `${family === 4 ? formatV4(net) : formatV6(net)}/${prefix}`

const endOf = (c) => fillWords(c.net, c.prefix)
const overlaps = (a, b) => a.family === b.family && compare(a.net, endOf(b)) <= 0 && compare(b.net, endOf(a)) <= 0
export const covers = (outer, inner) => outer.family === inner.family && compare(outer.net, inner.net) <= 0 && compare(endOf(inner), endOf(outer)) <= 0

// 两个网段有没有交集(任一方向包含、或部分重叠都算)
export const cidrsOverlap = (a, b) => {
  const x = parseCidr(a)
  const y = parseCidr(b)
  return Boolean(x && y && overlaps(x, y))
}

export const cidrContains = (cidr, ip) => {
  const c = parseCidr(cidr)
  const p = parseCidr(ip)
  return Boolean(c && p && covers(c, p))
}

// bases 里挖掉 holes,结果仍是一组 CIDR(按需二分,直到与所有洞都不相交)
export const subtractCidrs = (bases, holes) => {
  const hs = holes.map(parseCidr).filter(Boolean)
  const out = []
  const walk = (c) => {
    const hit = hs.filter((h) => overlaps(c, h))
    if (!hit.length) { out.push(c); return }
    if (hit.some((h) => covers(h, c))) return
    if (c.prefix >= BITS[c.family]) return
    // 两半:前一半起点不变;后一半起点 = 起点 + 半个网段 = 第 prefix 位置 1(起点按掩码取整过,这一位原来是 0)
    walk({ family: c.family, net: c.net, prefix: c.prefix + 1 })
    walk({ family: c.family, net: setBit(c.net, c.prefix), prefix: c.prefix + 1 })
  }
  for (const b of bases.map(parseCidr).filter(Boolean)) walk(b)
  return out.map(formatCidr)
}
