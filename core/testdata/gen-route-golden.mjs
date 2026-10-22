// 生成路由配置(上游 engine/routing.mjs 的 buildRoute、preMatchBypassRules)的金标准。
// 用法: node core/testdata/gen-route-golden.mjs <engine 目录> [输出文件]
//   engine 目录取自 catch-up-upstream 的 0c9d530(v0.1.318 快照,同步提交里 panel/server/ 已被换掉,要从历史里取):
//     git archive 0c9d530 panel/server/engine | tar -x -C <临时目录>
//   且上层(panel/server/)要有 {"type":"module"} 的 package.json。
// 说明:buildRoute 的 rejectV6For / rejectQuicFor 是回调,这里用 rejectV6Tags / rejectV6All、rejectQuicTags / rejectQuicAll 两组可序列化的写法代替。
// 终端分流先过真实的 normalizeClientRoutes,和生产里 Node 整理完再传进来的形状一致。
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./route_golden.json', import.meta.url).pathname)
const imp = (f) => import(pathToFileURL(resolve(dir, f)).href)
const [routeMod, rl, crMod, rm] = await Promise.all([imp('routing.mjs'), imp('rule-list.mjs'), imp('client-routes.mjs'), imp('routing-model.mjs')])

let seed = 8128
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
    geosite: () => 'netflix', geoip: () => 'us', ruleUrl: () => pick(URLS), ruleset: () => pick(['geosite-foo', ...LIST_TAGS]), port: () => pick(['51820', '1000-2000', '80,443', '1000-2000 53', '51820, 3000-3100, 8080', '0', '70000', '9-3', 'abc', '80-']),
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


// 终端分流:造原始规则(含 mac / bypass / admit / 停用 / 缺出口),再走真实的 normalizeClientRoutes
const normClients = (b, dTag) => {
  if (chance(0.45)) return pick([undefined, []])
  const raw = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) => {
    const kind = pick(['ip', 'ip', 'ip', 'mac', 'bypass-ip', 'bypass-mac', 'admit'])
    const r = {
      id: 'c' + i, name: 'n' + i, enabled: chance(0.93),
      outbound: pick([dTag, b, '美国', '节点组A', '节点组B', '不存在的出口', '香港', '', undefined]),
    }
    if (kind === 'mac' || kind === 'bypass-mac') { r.match = 'mac'; r.macs = some(['AA:BB:CC:00:11:22', 'aa-bb-cc-00-11-33', 'bad-mac', '00:11:22:33:44:55'], 2) }
    else r.sources = some(['192.168.1.5', '192.168.1.0/24', '10.0.0.7/32', 'fe80::1%eth0', '2001:db8::/32', 'bad'], 3)
    if (kind.startsWith('bypass')) r.bypass = true
    if (kind === 'admit') r.admit = true
    if (chance(0.1)) delete r.match
    return r
  })
  return crMod.normalizeClientRoutes(raw, { directTag: chance(0.9) ? dTag : '' })
}

const cases = []
const SOME_OUT = ['美国', '香港', '节点组A', '节点组B', '节点1', '节点2', '不存在的出口']
for (let i = 0; i < 1000; i++) {
  const directTag = pick(['direct', '直连', undefined, ''])
  const blockTag = pick(['block', '拒绝', undefined])
  const dTag = directTag || 'direct'
  const bTag = blockTag || 'block'
  const r = rt(routing())
  const known = chance(0.4) ? undefined : [...new Set([dTag, bTag, ...some(SOME_OUT, 6)])]
  const cr = normClients(bTag, dTag)
  const allOut = [dTag, bTag, '美国', '香港', '节点组A', '其他', '兜底', ...NAMES]
  const o = rt({
    dnsMode: pick(['hijack', 'hijack', 'dnsmasq', 'off', undefined]),
    directTag, blockTag,
    directHosts: pick([undefined, null, { domains: [], cidrs: [] }, { domains: some(['dh1.com', 'n.example.org'], 2).concat(['x.io']), cidrs: [] }, { domains: [], cidrs: ['1.2.3.4/32'] }, { domains: ['a.b'], cidrs: ['5.6.7.8/32', '9.9.9.9/32'] }]),
    directHostSets: chance(0.35) ? { domain: 'obdirect-domain', ip: 'obdirect-ip' } : undefined,
    rejectV6Tags: chance(0.3) ? some(allOut, 5) : undefined, rejectV6All: chance(0.08) ? true : undefined,
    rejectQuicTags: chance(0.3) ? some(allOut, 5) : undefined, rejectQuicAll: chance(0.08) ? true : undefined,
    tunCidrs: pick([undefined, [], ['172.19.0.0/30'], ['172.19.0.0/30', 'fdfe:dcba:9876::/126']]),
    dnsmasqTag: pick(['', 'dnsmasq', undefined, 'dnsmasq']),
    dnsDirectInbound: pick([undefined, undefined, 'dns-in-direct']),
    preMatchBypass: chance(0.5) ? true : pick([undefined, false]),
    clientRoutes: cr, knownOutbounds: known, ruleLists: ruleLists(),
  })
  const dir2 = pick(['/opt/open-box/data/rulesets', '/r'])
  const opts = { ...o }
  delete opts.rejectV6Tags; delete opts.rejectV6All; delete opts.rejectQuicTags; delete opts.rejectQuicAll
  if (Array.isArray(opts.knownOutbounds)) opts.knownOutbounds = new Set(opts.knownOutbounds)
  if (o.rejectV6All) opts.rejectV6For = () => true
  else if (o.rejectV6Tags) opts.rejectV6For = (t) => o.rejectV6Tags.includes(t)
  if (o.rejectQuicAll) opts.rejectQuicFor = () => true
  else if (o.rejectQuicTags) opts.rejectQuicFor = (t) => o.rejectQuicTags.includes(t)
  const { route, rulesetTags } = routeMod.buildRoute(r, dir2, opts)
  cases.push({ fn: 'buildRoute', args: [r, dir2, o], want: rt({ route, rulesetTags: [...rulesetTags] }) })
}

