// 生成「configDetailed 叶子模块」的金标准:IP/CIDR 工具、终端分流、服务端入站、直连主机、DNS 重写。
// 用法: node core/testdata/gen-leaf-golden.mjs <旧 engine 目录> [输出文件]
//   旧 engine 目录要含 client-routes.mjs、servers.mjs、direct-hosts.mjs、dns-rewrite.mjs、dns-names.mjs,
//   以及 local-subnets.mjs(来自 origin/backup:panel/server/system/local-subnets.mjs);且需要 {"type":"module"} 的 package.json。
import net from 'node:net'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./leaf_golden.json', import.meta.url).pathname)
const imp = (f) => import(pathToFileURL(resolve(dir, f)).href)
const [cr, sv, dh, dr, ls] = await Promise.all([imp('client-routes.mjs'), imp('servers.mjs'), imp('direct-hosts.mjs'), imp('dns-rewrite.mjs'), imp('local-subnets.mjs')])

let seed = 31337
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rnd() * a.length)]
const chance = (p) => rnd() < p
const int = (n) => Math.floor(rnd() * n)
const maybe = (p, f) => (chance(p) ? f() : undefined)
const rt = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const garbage = () => pick([undefined, null, true, false, 0, 5, -1, 'x', '', ' ', [], {}, ['y'], { a: 1 }])

// ---------- IP 语料 ----------
const hex = () => int(0x10000).toString(16)
const v4 = () => [0, 1, 2, 3].map(() => pick([int(256), int(256), int(256), 0, 255, 256, 300, '01', '001'])).join('.')
const v6 = () => {
  const n = 1 + int(8)
  const groups = Array.from({ length: n }, () => pick([hex(), hex(), '0', 'ffff', 'ABCD', '12345', 'g1', '']))
  const form = int(5)
  if (form === 0) return groups.join(':')
  const cut = int(groups.length + 1)
  const s = groups.slice(0, cut).join(':') + '::' + groups.slice(cut).join(':')
  return form === 1 ? s : form === 2 ? s + ':' + v4() : form === 3 ? '::ffff:' + v4() : s + pick(['%eth0', '%', '%1', ''])
}
const IPS = ['1.2.3.4', '01.2.3.4', '256.1.1.1', '1.2.3', '1.2.3.4.5', '0.0.0.0', '255.255.255.255', ' 1.2.3.4', '', '::', '::1', '2001:db8::1', '2001:DB8::1',
  '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', '1::2::3', '::ffff:1.2.3.4', '::ffff:999.1.1.1', 'fe80::1%eth0', 'fe80::1%', '1:2:3', '12345::1',
  '2001:db8:0:0:0:0:0:0:1', '::1.2.3.4', '1:2:3:4:5:6:1.2.3.4', 'g::1', ':::', ':1', '1:', '192.168.1.1', '10.0.0.0', 'abc', '1.2.3.4 ', '1.2.3.04', '0x7f.0.0.1',
  '1:2:3:4:5:6:7::8', '1:2:3:4:5:6:7:8::', '::1:2:3:4:5:6:7:8', '1:2:3:4:5:6::7', '1::2:3:4:5:6:7', '::ffff:1.2.3.4/96', '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8']
const okV4 = () => [1, 2, 3, 4].map(() => int(256)).join('.')
const okV6 = () => {
  const g = Array.from({ length: 8 }, () => pick([hex(), hex(), '0', '0']))
  const cut = int(7)
  return chance(0.5) ? g.join(':') : g.slice(0, cut).join(':') + '::' + g.slice(cut + 1 + int(Math.max(1, 7 - cut))).join(':')
}
const anyIp = () => (chance(0.25) ? pick(IPS) : chance(0.3) ? okV4() : chance(0.3) ? okV6() : chance(0.5) ? v4() : v6())
const PREFIX = ['', '0', '8', '08', '24', '32', '33', '64', '128', '129', 'x', '-1', '1e1', ' 8', '8 ', '999999999999999999999', '007']
const cidr = () => anyIp() + pick(['', '', '/' + pick(PREFIX), '/' + int(40), '/' + int(140), '/'])

