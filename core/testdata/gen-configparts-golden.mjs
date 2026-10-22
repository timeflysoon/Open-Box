// 生成 internal/config 里几个小零件的金标准:tun-options、node-dns、config.mjs 开头的常量和两个小函数。
// 基线:上游 v0.1.318 快照(tag engine-snapshot)里 panel/server/engine/ 的明文源码。
// 用法: node core/testdata/gen-configparts-golden.mjs <engine 基线目录> [输出文件]
//   目录要含 config.mjs 及它依赖的全部模块、tun-options.mjs、node-dns.mjs;
//   上层 panel/server/ 要有 {"type":"module"} 的 package.json 和 system/panel-port.mjs。
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const engineDir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./configparts_golden.json', import.meta.url).pathname)
const imp = (f) => import(pathToFileURL(resolve(engineDir, f)).href)
const tunOpts = await imp('tun-options.mjs')
const nodeDns = await imp('node-dns.mjs')
const cfg = await imp('config.mjs')
const flip = await imp('flip.mjs')

let seed = 20261023
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(rnd() * n)
const pick = (a) => a[int(a.length)]
const rt = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const cases = []
const stats = {}
const add = (fn, args, run) => {
  const a = rt(args)
  let want, error
  try { want = rt(run(...a)) } catch (e) { error = String(e && e.message || e) }
  cases.push({ fn, args: a, want: want === undefined ? null : want, error: error || '' })
  stats[fn] = (stats[fn] || 0) + 1
}

// ---------- tun-options ----------
const junk = () => pick([undefined, null, true, false, 0, 1, -1, 'x', '', ' mixed ', [], {}, [1], { a: 1 }, 'gvisor'])
const numLike = () => pick([1500.5, 1280.1, 600.7, 65494.5, 0, -0, 1, 535, 536, 1279, 1280, 1500, 9000, 65495, 65496, 65535, 65536, 1.5, 1280.0, 1e3, 1e5, -1280, '1500', '0', null, undefined, true, [], [1500], {}, 'x', 1e21])
for (let i = 0; i < 400; i++) {
  const tun = pick([() => ({ stack: pick(['mixed', 'gvisor', 'system', 'Mixed', 'user', '', null, 5, ['gvisor'], undefined]), mtu: numLike(), tcpMss: numLike() }), () => junk(), () => ({}), () => ({ stack: junk(), mtu: junk(), tcpMss: junk() })])()
  const profile = pick([() => ({ tun }), () => ({ tun }), () => ({ tun }), () => junk(), () => ({}), () => ({ tun: junk() })])()
  add('tunStack', [profile], tunOpts.tunStack)
  add('tunMtu', [profile], tunOpts.tunMtu)
  add('tunTcpMss', [profile], tunOpts.tunTcpMss)
}
add('tunConsts', [], () => ({ name: tunOpts.TUN_INTERFACE_NAME, stacks: tunOpts.TUN_STACKS, mtu: [tunOpts.TUN_MTU_MIN, tunOpts.TUN_MTU_MAX], mss: [tunOpts.TUN_MSS_MIN, tunOpts.TUN_MSS_MAX] }))

