// 生成 DNS 配置(旧 engine/dns.mjs 的 buildDnsWithResolvers)的金标准,以及 extractHost 的对照用例。
// 用法: node core/testdata/gen-dns-golden.mjs <旧 engine 目录> [输出文件]
//   旧 engine 目录取自 origin/backup:panel/server/engine(要含 dns.mjs、routing-model.mjs、rule-list.mjs、
//   dns-names.mjs、dns-rewrite.mjs),且上层要有 {"type":"module"} 的 package.json。
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./dns_golden.json', import.meta.url).pathname)
const imp = (f) => import(pathToFileURL(resolve(dir, f)).href)
const [dnsMod, rl] = await Promise.all([imp('dns.mjs'), imp('rule-list.mjs')])

let seed = 4242
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rnd() * a.length)]
const chance = (p) => rnd() < p
const some = (a, max) => Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => pick(a))
const rt = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

// ---- 与 gen-plans-golden.mjs 相同的站点集语料 ----
const DOMAINS = [
  'example.com', 'Example.COM', '*.sub.example.com', '.dot.com', 'trail.com.', 'a..b', '-bad.com', 'bad-.com',
  'ok-1.net', '中国.example', 'bücher.example', '例え.jp', 'пример.рф', '😀.example',
  'a b.com', 'with#hash.com', ' padded.org ', 'UPPER.CN', 'cdn.google.com', 'github.com', '1.2.3.4', 'xn--fiq228c.com', '',
]
const SETS = ['geosite-cn', 'geoip-cn', 'geosite-google', 'geoip-us', 'geoip-jp', 'geosite-netflix', 'geosite-category-ads-all']
const URLS = ['https://a.example/x.list', 'https://b.example/y.list', 'https://例え.jp/z.list']
const LIST_TAGS = URLS.map(rl.listTagForUrl)
const NAMES = ['A', 'B', 'C', '美国', '香港', '直连集', '代理集']
const MEMBERS = ['direct', 'block', '美国', '香港', '节点组A', '节点组B']
const DEFAULTS = ['direct', 'direct', 'direct', 'proxy', 'block', '美国', '香港', '', '不存在的组']

const policy = () => ({
  name: pick(NAMES), default: pick(DEFAULTS), enabled: chance(0.92),
  rulesets: some(SETS, 3), ruleUrls: chance(0.3) ? some(URLS, 2) : [],
  domain: chance(0.5) ? some(DOMAINS, 3) : [], domainSuffix: chance(0.4) ? some(DOMAINS, 2) : [],
  domainKeyword: chance(0.15) ? ['kw'] : [], ipCidr: chance(0.3) ? some(['10.0.0.0/8', '1.1.1.0/24'], 2) : [],
})
const customRule = () => {
  const type = pick(['domainSuffix', 'domain', 'domainKeyword', 'ipCidr', 'geosite', 'geoip', 'ruleUrl', 'ruleset', 'port'])
  const value = {
    domainSuffix: () => pick(DOMAINS), domain: () => pick(DOMAINS), domainKeyword: () => 'kw', ipCidr: () => '8.8.8.0/24',
    geosite: () => 'netflix', geoip: () => 'us', ruleUrl: () => pick(URLS), ruleset: () => pick(['geosite-foo', ...LIST_TAGS]), port: () => '51820',
  }[type]()
  return { type, value: value || 'x.com', outbound: pick(['direct', 'block', '美国', '节点1', '节点2', '香港']) }
}
const routing = () => ({
  policies: Array.from({ length: Math.floor(rnd() * 5) }, policy),
  fallbackDefault: pick(['direct', 'direct', 'proxy', '美国', '']),
  fallbackName: chance(0.2) ? pick(['兜底', '其他']) : undefined,
  adBlock: chance(0.15), custom: chance(0.4) ? { rules: Array.from({ length: 1 + Math.floor(rnd() * 4) }, customRule) } : undefined,
})
const builtin = () => {
  const r = rnd()
  if (r < 0.55) return undefined
  const b = r < 0.8 ? { direct: '直连', block: '拒绝' } : { direct: 'direct', block: 'block' }
  return { ...b, directEnabled: chance(0.85), blockEnabled: chance(0.85) }
}
const groupTags = (b) => {
  const base = [b ? b.direct : 'direct', b ? b.block : 'block', ...some(MEMBERS.slice(2), 4)]
  return chance(0.06) ? [] : [...new Set(base)]
}
const selections = () => {
  if (chance(0.55)) return undefined
  const s = {}
  for (const n of [...NAMES, '其他', '兜底']) if (chance(0.25)) s[n] = pick([...MEMBERS, '直连', '拒绝', ...NAMES])
  if (chance(0.1)) { s['节点组A'] = '节点组B'; s['节点组B'] = '节点组A' }
  if (chance(0.1)) { s['美国'] = '节点组A'; s['节点组A'] = 'direct' }
  return s
}
const ruleLists = () => {
  if (chance(0.45)) return undefined
  const o = {}
  for (const t of LIST_TAGS) if (chance(0.7)) o[t] = pick([{ domain: true, ip: true }, { domain: true, ip: false }, { domain: false, ip: true }, { domain: false, ip: false }, null, true, {}])
  return o
}
const clientRoutes = (b) => {
  if (chance(0.5)) return pick([undefined, []])
  return Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => ({
    id: 'c' + i, name: 'n' + i, sources: some(['192.168.1.5/32', '192.168.1.0/24', '10.0.0.7/32'], 2).concat(['192.168.9.9/32']),
    outbound: pick([b ? b.direct : 'direct', b ? b.block : 'block', '美国', '节点组A', '节点组B', '不存在的出口']),
  }))
}