const cases = []
const add = (fn, args, f) => {
  const input = rt(args)
  try { cases.push({ fn, args: input, want: rt(f(...input)) }) } catch (e) { cases.push({ fn, args: input, error: e.message }) }
}

for (let i = 0; i < 300; i++) { const s = anyIp(); add('isIPv4', [s], (x) => net.isIPv4(x)); add('isIPv6', [s], (x) => net.isIPv6(x)); add('isIP', [s], (x) => net.isIP(x)) }
// CIDR 运算:parseCidr 不能直接序列化(BigInt),用 subtractCidrs([x], []) 间接验证解析 + 格式化
for (let i = 0; i < 250; i++) add('subtractCidrs', [[cidr()], []], (b, h) => ls.subtractCidrs(b, h))
for (let i = 0; i < 250; i++) {
  const base = () => (chance(0.5) ? pick(['10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12', '0.0.0.0/0', '2001:db8::/32', '::/0', 'fd00::/8']) : cidr())
  const hole = () => (chance(0.6) ? pick(['10.1.0.0/16', '192.168.3.0/24', '10.0.0.0/8', '172.20.1.1', '2001:db8:1::/48', 'fd00::1', '192.168.0.0/17', '0.0.0.0/1']) : cidr())
  add('subtractCidrs', [Array.from({ length: 1 + int(2) }, base), Array.from({ length: int(4) }, hole)], (b, h) => ls.subtractCidrs(b, h))
}
for (let i = 0; i < 200; i++) {
  const a = chance(0.85) ? pick(['10.0.0.0/8', '192.168.0.0/16', '2001:db8::/32', '10.0.0.0/24', '0.0.0.0/0']) : cidr()
  const b = chance(0.85) ? pick(['10.1.2.3', '192.168.3.0/24', '10.0.0.0/7', '2001:db8:1::1', '8.8.8.8', '10.0.0.5', '192.168.0.0/15', '::1']) : cidr()
  add('cidrsOverlap', [a, b], (x, y) => ls.cidrsOverlap(x, y))
  add('cidrContains', [a, b], (x, y) => ls.cidrContains(x, y))
}
// 垃圾输入
for (const g of [null, undefined, 0, 5, true, {}, [], ['1.2.3.4']]) add('subtractCidrs', [[g], []], (b, h) => ls.subtractCidrs(b, h))

// ---------- 终端分流 ----------
const MACS = ['aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:gg', ' aa:bb:cc:dd:ee:ff ', '', 'aabbccddeeff', 'aa:bb:cc:dd:ee:ff:00', 5, null]
for (let i = 0; i < 150; i++) add('normalizeCidr', [chance(0.1) ? garbage() : cidr()], (x) => cr.normalizeCidr(x))
for (let i = 0; i < 80; i++) add('normalizeMac', [chance(0.15) ? garbage() : pick(MACS)], (x) => cr.normalizeMac(x))
const route = () => ({
  id: maybe(0.7, () => pick(['r1', '', 5, null, ' x '])), name: maybe(0.7, () => pick(['电视', '', 'x', null])), enabled: maybe(0.4, () => pick([true, true, true, false, null, 0])),
  sources: maybe(0.9, () => (chance(0.1) ? garbage() : Array.from({ length: int(4) }, () => (chance(0.1) ? garbage() : chance(0.75) ? pick(['192.168.1.5', '192.168.1.0/24', '192.168.2.9/32', '10.0.0.1/8', '2001:db8::/64', '2001:db8::1', '10.0.0.1/33', 'fe80::1%eth0', 'bad']) : cidr())))),
  bypass: maybe(0.4, () => pick([true, false, 'true', 1])), macs: maybe(0.6, () => (chance(0.1) ? garbage() : Array.from({ length: int(4) }, () => pick(MACS)))),
  outbound: maybe(0.85, () => pick(['美国', ' 香港 ', '美国', 'direct', '', 5, null, '直连X'])),
})
for (let i = 0; i < 250; i++) add('normalizeClientRoutes', [chance(0.05) ? garbage() : Array.from({ length: int(5) }, () => (chance(0.08) ? garbage() : route())), pick([{}, {}, { directTag: '直连' }, { directTag: '' }, { directTag: null }, { directTag: 'direct' }])], (l, o) => cr.normalizeClientRoutes(l, o))