// preMatchBypassRules 单独对照(buildRoute 只在 preMatchBypass 开着时才走到它)
for (let i = 0; i < 400; i++) {
  const directTag = pick(['direct', '直连', undefined])
  const dTag = directTag || 'direct'
  const bTag = pick(['block', '拒绝'])
  const r = rt(routing())
  const known = chance(0.4) ? undefined : [...new Set([dTag, bTag, ...some(SOME_OUT, 6)])]
  const o = rt({
    clientRoutes: normClients(bTag, dTag),
    directHosts: pick([undefined, null, { domains: [], cidrs: [] }, { domains: ['a.b'], cidrs: ['5.6.7.8/32', '9.9.9.9/32'] }]),
    directHostSet: pick(['', '', 'obdirect-ip', undefined]),
    directTag, blockTag: bTag, ruleLists: ruleLists(), knownOutbounds: known,
    tunCidrs: pick([undefined, [], ['172.19.0.0/30'], ['172.19.0.0/30', 'fdfe:dcba:9876::/126']]),
  })
  const opts = { ...o }
  if (Array.isArray(opts.knownOutbounds)) opts.knownOutbounds = new Set(opts.knownOutbounds)
  const conf = rm.normalizeRouting(r)
  cases.push({ fn: 'preMatchBypassRules', args: [r, o], want: rt(routeMod.preMatchBypassRules(conf, opts)) })
}
writeFileSync(out, JSON.stringify({ generatedBy: 'gen-route-golden.mjs', cases }) + '\n')
const cnt = (f) => cases.filter((c) => c.fn === 'buildRoute' && f(c.want.route, c.want.rulesetTags)).length
const hasRule = (d, f) => d.rules.some(f)
console.log('写入', cases.length, '条 →', out)
console.log(' dnsmasq 回送规则:', cnt((d) => hasRule(d, (r) => r.override_address)))
console.log(' hijack / inbound-hijack:', cnt((d) => hasRule(d, (r) => r.protocol === 'dns')), cnt((d) => hasRule(d, (r) => r.inbound)))
console.log(' tun 防回环:', cnt((d) => hasRule(d, (r) => r.action === 'reject' && r.ip_cidr)))
console.log(' 无域名前提(IP 只管 IP):', cnt((d) => hasRule(d, (r) => JSON.stringify(r).includes('domain_regex'))))
console.log(' 热切换开关:', cnt((d) => hasRule(d, (r) => JSON.stringify(r).includes('obflip-'))))
console.log(' QUIC 拒绝:', cnt((d) => hasRule(d, (r) => JSON.stringify(r).includes('"port":443'))))
console.log(' 首包预判 bypass:', cnt((d) => hasRule(d, (r) => r.action === 'bypass')))
console.log(' 前置自定义端口行:', cnt((d) => hasRule(d, (r) => r.port && !r.override_address && !r.network)))
console.log(' 直连站点:', cnt((d) => hasRule(d, (r) => r.outbound && r.domain && r.outbound === (r.outbound) && !r.rule_set && !r.ip_is_private)))
console.log(' 终端分流:', cnt((d) => hasRule(d, (r) => r.source_ip_cidr)))
console.log(' v6 拒绝:', cnt((d) => hasRule(d, (r) => r.ip_version === 6)))
console.log(' 规则集拆分:', cnt((d) => d.rules.some((r, i) => i && r.rule_set && d.rules[i - 1].outbound === r.outbound && !d.rules[i - 1].rule_set && r.outbound)))
console.log(' 有规则集标签:', cnt((d, t) => t.length > 0), ' 含 -ip 的:', cnt((d, t) => t.some((x) => x.endsWith('-ip'))))
console.log(' 广告拦截:', cnt((d) => hasRule(d, (r) => r.action === 'reject' && typeof r.rule_set === 'string')))