// ---------- node-dns ----------
const urls = ['https://dns.example.net:2096/private-path', 'https://dns.example.net/dns-query', 'https://dns.example.net/', 'https://dns.example.net', 'https://1.2.3.4/dns-query', 'https://1.2.3.4:8443/x?y=1', 'https://[2001:db8::1]/dns-query', 'https://[2001:db8::1]:853/a b', 'HTTPS://DNS.EXAMPLE.NET/A', 'https://dns.example.net/a/../b/./c', 'https://dns.example.net/p?token=abc def&x=\'1\'', 'https://dns.example.net:443/dns-query', 'https://dns.example.net:0443/', 'https://dns.example.net:0/', 'https://u@dns.example.net/', 'https://u:p@dns.example.net/', 'https://:p@dns.example.net/', 'https://dns.example.net/#f', 'https://dns.example.net/#', 'https://dns.example.net/?', 'http://dns.example.net/', 'tls://dns.example.net', 'dns.example.net', '//dns.example.net', 'https://', 'https:///x', 'https://dns.example.net:99999/', 'https://中文.example.com/路径?查询=值', 'https://xn--fiq228c.com/', '  https://dns.example.net/x  ', '\thttps://dns.example.net/\n', 'https://dns.example.net:2096/%E4%B8%AD', 'https://0x7f.1/', 'https://127.1/dns-query', 'https://a_b.example.com/', '', ' ', 'x'.repeat(10)]
const longUrl = 'https://dns.example.net/' + 'a'.repeat(2030)
const boots = ['', '223.5.5.5', '2400:3200::1', '8.8.8.8 ', ' 1.1.1.1', 'dns.example.com', '1.2.3', '256.1.1.1', '::1', 'fe80::1%eth0', '[::1]', 'x', ' ', undefined, null, 5, true, [], ['1.1.1.1'], {}]
const goodObj = () => pick([{ url: 'https://dns.example.net:2096/private-path', bootstrap: '223.5.5.5' }, { url: 'https://1.2.3.4/dns-query' }, { url: 'https://dns.example.net/dns-query', bootstrap: ' 8.8.8.8 ' }, { url: 'https://[2001:db8::1]:853/a b' }, { url: ' https://dns.example.net/a/../b?x=1 ', bootstrap: '2400:3200::1' }, { url: 'https://中文.example.com/路径?查询=值', bootstrap: '1.1.1.1' }, { url: 'https://dns.example.net:443/', bootstrap: '1.1.1.1', extra: 1 }])
const rawNodeDns = () => {
  const r = rnd()
  if (r > 0.55) return goodObj()
  if (r < 0.06) return pick([null, undefined, 'x', 5, true, false, [], [1], '', 0])
  const o = {}
  const u = rnd() < 0.05 ? longUrl : pick(urls.concat([undefined, null, 5, true, [], {}, ['https://dns.example.net/']]))
  if (u !== undefined || rnd() < 0.1) o.url = u
  const b = pick(boots)
  if (b !== undefined || rnd() < 0.05) o.bootstrap = b
  if (rnd() < 0.1) o.extra = pick([1, 'x', null])
  return o
}
for (let i = 0; i < 900; i++) {
  const raw = rawNodeDns()
  add('validateNodeDns', [raw], (x) => nodeDns.validateNodeDns(x))
  add('normalizeNodeDns', [raw], (x) => nodeDns.normalizeNodeDns(x))
}
// 长度边界:2048 个 UTF-16 码元合法、2049 不合法;中文按码元数算(字节多、码元少),emoji 一个占两个码元
const base = 'https://dns.example.net/'
const lenCases = []
for (const k of [2046, 2047, 2048, 2049, 2050]) lenCases.push(base + 'a'.repeat(k - base.length))
lenCases.push('  ' + base + 'a'.repeat(2048 - base.length) + '  ', '\t' + base + 'a'.repeat(2049 - base.length) + '\n')
lenCases.push(base + '中'.repeat(700), base + '中'.repeat(2024), base + '中'.repeat(2025), base + '😀'.repeat(1012), base + '😀'.repeat(1013), base + '😀'.repeat(1030))
for (const u of lenCases) for (const bootstrap of ['1.1.1.1', '']) {
  const raw = bootstrap ? { url: u, bootstrap } : { url: u }
  add('validateNodeDns', [raw], (x) => nodeDns.validateNodeDns(x))
  add('normalizeNodeDns', [raw], (x) => nodeDns.normalizeNodeDns(x))
  add('nodeDnsServers', [raw, 'len'], (x, y) => nodeDns.nodeDnsServers(x, y))
}
const ids = ['sub1', 'sub-2', 'a_b', 'a b', '中文', '😀x', 'x'.repeat(60), 'a.b/c?d', '', 0, 1, 12.5, true, false, null, undefined, 'dns-sub-x', ' ']
for (let i = 0; i < 400; i++) {
  const raw = rawNodeDns(); const id = pick(ids)
  add('nodeDnsServers', [raw, id], (x, y) => nodeDns.nodeDnsServers(x, y))
}
const goodDns = () => pick([{ url: 'https://dns.example.net:2096/p', bootstrap: '223.5.5.5' }, { url: 'https://1.2.3.4/dns-query' }, { url: 'https://dns.example.net/dns-query', bootstrap: '8.8.8.8' }, rawNodeDns()])
const subs = () => {
  const n = int(6)
  return Array.from({ length: n }, () => {
    const r = rnd()
    if (r < 0.08) return pick([null, undefined, 0, '', 'str', 5, [], false])
    const s = { id: pick(ids), nodeDns: goodDns() }
    if (rnd() < 0.15) s.enabled = false
    if (rnd() < 0.05) s.enabled = pick([null, 0, 'false'])
    if (rnd() < 0.05) delete s.id
    if (rnd() < 0.1) delete s.nodeDns
    return s
  })
}
for (let i = 0; i < 600; i++) {
  const list = pick([() => subs(), () => subs(), () => subs(), () => pick([null, undefined, {}, 'x', 5, []])])()
  add('planNodeDns', [list], (x) => { const p = nodeDns.planNodeDns(x); return { servers: p.servers, bySubscription: Array.from(p.bySubscription) } })
}
const mk = () => ({ type: 'vmess', tag: 'a', server: pick(['a.example.com', 'b.example.net', 'c.d.e', '中文.com', '1.2.3.4', '::1', '2001:db8::1', '', 'x', ' ', '1.2.3', 'fe80::1%eth0']), server_port: 443 })
const ob = () => pick([mk, mk, mk, mk, mk, mk, () => ({ type: 'x', server: 5 }), () => ({ type: 'x' }), () => ({ server: null }), () => null, () => undefined, () => 'str', () => [], () => ({ server: 'a.example.com', domain_resolver: 'old' })])()
for (let i = 0; i < 300; i++) add('withNodeResolver', [ob(), pick(['dns-sub-x', 'dns-sub-y', 'a', 'dns-sub-z', '', null, undefined, 0])], (o, t) => nodeDns.withNodeResolver(o, t))