// ---------- 服务端入站 ----------
const server = () => ({
  id: maybe(0.9, () => pick(['a1', 'b2', 3, null, ''])), enabled: maybe(0.5, () => pick([true, false, null, 0])), protocol: maybe(0.95, () => pick(['shadowsocks', 'vless', 'tuic', 'hysteria2', 'mixed', 'bogus', ''])),
  port: maybe(0.9, () => pick([7080, 8443, '9000', 0, null])), method: maybe(0.6, () => pick(['aes-256-gcm', '', null])), password: maybe(0.7, () => pick(['pw', '', 5, null])),
  uuid: maybe(0.7, () => pick(['u1', '', null])), tls: maybe(0.6, () => pick([true, false, 'true', 1, null])), obfs: maybe(0.5, () => pick(['o', '', null, 0])), username: maybe(0.5, () => pick(['u', '', null])),
})
for (let i = 0; i < 250; i++) add('buildServerInbounds', [chance(0.05) ? garbage() : Array.from({ length: int(5) }, () => (chance(0.08) ? garbage() : server())), pick([{}, { certPath: '/c.pem', keyPath: '/k.pem' }, { certPath: '/c.pem' }, undefined, null, {}]) ?? {}], (s, o) => sv.buildServerInbounds(s, o))

// ---------- 直连主机 ----------
const HOSTS = ['a.com', 'B.EXAMPLE.com', 'localhost', '1.2.3.4', '999.1.1.1', '2001:db8::1', 'bad_host.com', 'nodot', '中文.com', 'sub.中文.cn', '', ' ', 'a b.com', 'x.com.']
const URLS = ['https://sub.example.com/path?x=1', 'http://Example.COM:8443/a', 'https://1.2.3.4:443/x', 'http://[2001:db8::1]:80/', 'http://[2001:DB8:0:0:0:0:0:1]/', 'sub.example.com/path', 'ss://user@h.example.org:1/#n',
  'https://中文.com/订阅', 'ftp://files.example.net/', 'mailto:a@b.com', '//host.com/x', 'http://', 'http://a b.com/', 'http://a.com:abc/', ' https://trim.example.com ', 'https://u:p@auth.example.com/', 'HTTPS://UP.EXAMPLE.COM', 'http://localhost:8080/', 'https://[::1]/', 'https://a.com./', '', 5, null, 'vmess://abcd==']
const node = () => (chance(0.1) ? garbage() : { server: maybe(0.9, () => (chance(0.5) ? pick(HOSTS) : pick([5, null, true]))) })
const sub = () => (chance(0.1) ? garbage() : { url: maybe(0.7, () => pick(URLS)), urls: maybe(0.5, () => (chance(0.1) ? garbage() : Array.from({ length: int(3) }, () => pick(URLS)))) })
for (let i = 0; i < 250; i++) add('collectDirectHosts', [Array.from({ length: int(5) }, node), Array.from({ length: int(4) }, sub)], (n, s) => dh.collectDirectHosts(n, s))

