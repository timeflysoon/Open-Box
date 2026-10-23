// 生成 configDetailed(上游 engine/config.mjs 的 buildConfigDetailed)的金标准。
// 用法: node core/testdata/gen-config-golden.mjs <engine 基线目录> [输出文件]
//   基线目录取法见 core/README.md;上层 panel/server/ 要有 {"type":"module"} 的 package.json,
//   且要带上 system/panel-port.mjs(servers.mjs 引了它)。
// 输入形状 = 新版 Node 发给核心的那一份({platform, chainNodes, filterExpectedKey, profile.clashApiSecret 等}),
// 期望输出 = 基线 buildConfigDetailed 的 {config, dnsRuleOwners, directHosts, failover}。
// chainNodes 由基线的 chain-proxy.mjs 的 chainNodes(profile) 算出(Node 里做,不进核心),基线自己在 buildConfigDetailed 里核对。
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./config_golden.json', import.meta.url).pathname)
const imp = (f) => import(pathToFileURL(resolve(dir, f)).href)
const [cfg, cr, chainMod, ug, df] = await Promise.all([imp('config.mjs'), imp('client-routes.mjs'), imp('chain-proxy.mjs'), imp('user-groups.mjs'), imp('dns-filter.mjs')])

let seed = 20261023
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(rnd() * n)
const pick = (a) => a[int(a.length)]
const chance = (p) => rnd() < p
const some = (a, max) => Array.from({ length: int(max + 1) }, () => pick(a))
const rt = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

// ---- 节点(已经过订阅解析:tag / type / server / server_port / 各协议字段 / subscriptionId)----
const NODE_BASE = ['香港-01', '香港-02', '美国-01', '美国-02', '日本-01', 'US-03', 'cn2线路', 'HK01', 'Singapore', 'jp_05']
const HOSTS = ['hk1.example.com', 'us1.example.com', '1.2.3.4', '203.0.113.9', '2001:db8::5', 'jp.例え.jp', 'sg.example.net']
const SUBS = ['sub-a', 'sub-b', 'sub-c']
const node = (tag, i) => {
  const type = pick(['shadowsocks', 'vless', 'trojan', 'hysteria2', 'vmess', 'tuic', 'socks', 'wireguard'])
  const n = { tag, type, server: pick(HOSTS), server_port: pick([443, 8443, 10086, 2096]), subscriptionId: chance(0.8) ? pick(SUBS) : undefined, fields: {} }
  switch (type) {
    case 'shadowsocks': n.fields = { method: 'aes-256-gcm', password: 'pw' + i }; break
    case 'vless': n.fields = { uuid: 'u-' + i, flow: pick(['', 'xtls-rprx-vision']), tls: { enabled: true, server_name: 'a.com', reality: chance(0.4) ? { enabled: true, public_key: 'pk', short_id: 'ab12' } : undefined, utls: { enabled: true, fingerprint: 'chrome' } }, transport: chance(0.4) ? { type: 'ws', path: '/ws', host: 'a.com' } : undefined }; break
    case 'trojan': n.fields = { password: 'pw', tls: { enabled: true, server_name: 'a.com' } }; break
    case 'hysteria2': n.fields = { password: 'pw', tls: { enabled: true, server_name: 'a.com' }, server_ports: chance(0.3) ? '20000-40000' : undefined }; break
    case 'vmess': n.fields = { uuid: 'u-' + i, security: 'auto', tls: { enabled: chance(0.5), server_name: 'a.com' } }; break
    case 'tuic': n.fields = { uuid: 'u-' + i, password: 'pw', tls: { enabled: true, server_name: 'a.com' } }; break
    case 'socks': n.fields = { version: 5, username: 'u', password: 'p' }; break
    case 'wireguard': n.fields = { peer_public_key: 'pub', private_key: 'priv', local_address: ['172.16.0.2'] }; break
  }
  return n
}
const nodes = () => {
  const tags = [...new Set([...NODE_BASE.slice(0, 2), ...some(NODE_BASE, 8)])]
  return tags.map(node)
}

