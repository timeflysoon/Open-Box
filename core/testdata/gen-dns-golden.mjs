// 生成 DNS 配置(上游 engine/dns.mjs 的 buildDnsWithResolvers)的金标准,以及 dns-upstream / flip 纯函数、extractHost 的对照用例。
// 用法: node core/testdata/gen-dns-golden.mjs <engine 目录> [输出文件]
//   engine 目录取自 catch-up-upstream 的 0c9d530(v0.1.318 快照,同步提交里 panel/server/ 已被换掉,要从历史里取):
//     git archive 0c9d530 panel/server/engine | tar -x -C <临时目录>
//   且上层(panel/server/)要有 {"type":"module"} 的 package.json。
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./dns_golden.json', import.meta.url).pathname)
const imp = (f) => import(pathToFileURL(resolve(dir, f)).href)
const [dnsMod, rl, crMod, upMod, flipMod, rm] = await Promise.all([imp('dns.mjs'), imp('rule-list.mjs'), imp('client-routes.mjs'), imp('dns-upstream.mjs'), imp('flip.mjs'), imp('routing-model.mjs')])

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
// 终端分流:造原始规则(含 mac / bypass / admit / 停用 / 缺出口),再走真实的 normalizeClientRoutes,
// 保证喂给 buildDns 的形状和生产里一样(Node 先整理再传进来)
const clientRoutes = (b) => {
  if (chance(0.45)) return pick([undefined, []])
  const raw = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) => {
    const kind = pick(['ip', 'ip', 'ip', 'mac', 'bypass-ip', 'bypass-mac', 'admit'])
    const r = {
      id: 'c' + i, name: 'n' + i, enabled: chance(0.93),
      outbound: pick([b ? b.direct : 'direct', b ? b.block : 'block', '美国', '节点组A', '节点组B', '不存在的出口', '', undefined]),
    }
    if (kind === 'mac' || kind === 'bypass-mac') { r.match = 'mac'; r.macs = some(['AA:BB:CC:00:11:22', 'aa-bb-cc-00-11-33', 'bad-mac', '00:11:22:33:44:55'], 2) }
    else r.sources = some(['192.168.1.5', '192.168.1.0/24', '10.0.0.7/32', 'fe80::1%eth0', '2001:db8::/32', 'bad'], 3)
    if (kind.startsWith('bypass')) r.bypass = true
    if (kind === 'admit') r.admit = true
    if (chance(0.1)) delete r.match
    return r
  })
  return crMod.normalizeClientRoutes(raw, { directTag: chance(0.9) ? (b ? b.direct : 'direct') : '' })
}

// ---- 档案(profile)里和 DNS 有关的部分 ----
const PROXIES = ['1.1.1.1', '8.8.8.8', '1.1.1.1', 'tcp://1.1.1.1', 'https://1.1.1.1/dns-query', 'https://dns.google/dns-query', 'tls://[2001:4860:4860::8888]:853',
  '[2001:4860:4860::8888]', '2001:4860:4860::8888', '8.8.4.4:53', 'DNS.Google', ' 8.8.8.8 ', '[ 1.1.1.1 ]', '0.0.0.0', '::', '1:2:3:4:5:6:7:8:9', 'wan', 'wan', undefined, null, '', 5]