// ---- 档案(profile)里和 DNS 有关的部分 ----
const PROXIES = ['1.1.1.1', '8.8.8.8', 'tcp://1.1.1.1', 'https://dns.google/dns-query', 'tls://[2001:4860:4860::8888]:853', '8.8.4.4:53', 'DNS.Google', undefined, null, '', 5]
const rewrite = () => (chance(0.65) ? undefined : {
  enabled: chance(0.85), initialized: chance(0.6),
  rules: Array.from({ length: Math.floor(rnd() * 4) }, () => (chance(0.5)
    ? { source: pick(['a.example.com', '*.x.com', 'B.Example.COM']), domain: pick(['t.example.com', 'z.org']), enabled: chance(0.85) }
    : { source: pick(['c.example.com', '*.y.net']), addresses: pick([['1.2.3.4'], ['::1', '10.0.0.1']]), enabled: chance(0.85) })),
})
const profile = () => ({
  dns: {
    mode: pick(['hijack', 'hijack', 'hijack', 'dnsmasq', 'off']),
    split: chance(0.88), proxy: pick(PROXIES), direct: pick([undefined, undefined, '223.5.5.5', '119.29.29.29', '']),
    fakeIpForProxy: chance(0.4), rewrite: rewrite(),
  },
  ipv6: chance(0.55), ipv6Proxy: pick(['node', 'ipv4', 'bypass', undefined, 'x']),
  routing: routing(),
})

const cases = []
const add = (args) => {
  const [p, o] = args
  const input = rt([p, o])
  const [p2, o2] = input
  const opts = { ...o2 }
  if (Array.isArray(opts.knownOutbounds)) opts.knownOutbounds = new Set(opts.knownOutbounds)
  try {
    cases.push({ fn: 'buildDns', args: input, want: rt(dnsMod.buildDnsWithResolvers(p2, opts)) })
  } catch (e) { cases.push({ fn: 'buildDns', args: input, error: e.constructor.name }) }
}
for (let i = 0; i < 900; i++) {
  const b = builtin()
  const p = profile()
  if (i % 60 === 7) p.dns = pick([null, undefined])
  const dh = chance(0.5) ? { domains: some(['dh1.com', 'dh2.net', 'node.example.org'], 3), cidrs: [] } : pick([null, undefined])
  const known = chance(0.4) ? undefined : [...new Set(['direct', 'block', '直连', '拒绝', ...some(['美国', '香港', '节点组A', '节点组B', '节点1', '节点2'], 5)])]
  const opts = {
    systemDns: pick([undefined, undefined, [], ['223.5.5.5'], [null, '8.8.8.8'], ['', 0], [5], 'x']),
    groupTags: groupTags(b), builtin: b, selections: selections(), directHosts: dh, ruleLists: ruleLists(),
    clientRoutes: clientRoutes(b), knownOutbounds: known,
    filterRules: chance(0.2) ? [{ rule_set: ['f-block'], action: 'predefined', rcode: 'NXDOMAIN' }] : undefined,
  }
  add([p, opts])
}