// ---- 节点组 ----
const GROUP_NAMES = ['节点组A', '节点组B', '香港-自动', '美国', 'G1']
const group = (i) => {
  const type = pick(['selector', 'selector', 'urltest', 'urltest', 'failover'])
  const g = { id: 'g' + i, name: pick(GROUP_NAMES) + (chance(0.7) ? String(i) : ''), type, enabled: chance(0.95) }
  if (type === 'failover') g.lanes = [{ id: 'p', members: some(NODE_BASE, 3).concat(NODE_BASE[0]) }, { id: 'q', members: some(NODE_BASE, 3).concat(NODE_BASE[2]), manual: chance(0.3) }]
  else if (chance(0.4)) { g.mode = 'dynamic'; g.keywords = some(['香港', 'us', '日本', 'hk'], 2) }
  else g.members = some([...NODE_BASE, ...GROUP_NAMES, '直连', '拒绝'], 4)
  return g
}
const groups = () => {
  const list = Array.from({ length: int(5) }, (_, i) => group(i))
  if (chance(0.25)) list.push({ id: 'builtin-direct', name: pick(['直连', '直连X']), enabled: chance(0.8) })
  if (chance(0.25)) list.push({ id: 'builtin-block', name: pick(['拒绝', 'REJECT']), enabled: chance(0.8) })
  return list
}