const DIRECTS = [undefined, 'wan', 'wan', 'wan', '223.5.5.5', '119.29.29.29', '', 'https://223.5.5.5/dns-query', '[2400:3200::1]', '2400:3200::1', 'example.com', ' 1.1.1.1 ', '0.0.0.0', 5, null]
const PROTOCOLS = [undefined, undefined, 'udp', 'tcp', 'tls', 'https', '', 5]
const PORTS = [undefined, undefined, undefined, 53, 853, 5353, 0, 65536, 53.5, '53', null, 65535, 1]
const extraItem = () => pick([
  { server: 'wan' }, { server: 'wan', protocol: 'tcp', port: 5353 }, { server: '8.8.8.8', protocol: 'udp', port: 5353 }, { server: '1.0.0.1' }, { server: '1.1.1.1' },
  { server: '223.5.5.5' }, { server: 'dns.google' }, { server: '2606:4700:4700::1111', protocol: 'tcp' }, { server: 'https://9.9.9.9/dns-query' },
  { server: '' }, { server: 5 }, {}, null, 0, 'str', [],
])
const extras = () => (chance(0.5) ? undefined : pick([[], [], Array.from({ length: Math.floor(rnd() * 6) }, extraItem)]))
const rewrite = () => (chance(0.65) ? undefined : {
  enabled: chance(0.85), initialized: chance(0.6),
  rules: Array.from({ length: Math.floor(rnd() * 4) }, () => (chance(0.5)
    ? { source: pick(['a.example.com', '*.x.com', 'B.Example.COM']), domain: pick(['t.example.com', 'z.org']), enabled: chance(0.85) }
    : { source: pick(['c.example.com', '*.y.net']), addresses: pick([['1.2.3.4'], ['::1', '10.0.0.1']]), enabled: chance(0.85) })),
})
const profile = () => ({
  dns: {
    mode: pick(['hijack', 'hijack', 'hijack', 'dnsmasq', 'dnsmasq', 'off']),
    split: chance(0.9), proxy: pick(PROXIES), proxyProtocol: pick(PROTOCOLS), proxyPort: pick(PORTS), proxyExtras: extras(),
    direct: pick(DIRECTS), directProtocol: pick(PROTOCOLS), directPort: pick(PORTS), directExtras: extras(),
    region: pick([undefined, 'cn', 'intl', 'x']),
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
for (let i = 0; i < 1000; i++) {
  const b = builtin()
  const p = profile()
  if (i % 80 === 7) p.dns = pick([null, undefined])
  const dh = chance(0.5) ? { domains: some(['dh1.com', 'dh2.net', 'node.example.org'], 3), cidrs: [] } : pick([null, undefined])
  const known = chance(0.4) ? undefined : [...new Set(['direct', 'block', '直连', '拒绝', ...some(['美国', '香港', '节点组A', '节点组B', '节点1', '节点2'], 5)])]
  const opts = {
    systemDns: pick([undefined, undefined, [], ['223.5.5.5'], ['192.168.1.1', '192.168.1.2'], [null, '8.8.8.8'], ['', 0], [5], 'x', ['2400:3200::1']]),
    groupTags: groupTags(b), builtin: b, selections: selections(), directHosts: dh, ruleLists: ruleLists(),
    directHostSets: chance(0.4) ? { domain: 'ob-direct-domain', ip: 'ob-direct-ip' } : undefined,
    clientRoutes: clientRoutes(b), knownOutbounds: known,
    filterRules: chance(0.2) ? [{ rule_set: ['f-block'], action: 'predefined', rcode: 'NXDOMAIN' }] : undefined,
    terminalDns: chance(0.3) ? undefined : { autoRedirect: chance(0.65), directBypass: pick([true, false, undefined]), admitDirect: pick(['', '', 'dns-in-direct']) },
  }
  add([p, opts])
}

// ---- dns-upstream 纯函数的对照用例 ----
const UP_VALUES = ['1.1.1.1', ' 1.1.1.1 ', '0.0.0.0', '255.255.255.255', '256.1.1.1', '01.1.1.1', '1.1.1', '::', '::1', '2001:db8::1', '2001:DB8::1', '1::2::3', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', ':::',
  '[::1]', '[2001:db8::1]', '[ 1.1.1.1 ]', '[1.1.1.1]', '1.1.1.1]', '[1.1.1.1', '[]', '[', ']', 'wan', 'example.com', 'fe80::1%eth0', 'g::1', '', '   ', '\t1.1.1.1\n',
  'https://1.1.1.1/dns-query', 'tcp://1.1.1.1:53', 'tls://[2001:4860:4860::8888]:853', 'udp://8.8.8.8', 'HTTPS://8.8.4.4', 'https://dns.google/dns-query', 'https://[::1]/x', 'h2+x://1.1.1.1', 'a1b://1.1.1.1', 'a.b-c://9.9.9.9',
  'https://0x7f.1/', 'https://127.1', 'https://1.1.1.1.', 'https://u:p@1.1.1.1', 'https://', 'tcp://', '://1.1.1.1', '1x://1.1.1.1', 'ſ://1.1.1.1', 'K://1.1.1.1', '1.1.1.1:53', '1.1.1.1/dns-query',
  null, undefined, 5, true, {}, [], ['1.1.1.1']]
for (const v of UP_VALUES) {
  cases.push({ fn: 'normalizeDnsUpstream', args: v === undefined ? [] : [v], want: upMod.normalizeDnsUpstream(v) })
  cases.push({ fn: 'isValidDnsUpstream', args: v === undefined ? [] : [v], want: upMod.isValidDnsUpstream(v) })
}

// ---- flip 纯函数的对照用例:用 normalizeRouting 的结果 ----
for (let i = 0; i < 120; i++) {
  const r = routing()
  const conf = rm.normalizeRouting(r)
  const names = [...conf.activePolicies.map((x) => x.name), conf.fallback.name]
  const classes = {}
  for (const n of [...names, '不在 conf 里的']) if (chance(0.8)) classes[n] = pick(['direct', 'proxy', 'block', '美国'])
  cases.push({
    fn: 'flip', args: [rt(r), classes],
    want: {
      flagMap: [...flipMod.flipFlagMap(conf)],
      flagStates: flipMod.flipFlagStates(conf, classes),
      bypassCandidates: flipMod.flipBypassCandidates(conf),
      flagTags: conf.activePolicies.map((x) => flipMod.flipFlagTag(x)),
    },
  })
}
// flipFlagTag 的边界:id 优先、没有 id 退到名字、都没有退到空串(normalizeRouting 总会补 id,经 buildDns 走不到这几条)
for (const pol of [{ id: 'policy-0', name: 'A' }, { id: '', name: 'abc' }, { name: '中文名' }, { id: 'x' }, {}, { id: 'a', name: 'b' }, { id: '😀', name: '' }]) {
  cases.push({ fn: 'flipFlagTag', args: [pol], want: flipMod.flipFlagTag(pol) })
}

// 终端分流的 DNS 判定:所有组合穷举(经 buildDns 时劫持模式短路、dnsmasq 之外的模式根本不问,单独对照)
{
  const routes = [
    { id: 'b', name: 'b', match: 'ip', outbound: 'direct', bypass: true, sources: ['10.0.0.1/32'] },
    { id: 'bm', name: 'bm', match: 'mac', outbound: 'direct', bypass: true, sources: [], macs: ['aa:bb:cc:00:11:22'] },
    { id: 'd', name: 'd', match: 'ip', outbound: 'direct', sources: ['10.0.0.2/32'] },
    { id: 'x', name: 'x', match: 'ip', outbound: 'block', sources: ['10.0.0.3/32'] },
    { id: 'p', name: 'p', match: 'ip', outbound: '美国', sources: ['10.0.0.4/32'] },
    { id: 'pm', name: 'pm', match: 'mac', outbound: '美国', sources: [], macs: ['aa:bb:cc:00:11:33'] },
    { id: 'e', name: 'e', match: 'ip', outbound: '直连', sources: ['10.0.0.5/32'] },
    { id: 'n', name: 'n', match: 'mac', outbound: 'direct', sources: [], macs: [] },
    { id: 'n2', name: 'n2', match: 'ip', outbound: 'direct', sources: [] },
  ]
  for (const cr of routes) {
    cases.push({ fn: 'clientSourceMatch', args: [cr], want: crMod.clientSourceMatch(cr) ?? null })
    for (const dnsMode of ['hijack', 'dnsmasq', 'off', 'x'])
      for (const autoRedirect of [true, false])
        for (const directBypass of [true, false, undefined])
          for (const splitDns of [true, false])
            for (const [directTag, blockTag] of [['direct', 'block'], ['直连', '拒绝'], ['', '']]) {
              const o = { dnsMode, autoRedirect, directBypass, splitDns, directTag, blockTag }
              cases.push({ fn: 'terminalDnsRedirected', args: [cr, o], want: crMod.terminalDnsRedirected(cr, o) })
            }
  }
}

cases.push({ fn: 'flipConsts', args: [], want: {
  fallback: flipMod.FLIP_FALLBACK_TAG, bypassTag: flipMod.flipBypassTag('geoip-cn'), needTag: flipMod.flipNeedTag('geoip-cn'), needFixed: flipMod.FLIP_NEED_FIXED,
  on: flipMod.FLIP_FLAG_ON, off: flipMod.FLIP_FLAG_OFF, content: [flipMod.flipFlagContent(true), flipMod.flipFlagContent(false)], placeholderSource: flipMod.flipPlaceholderSource(),
  placeholderSrs: flipMod.FLIP_PLACEHOLDER_SRS_BASE64, placeholder: flipMod.FLIP_BYPASS_PLACEHOLDER,
  fakeIpCachePath: dnsMod.fakeIpCachePath('/var/lib/openbox/cache.db'), v4: dnsMod.FAKEIP_V4, v6: dnsMod.FAKEIP_V6,
} })

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
console.log(' 含 AAAA 预定义空答案:', cnt((d) => (d.rules || []).some((r) => r.rcode === 'NOERROR' && JSON.stringify(r).includes('AAAA'))))
console.log(' 含 HTTPS 空应答规则:', cnt((d) => (d.rules || []).some((r) => Array.isArray(r.query_type) && r.query_type[0] === 'HTTPS')))
console.log(' 含竞速(race):', cnt((d) => (d.rules || []).some((r) => r.race === true)))
console.log(' 含直连备用上游(dns-direct__alt):', cnt((d) => d.servers.some((s) => /^dns-direct__alt/.test(s.tag))))
console.log(' 含代理备用上游(dns-proxy__alt):', cnt((d) => d.servers.some((s) => /^dns-proxy__alt/.test(s.tag))))
console.log(' 含 dns-terminal-direct:', cnt((d) => d.servers.some((s) => s.tag === 'dns-terminal-direct')))
console.log(' 含 dns-local:', cnt((d) => d.servers.some((s) => s.tag === 'dns-local')))
console.log(' 含热切换开关(obflip-):', cnt((d) => JSON.stringify(d.rules || []).includes('obflip-')))
console.log(' 含 list-* 规则集:', cnt((d) => JSON.stringify(d.rules || []).includes('list-')))
console.log(' 含 dns-rewrite:', cnt((d) => d.servers.some((s) => s.tag === 'dns-rewrite')))
console.log(' 含 server_port:', cnt((d) => d.servers.some((s) => s.server_port !== undefined)))
console.log(' 有 ruleOwners:', dnsCases.filter((c) => c.want && c.want.ruleOwners.length).length, ',kinds:', [...new Set(dnsCases.flatMap((c) => (c.want ? c.want.ruleOwners.map((o) => o.kind) : [])))].join('/'))