// ---------- DNS 重写 ----------
const DOMS = ['services.googleapis.cn', 'Example.COM', '*.example.com', '*.', '*', 'a*.com', 'x.com.', 'x.com..', '-bad.com', 'bad-.com', 'under_score.com', 'a..b', ' pad.com ', '', 'x'.repeat(64) + '.com', '*.*.com', 'ok-1.net', '中文.com', 5, null]
const VALID = ['services.googleapis.cn', 'example.com', '*.example.com', 'a.b.c.org', 'x-1.net', 'Foo.Bar.com', '*.sub.example.org', 'x.com.']
const rule = () => ({
  id: maybe(0.7, () => pick(['r1', '', ' x ', 5, null])), enabled: maybe(0.4, () => pick([true, true, true, false, null, 0])), source: maybe(0.9, () => (chance(0.75) ? pick(VALID) : pick(DOMS))), domain: maybe(0.5, () => (chance(0.75) ? pick(VALID.filter((d) => !d.startsWith('*'))) : pick(DOMS))),
  addresses: maybe(0.6, () => (chance(0.1) ? garbage() : Array.from({ length: int(4) }, () => (chance(0.5) ? pick(['1.2.3.4', ' 1.2.3.4 ', '2001:DB8::1', 'bad', '', '1.2.3.4', 5]) : anyIp())))),
  note: maybe(0.5, () => pick(['n', ' pad ', '', 5, 'x'.repeat(300), '😀'.repeat(150)])),
})
const dns = () => (chance(0.05) ? garbage() : { rewrite: maybe(0.95, () => (chance(0.05) ? garbage() : { enabled: maybe(0.3, () => pick([true, true, false, null, 0])), initialized: maybe(0.5, () => pick([true, false, 1, 0, null])), rules: maybe(0.9, () => (chance(0.08) ? garbage() : Array.from({ length: int(5) }, () => (chance(0.08) ? garbage() : rule())))) })) })
for (let i = 0; i < 200; i++) add('normalizeDnsRewrite', [dns()], (d) => dr.normalizeDnsRewrite(d))
for (let i = 0; i < 150; i++) add('rewriteDnsRules', [dns()], (d) => dr.rewriteDnsRules(dr.normalizeDnsRewrite(d).rules))
for (let i = 0; i < 150; i++) add('normalizeDomain', [chance(0.1) ? garbage() : pick(DOMS), pick([{}, { allowWildcard: true }])], (r, o) => dr.normalizeDomain(r, o))
for (let i = 0; i < 80; i++) add('normalizeRule', [chance(0.1) ? garbage() : rule(), int(5)], (r, i2) => dr.normalizeRule(r, i2))
add('rewriteDnsServer', [], () => dr.rewriteDnsServer())

writeFileSync(out, JSON.stringify({ generatedBy: 'gen-leaf-golden.mjs', cases }) + '\n')
const by = {}
for (const c of cases) by[c.fn] = (by[c.fn] || 0) + 1
const nonTrivial = (fn, f) => cases.filter((c) => c.fn === fn && c.want !== undefined && f(c.want)).length
console.log('写入', cases.length, '条 →', out)
console.log(by)
console.log('isIPv4 为真', nonTrivial('isIPv4', (w) => w), '| isIPv6 为真', nonTrivial('isIPv6', (w) => w),
  '| subtract 结果非空', nonTrivial('subtractCidrs', (w) => w.length), '| subtract 多段(被挖开)', nonTrivial('subtractCidrs', (w) => w.length > 1),
  '| overlap 为真', nonTrivial('cidrsOverlap', (w) => w), '| contains 为真', nonTrivial('cidrContains', (w) => w))
console.log('clientRoutes 非空', nonTrivial('normalizeClientRoutes', (w) => w.length), '| bypass 路由', cases.filter((c) => c.fn === 'normalizeClientRoutes' && c.want && c.want.some((r) => r.bypass)).length,
  '| servers 非空', nonTrivial('buildServerInbounds', (w) => w.length), '| directHosts 域名', nonTrivial('collectDirectHosts', (w) => w.domains.length), 'cidr', nonTrivial('collectDirectHosts', (w) => w.cidrs.length),
  '| rewrite 规则非空', nonTrivial('normalizeDnsRewrite', (w) => w.rules.length), '| rewriteDnsRules 非空', nonTrivial('rewriteDnsRules', (w) => w.length))