// ---- 档案 ----
const DOMAINS = ['example.com', '*.sub.example.com', 'cdn.google.com', 'github.com', '中国.example', 'bad_x']
const SETS = ['geosite-cn', 'geoip-cn', 'geosite-google', 'geoip-us', 'geoip-private', 'geosite-netflix']
const policy = (i) => ({
  name: pick(['A', 'B', 'C', '代理集', '直连集']) + i, default: pick(['direct', 'direct', 'proxy', 'block', '美国', '香港-自动', '节点组A', '']), enabled: chance(0.93),
  rulesets: some(SETS, 3), domain: chance(0.4) ? some(DOMAINS, 2) : [], domainSuffix: chance(0.4) ? some(DOMAINS, 2) : [], ipCidr: chance(0.3) ? some(['10.0.0.0/8', '1.1.1.0/24', '10.77.0.0/16'], 2) : [],
})
const CUSTOM_OUT = ['direct', 'block', '美国', '节点组A', '节点组A', '香港-01', '香港-01', '不存在']
const customRule = () => {
  const type = pick(['domainSuffix', 'domain', 'ipCidr', 'ipCidr', 'ipCidr', 'ipCidr', 'geosite', 'geoip', 'port'])
  const value = { domainSuffix: 'x.com', domain: 'y.org', ipCidr: pick(['10.77.0.0/16', '10.0.0.0/7', '192.168.50.0/24', '1.2.3.0/24', '172.19.0.0/30', 'fe80::/10', 'fd00::/8']), geosite: 'netflix', geoip: 'us', port: '51820' }[type]
  return { type, value, outbound: pick(CUSTOM_OUT) }
}
const routing = () => ({
  policies: Array.from({ length: int(4) }, (_, i) => policy(i)),
  fallbackDefault: pick(['direct', 'proxy', '美国', '']), fallbackName: chance(0.2) ? '兜底' : undefined,
  custom: chance(0.5) ? { enabled: true, rules: Array.from({ length: 1 + int(4) }, customRule) } : undefined,
})
const rawClients = (dTag) => {
  if (chance(0.45)) return undefined
  return Array.from({ length: 1 + int(4) }, (_, i) => {
    const kind = pick(['ip', 'ip', 'mac', 'bypass-ip', 'bypass-mac', 'admit', 'admit-mac', 'admit-mac'])
    const r = { id: 'c' + i, name: 'n' + i, enabled: chance(0.93), outbound: pick([dTag, 'block', '美国', '节点组A', '不存在的出口']) }
    if (kind === 'mac' || kind === 'bypass-mac' || kind === 'admit-mac') { r.match = 'mac'; r.macs = some(['AA:BB:CC:00:11:22', '00:11:22:33:44:55'], 2) }
    else r.sources = some(['192.168.1.5', '192.168.1.0/24', '10.0.0.7/32', 'bad'], 3)
    if (kind.startsWith('bypass')) r.bypass = true
    if (kind === 'admit' || kind === 'admit-mac') r.admit = true
    return r
  })
}
const servers = () => (chance(0.6) ? undefined : Array.from({ length: 1 + int(3) }, (_, i) => ({
  id: 's' + i, enabled: chance(0.85), protocol: pick(['shadowsocks', 'vless', 'tuic', 'hysteria2', 'mixed']), port: 7000 + i, method: 'aes-256-gcm', password: 'pw', uuid: 'u1', tls: chance(0.5), obfs: 'o', username: 'u',
})))
const chainProxies = () => (chance(0.65) ? undefined : Array.from({ length: 1 + int(3) }, (_, i) => ({
  id: 'ch' + i, enabled: chance(0.9), name: pick(['住宅-' + i, '香港-01', '节点组A', 'res' + i]),
  link: pick(['socks5://u:p@203.0.113.7:1080', 'http://u:p@198.51.100.2:8080', 'ss://YWVzLTI1Ni1nY206cHc@192.0.2.3:8388#x', 'bad link']),
  upstream: pick([...NODE_BASE, ...GROUP_NAMES, '直连', '不存在', '住宅-0', 'res1']),
})))
const profile = (dTag) => {
  const dnsMode = pick(['hijack', 'hijack', 'hijack', 'dnsmasq', 'off'])
  return {
    dns: {
      mode: dnsMode, split: chance(0.8), proxy: pick(['1.1.1.1', 'https://1.1.1.1/dns-query', '8.8.8.8']), direct: pick([undefined, 'wan', '223.5.5.5']),
      fakeIpForProxy: chance(0.35), filter: chance(0.2) ? { enabled: true, lists: [{ id: 'anti-ad', name: 'x', url: 'https://x/y', enabled: true }], allowDomains: [] } : undefined,
    },
    ipv6: chance(0.55), ipv6Proxy: pick(['node', 'ipv4', 'bypass', undefined]),
    tun: chance(0.7) ? { autoRedirect: chance(0.7), stack: pick(['mixed', 'gvisor', undefined]), mtu: pick([undefined, 1400, 1500]) } : undefined,
    directBypass: pick([undefined, true, false]), directForNodes: pick([undefined, true, false]), rejectQuic: chance(0.3),
    testUrl: pick([undefined, 'https://t.example/204']), testExpectedStatus: pick([undefined, '204']),
    routing: routing(), clientRoutes: rawClients(dTag), servers: servers(), chainProxies: chainProxies(),
  }
}
const subscriptions = () => Array.from({ length: int(4) }, (_, i) => ({
  id: pick(SUBS), url: pick(['https://sub.example.com/p?x=1', 'https://1.2.3.4/s', 'http://例え.jp/z', '']), enabled: chance(0.9),
  nodeDns: chance(0.4) ? pick([{ url: 'https://dns.example.net/dns-query', bootstrap: '223.5.5.5' }, { url: 'https://1.2.3.4/dns-query' }]) : undefined,
}))
const artifactFor = (p) => {
  const key = df.filterKey(df.filterSettings(p))
  const tag = (n) => `dns-filter-${n}-0123456789abcdef`
  return { key: chance(0.9) ? key : '0'.repeat(16), sets: [{ type: 'local', tag: tag('a'), format: 'binary', path: '/x/a.srs' }], blocks: [{ tag: tag('a'), important: chance(0.5) }], allow: chance(0.5) ? [tag('b')] : [], allowImportant: [], userAllow: chance(0.3) ? [tag('c')] : [] }
}