// ---------- config.mjs 的常量和小函数 ----------
add('configConsts', [], () => ({
  panelInboundPort: cfg.PANEL_INBOUND_PORT, panelInboundTag: cfg.PANEL_INBOUND_TAG, tunV4Net: cfg.TUN_V4_NET, tunV6Net: cfg.TUN_V6_NET,
  dnsInboundPort: cfg.DNS_INBOUND_PORT, dnsDirectInboundTag: cfg.DNS_DIRECT_INBOUND_TAG, dnsDirectInboundPort: cfg.DNS_DIRECT_INBOUND_PORT,
  dnsmasqOutboundTag: cfg.DNSMASQ_OUTBOUND_TAG, defaultRulesetDir: cfg.DEFAULT_RULESET_DIR, flipDirName: flip.FLIP_DIR_NAME,
}))
const dirs = ['/opt/open-box/data/rulesets', '/opt/open-box/data/rulesets/', '/a/b/c', '/a/b/c/', '/a', '/', '', 'rel/dir', 'rel', 'a//b', '/a/b//', '中文/目录/x', '/x y/z w', null, undefined, 0, false, 5, 'no-slash', '/a/b/c.d', '//', '///a']
for (const d of dirs) add('flipDirFor', [d], (x) => cfg.flipDirFor(x))
for (let i = 0; i < 200; i++) {
  const t = () => pick(['a', 'b', 'c', 'a', 'b', 'dns', '', 'a', 'b', 5, null, undefined, true, ['a'], {}])
  const n = 2 + int(6)
  const list = Array.from({ length: n }, () => pick([() => ({ tag: t() }), () => ({ tag: pick(['a', 'b', 'c', 'dns', '']) }), () => ({ tag: pick(['a', 'b', 'c']), type: 'direct' }), () => ({ tag: t(), type: 'direct' }), () => ({ type: 'direct' }), () => null, () => undefined, () => 'str', () => 0, () => ({})])())
  add('findDuplicateTag', [list], (x) => cfg.findDuplicateTag(x))
}

writeFileSync(out, JSON.stringify({ generatedBy: 'gen-configparts-golden.mjs', cases }) + '\n')
console.log('写入', cases.length, '条 →', out)
console.log(stats)
const nz = (fn, f) => cases.filter((c) => c.fn === fn && f(c)).length
console.log('validateNodeDns 合法', nz('validateNodeDns', (c) => c.want === null), '| nodeDnsServers 非空', nz('nodeDnsServers', (c) => c.want), '| 带 bootstrap 的', nz('nodeDnsServers', (c) => c.want && c.want.servers.length === 2), '| planNodeDns 有映射', nz('planNodeDns', (c) => c.want.bySubscription.length > 0), '| withNodeResolver 加了', nz('withNodeResolver', (c) => c.want && c.want.domain_resolver && c.want.domain_resolver !== 'old'), '| findDuplicateTag 有重复', nz('findDuplicateTag', (c) => c.want))
