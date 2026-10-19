// 生成 classes / forwardPlan / bypassPlan 的金标准(对应旧实现 policyClasses / dnsmasqForwardPlan / nativeBypassPlan)。
// 用法: node core/testdata/gen-plans-golden.mjs <旧 engine 目录> [输出文件]
//
// 注意:bypassPlan 在 Node 里新增的 enabled / ignoreProxyClients 选项旧实现没有,
// 这里不生成它们的用例,由 Go 单元测试单独覆盖。
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./plans_golden.json', import.meta.url).pathname)
const m = await import(pathToFileURL(resolve(dir, 'routing-model.mjs')).href)

let seed = 1020
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

// 全部是 ASCII 或常见的非 ASCII 写法(全角 / ß 这类 UTS46 才会映射的写法 Go 版有已知差异,不进语料)
const DOMAINS = [
  'example.com', 'Example.COM', '*.sub.example.com', '.dot.com', 'trail.com.', 'a..b', '-bad.com', 'bad-.com',
  'x'.repeat(64) + '.com', 'ok-1.net', '中国.example', 'bücher.example', '例え.jp', 'пример.рф', '😀.example',
  'a b.com', 'with#hash.com', 'slash/x.com', ' padded.org ', 'UPPER.CN', 'cdn.google.com', 'github.com', '1.2.3.4',
  'a'.repeat(63) + '.com', ('a'.repeat(50) + '.').repeat(6) + 'com', 'xn--fiq228c.com', '',
]
const SETS = ['geosite-cn', 'geoip-cn', 'geosite-google', 'geoip-us', 'geoip-jp', 'geosite-netflix', 'geosite-category-ads-all']
const URLS = ['https://a.example/x.list', 'https://b.example/y.list', 'https://例え.jp/z.list']
const NAMES = ['A', 'B', 'C', '美国', '香港', '直连集', '代理集']
const MEMBERS = ['direct', 'block', '美国', '香港', '节点组A', '节点组B']
const DEFAULTS = ['direct', 'direct', 'direct', 'proxy', 'block', '美国', '香港', '', '不存在的组']

const policy = () => ({
  name: pick(NAMES), default: pick(DEFAULTS), enabled: chance(0.9),
  rulesets: some(SETS, 3), ruleUrls: chance(0.2) ? some(URLS, 2) : [],
  domain: chance(0.5) ? some(DOMAINS, 3) : [], domainSuffix: chance(0.4) ? some(DOMAINS, 2) : [],
  domainKeyword: chance(0.05) ? ['kw'] : [], ipCidr: chance(0.3) ? some(['10.0.0.0/8', '1.1.1.0/24', '2001:db8::/32'], 2) : [],
})
const customRule = () => {
  const type = pick(['domainSuffix', 'domain', 'domainKeyword', 'ipCidr', 'geosite', 'geoip', 'ruleUrl', 'ruleset', 'port'])
  const value = {
    domainSuffix: () => pick(DOMAINS), domain: () => pick(DOMAINS), domainKeyword: () => 'kw', ipCidr: () => '8.8.8.0/24',
    geosite: () => 'netflix', geoip: () => 'us', ruleUrl: () => pick(URLS), ruleset: () => 'geosite-foo', port: () => pick(['51820', '1000-2000']),
  }[type]()
  return { type, value: value || 'x.com', outbound: pick(['direct', 'block', '美国', '节点1']) }
}
const routing = () => {
  const r = {
    policies: Array.from({ length: Math.floor(rnd() * 5) }, policy),
    fallbackDefault: pick(['direct', 'direct', 'direct', 'direct', 'direct', 'proxy', '美国', '']),
    fallbackName: chance(0.2) ? pick(['兜底', '其他']) : undefined,
    adBlock: chance(0.04), custom: chance(0.18) ? { rules: Array.from({ length: 1 + Math.floor(rnd() * 3) }, customRule) } : undefined,
  }
  if (chance(0.1)) { r.categories = [{ ruleset: 'geosite-netflix', target: '美国' }]; r.directRulesets = ['geosite-apple'] }
  if (chance(0.1)) r.regionMode = pick(['CN', 'HKMO', 'OTHER'])
  return r
}
const builtin = () => (chance(0.3) ? { direct: '直连', block: '拒绝', directEnabled: true, blockEnabled: true } : undefined)
const members = (b) => {
  const base = [b ? b.direct : 'direct', b ? b.block : 'block', ...some(MEMBERS.slice(2), 4)]
  return chance(0.1) ? [] : [...new Set(base)].filter(() => chance(0.9))
}
const selections = () => {
  if (chance(0.55)) return undefined
  const s = {}
  for (const n of [...NAMES, '其他', '兜底']) if (chance(0.2)) s[n] = pick([...MEMBERS, 'direct', '直连', '拒绝', ...NAMES])
  if (chance(0.1)) { s['节点组A'] = '节点组B'; s['节点组B'] = '节点组A' } // 环
  if (chance(0.1)) { s['美国'] = '节点组A'; s['节点组A'] = 'direct' } // 链
  return s
}
const clientRoutes = (b) => (chance(0.12) ? Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => ({ ip: '192.168.1.5', outbound: pick([b ? b.direct : 'direct', '美国', '节点组A', '']) })) : chance(0.5) ? [] : undefined)