const cases = []
const stats = { ok: 0, error: 0, autoRedirect: 0, chain: 0, failover: 0, dnsmasq: 0, filter: 0, servers: 0, holes: 0, wg: 0, fakeip: 0, nativeBypass: 0 }
for (let i = 0; i < 500; i++) {
  const directTag = '直连'
  const g = rt(groups())
  const dTag = ug.builtinTags(g).direct
  const p0 = rt(profile(dTag))
  p0.clashApiSecret = pick(['s3cret', '', undefined])
  // 链式代理的上游一半指向真实存在的节点组,并且一半把链式节点收进那个组的成员里(造出环)
  if (Array.isArray(p0.chainProxies)) {
    const gs = g.filter((x) => x.name && x.id && !x.id.startsWith('builtin-'))
    for (const cp of p0.chainProxies) {
      if (!gs.length || chance(0.4)) continue
      const target = pick(gs)
      cp.upstream = target.name
      if (chance(0.5) && Array.isArray(target.members)) target.members.push(cp.name)
      else if (chance(0.3) && gs.length > 1) { const other = pick(gs); if (Array.isArray(other.members)) other.members.push(cp.name) }
    }
  }
  const input = {
    platform: pick(['openwrt', 'systemd', 'container', undefined]),
    cacheFilePath: pick([undefined, '/opt/open-box/data/cache.db', '/tmp/c.db']),
    rulesetDir: pick([undefined, '/opt/open-box/data/rulesets', '/data/rs/']),
    selections: chance(0.5) ? undefined : Object.fromEntries(['A0', 'B1', '代理集0', '其他', '兜底', '节点组A'].filter(() => chance(0.4)).map((n) => [n, pick(['direct', 'block', '美国', '节点组A', '直连', '香港-01'])])),
    tlsCert: chance(0.5) ? undefined : { certPath: '/c.pem', keyPath: '/k.pem' },
    nodes: nodes(), userGroups: g, subscriptions: subscriptions(), profile: p0,
    systemDns: pick([undefined, [], ['192.168.1.1'], ['223.5.5.5', '119.29.29.29']]),
    localSubnets: pick([undefined, [], ['192.168.1.0/24'], ['10.0.0.0/24', '192.168.1.0/24', 'fd00:1::/64']]),
    directHostCidrs: pick([undefined, [], ['203.0.113.9/32', '104.16.0.0/13', '1.2.3.4/32']]),
    clientBindings: {}, ruleLists: chance(0.7) ? undefined : {},
    nativeBypass: chance(0.1) ? { enabled: true, sets: ['geoip-cn'], trimmed: { 'geoip-cn': true }, pending: [] } : undefined,
    inlineDirectHosts: pick([false, false, true, 'aligned']),
  }
  const withFilter = Boolean(p0.dns.filter && p0.dns.filter.enabled)
  input.dnsFilter = withFilter ? artifactFor(p0) : undefined
  if (withFilter) input.filterExpectedKey = df.filterKey(df.filterSettings(p0))
  input.chainNodes = chainMod.chainNodes(p0)
  const args = rt(input)
  // 基线自己做链式核对,所以喂基线的是不带 chainNodes / platform / filterExpectedKey / clientBindings 的那份
  const { chainNodes: _c, platform: _p, filterExpectedKey: _f, clientBindings: _b, ...baseArgs } = rt(input)
  let want, error
  try { want = rt(cfg.buildConfigDetailed(baseArgs)) } catch (e) { error = String(e && e.message || e) }
  cases.push({ args, want: want ?? null, error: error || '' })
  if (error) stats.error++
  else {
    stats.ok++
    const c = want.config
    if (c.inbounds[0].auto_redirect) stats.autoRedirect++
    if (args.chainNodes.length) stats.chain++
    if (want.failover.length) stats.failover++
    if (p0.dns.mode === 'dnsmasq') stats.dnsmasq++
    if (withFilter) stats.filter++
    if (c.inbounds.length > 3) stats.servers++
    if (c.endpoints) stats.wg++
    if (c.dns.fakeip && c.dns.fakeip.enabled) stats.fakeip++
    if (args.nativeBypass) stats.nativeBypass++
  }
}
writeFileSync(out, JSON.stringify({ generatedBy: 'gen-config-golden.mjs', cases }) + '\n')
console.log('写入', cases.length, '条 →', out)
console.log(JSON.stringify(stats))
const errs = {}
for (const c of cases) if (c.error) errs[c.error] = (errs[c.error] || 0) + 1
console.log('报错分布', JSON.stringify(errs))