// ---- extractHost(dns.mjs 里没导出,这里原样抄一份) ----
const extractHost = (url) => {
  try {
    if (/^[a-z]+:\/\//i.test(url)) return new URL(url).hostname
  } catch { /* fall through */ }
  return url
}
const schemes = ['http', 'https', 'tcp', 'tls', 'udp', 'quic', 'HTTPS', 'Tcp', 'ws', 'wss', 'ftp', 'file', 'h3', 'sdns']
const hosts = ['1.1.1.1', '8.8.8.8', 'dns.google', 'DNS.Google', 'Example.COM', '[::1]', '[2001:DB8:0:0:0:0:0:1]', '[2001:db8::1]', '[::ffff:1.2.3.4]', '[fe80::1%eth0]',
  '[1:0:0:2:0:0:0:3]', '[::]', '[1::]', '[0:0:1:0:0:1:0:0]', '中文.com', '例え.jp', 'münchen.de', 'xn--fiq228c.com', '0x7f.1', '127.1', '1.2.3', '1.2.3.4.5', '256.1.1.1', '0300.0250.0.1',
  '4294967295', '4294967296', '1.2.3.4.', 'a b', 'a%20b', 'ex%41mple.com', '%31.%31.%31.%31', '', 'a_b.com', 'a..b', '.', 'host.', '1.2.3.4a', '0x', '0xg', 'a.0x1', 'a.1', 'a.01',
  'ex<ample', 'a|b', 'a^b', 'a%b', 'localhost', 'ＡＢＣ.com', 'a\u00a0b', 'é.com', '😀.com', 'İ.com']
const ports = ['', '', '', ':53', ':853', ':443', ':0', ':65535', ':65536', ':99999', ':abc', ':', ':080', ':-1', ':00000000053']
const users = ['', '', '', 'u@', 'u:p@', '@', 'a@b@']
const tails = ['', '', '/dns-query', '/', '?x=1', '#f', '\\x', '/a b', '/%zz']
const seen = new Set()
for (let i = 0; i < 1500; i++) {
  let s = pick(schemes) + '://' + pick(users) + pick(hosts) + pick(ports) + pick(tails)
  if (chance(0.05)) s = s.replace('://', pick([':///', ':\\\\', ':/\\', '://\t']))
  if (chance(0.04)) s += pick([' ', '\t', '\n'])
  if (s.startsWith('file') ) continue // file: 的 Windows 盘符特例(file://B|\)不支持,对 DNS 上游地址没有意义
  if (seen.has(s)) continue
  seen.add(s)
  cases.push({ fn: 'extractHost', args: [s], want: extractHost(s) })
}
for (const s of ['tcp://', 'http://', 'https:///dns', 'https://:53', 'tcp://:53', 'tcp://u@', 'tcp://u@/x', 'x://y', 'plain', '1.1.1.1', 'tcp:/x', 'http:////h', 'http:\\\\h']) {
  cases.push({ fn: 'extractHost', args: [s], want: extractHost(s) })
}

writeFileSync(out, JSON.stringify({ generatedBy: 'gen-dns-golden.mjs', cases }) + '\n')
const dnsCases = cases.filter((c) => c.fn === 'buildDns')
const cnt = (f) => dnsCases.filter((c) => c.want && f(c.want.dns, c.want.resolvers)).length
console.log('写入', cases.length, '条 →', out)
console.log('buildDns:', dnsCases.length, '条,其中抛错', dnsCases.filter((c) => c.error).length)
console.log(' 未分流(split=false):', cnt((d) => !d.servers.some((s) => s.tag === 'dns-proxy')))
console.log(' 含 fakeip:', cnt((d) => d.servers.some((s) => s.type === 'fakeip')))
console.log(' 含 dns-custom-*:', cnt((d) => d.servers.some((s) => /^dns-custom-/.test(s.tag))))
console.log(' 含 dns-client-*:', cnt((d) => d.servers.some((s) => /^dns-client-/.test(s.tag))))
console.log(' 含 dns-policy-*:', cnt((d) => d.servers.some((s) => /^dns-policy-/.test(s.tag))))
console.log(' 含 AAAA 预定义空答案:', cnt((d) => (d.rules || []).some((r) => r.rcode === 'NOERROR')))
console.log(' 含规则集拆分(同一 server 相邻两条):', cnt((d) => (d.rules || []).some((r, i) => i && r.rule_set && d.rules[i - 1].rule_set === undefined && d.rules[i - 1].server === r.server)))
console.log(' 含 list-* 规则集:', cnt((d) => JSON.stringify(d.rules || []).includes('list-')))
console.log(' 含 dns-rewrite:', cnt((d) => d.servers.some((s) => s.tag === 'dns-rewrite')))
console.log(' final=dns-direct/dns-proxy:', cnt((d) => d.final === 'dns-direct'), cnt((d) => d.final === 'dns-proxy'))