const cases = []
for (let i = 0; i < 900; i++) {
  const r = rt(routing())
  const b = builtin()
  const mem = members(b)
  const sel = selections()
  const base = [r, mem, b ?? undefined, sel]
  const clean = (a) => { const x = [...a]; while (x.length && x[x.length - 1] === undefined) x.pop(); return rt(x.map((v) => (v === undefined ? null : v))) }
  // 参数里的 undefined 在 JSON 里变成 null;旧 JS 用默认参数,所以求值时也要按「没传」处理
  const call = (fn, a) => fn(...a.map((v) => (v === null ? undefined : v)))
  const kind = i % 3
  if (kind === 0) {
    const a = clean(base)
    cases.push({ fn: 'classes', args: a, want: rt(call(m.policyClasses, a)) })
  } else if (kind === 1) {
    const extra = chance(0.4) ? { rewriteDomains: some(['rw.example.com', 'a.b', '', 5, 'dup.com', 'dup.com'], 3) } : undefined
    const a = clean([...base, extra])
    cases.push({ fn: 'forwardPlan', args: a, want: rt(call(m.dnsmasqForwardPlan, a)) })
  } else {
    const opts = { members: mem, builtin: b, selections: sel, clientRoutes: clientRoutes(b), fakeIp: chance(0.35) ? true : chance(0.3) ? false : undefined, dnsMode: pick(['dnsmasq', 'hijack', 'off', undefined]) }
    const o = rt(opts) ?? {}
    const a = [r, o]
    cases.push({ fn: 'bypassPlan', args: a, want: rt(m.nativeBypassPlan(r, o)) })
  }
}
writeFileSync(out, JSON.stringify({ generatedBy: 'gen-plans-golden.mjs', cases }) + '\n')

const stat = (fn, f) => { const c = {}; for (const x of cases.filter((x) => x.fn === fn)) c[f(x.want)] = (c[f(x.want)] || 0) + 1; return c }
console.log('写入', cases.length, '条 →', out)
console.log('forwardPlan mode:', stat('forwardPlan', (w) => w.mode))
console.log('bypassPlan:', stat('bypassPlan', (w) => (w.enabled ? 'on' : w.pending.length ? 'pending' : 'off')))
console.log('classes 含 block/proxy/direct:', ['direct', 'block', 'proxy'].map((k) => k + '=' + cases.filter((x) => x.fn === 'classes').filter((x) => Object.values(x.want).includes(k)).length).join(' '))
