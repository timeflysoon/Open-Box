// 生成金标准:用旧版 Node 实现(backup 分支的 panel/server/engine)对固定种子造出的输入求值,
// 把输入和输出记进 routing_golden.json,Go 测试逐条对照。
//
// 用法: node core/testdata/gen-golden.mjs <engine 目录> [输出文件]
//   engine 目录(取自 catch-up-upstream:panel/server/engine,v0.1.318 快照)要含 routing-model.mjs、rule-list.mjs、dns-names.mjs(来自 origin/backup:panel/server/engine/)
//   且该目录需要一个 {"type":"module"} 的 package.json。
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./routing_golden.json', import.meta.url).pathname)
const m = await import(pathToFileURL(resolve(dir, 'routing-model.mjs')).href)

// 固定种子的伪随机数,保证每次生成的语料一样
let seed = 20261020
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rnd() * a.length)]
const chance = (p) => rnd() < p

const STRINGS = [
  '', ' ', '  x  ', 'a', 'cn', 'direct', 'proxy', 'block', '其他', '美国', 'geosite-cn', 'geoip-cn',
  'geosite-netflix', 'geoip-us', ' geosite-google ', 'list-deadbeef', 'https://example.com/a.list',
  'HTTP://X.org/b', 'https://例え.jp/😀.list', 'ftp://bad/c', 'example.com', '*.example.com', '10.0.0.0/8', '2001:db8::/32',
  '51820', '1000-2000', '1-2,3 4', '0', '65536', '9-3', 'abc', '\u3000全角\u3000', '\ufeffbom', 'a\u2028b',
  '引号"与\\反斜杠', 'tab\there', 'CN', 'HKMO', 'OTHER', 'constructor', '__proto__',
]
const NUMS = [0, 1, 2, -1, 3, 1.5, -3, 100, 51820]
const garbage = () => pick([undefined, null, true, false, pick(NUMS), pick(STRINGS), [], {}, [pick(STRINGS)], { a: 1 }])
const str = () => pick(STRINGS)
const strs = () => Array.from({ length: Math.floor(rnd() * 4) }, () => (chance(0.1) ? garbage() : str()))
const maybe = (p, f) => (chance(p) ? f() : undefined)
const noisy = (f) => (chance(0.12) ? garbage() : f())

const NOTE_KEYS = ['geosite:cn', 'domain:a.com', ' 带空格 ', '', '__proto__', 'constructor', 'x', 'ipCidr:10.0.0.0/8']
const LONG = ['a'.repeat(59) + '😀' + 'tail', 'b'.repeat(60), 'c'.repeat(61), '😀'.repeat(31), '  ' + 'd'.repeat(70) + '  ', '中'.repeat(65), 'e'.repeat(58) + '😀']
const noteObj = () => Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [pick(NOTE_KEYS), chance(0.1) ? garbage() : pick([...STRINGS, ...LONG])]))
const GEO_POOL = ['geosite-cn', 'geoip-cn', 'geosite-netflix', 'geoip-us', 'geosite-google', 'list-deadbeef']
const geoTagsFor = () => (chance(0.4) ? GEO_POOL.filter(() => chance(0.6)) : null)
const withGeo = (tags, f) => { m.setAvailableGeoTags(tags); try { return f() } finally { m.setAvailableGeoTags(null) } }
const policy = () => ({
  id: maybe(0.7, () => noisy(str)), name: maybe(0.8, () => noisy(str)), icon: maybe(0.4, () => noisy(str)),
  default: maybe(0.5, () => noisy(() => pick(['direct', 'proxy', 'block', '美国', '']))),
  enabled: maybe(0.5, () => noisy(() => chance(0.7))),
  rulesets: maybe(0.7, () => noisy(() => (chance(0.5) ? GEO_POOL.concat(['geosite-x', 'geoip-xx', ' geosite-cn ', 'geosite-cn']).filter(() => chance(0.45)) : strs()))), ruleUrls: maybe(0.4, () => noisy(strs)),
  domain: maybe(0.4, () => noisy(strs)), domainSuffix: maybe(0.4, () => noisy(strs)),
  domainKeyword: maybe(0.3, () => noisy(strs)), ipCidr: maybe(0.3, () => noisy(strs)),
  notes: maybe(0.3, () => noisy(noteObj)),
})
const customRule = () => ({
  type: noisy(() => pick(['domainSuffix', 'domain', 'domainKeyword', 'ipCidr', 'geosite', 'geoip', 'ruleUrl', 'ruleset', 'port', 'bogus'])),
  value: noisy(() => pick(['cn', 'netflix', 'us', 'google', 'x', 'geosite-cn', 'list-deadbeef', ' cn ', ...STRINGS])),
  outbound: noisy(() => pick(['direct', 'block', '美国', ' 节点1 ', ''])),
  note: maybe(0.3, () => noisy(() => pick([...STRINGS, ...LONG]))),
})
const custom = () => ({
  name: maybe(0.4, () => noisy(str)), icon: maybe(0.3, () => noisy(str)),
  iconScale: maybe(0.4, () => noisy(() => pick(NUMS))), enabled: maybe(0.4, () => noisy(() => chance(0.6))),
  rules: maybe(0.8, () => noisy(() => Array.from({ length: Math.floor(rnd() * 5) }, () => (chance(0.1) ? garbage() : customRule())))),
})
const regionRule = () => ({
  type: noisy(() => pick(['geosite', 'geoip', 'domain', 'domainSuffix', 'ipcidr', 'x'])),
  value: noisy(str), action: maybe(0.8, () => noisy(() => pick(['direct', 'proxy', 'x']))),
})
const region = () => ({
  id: maybe(0.7, () => noisy(() => pick(['cn', 'hkmo', 'other', 'jp', '', ' cn ']))), name: maybe(0.6, () => noisy(str)),
  rules: maybe(0.6, () => noisy(() => Array.from({ length: Math.floor(rnd() * 4) }, () => (chance(0.1) ? garbage() : regionRule())))),
  rulesets: maybe(0.4, () => noisy(strs)), target: maybe(0.4, () => noisy(() => pick(['direct', 'proxy', 'x']))),
  catchAll: maybe(0.4, () => noisy(() => pick(['direct', 'proxy', 'x']))), fallback: maybe(0.3, () => noisy(() => pick(['direct', 'proxy', 'x']))),
})
const category = () => ({ ruleset: maybe(0.9, () => noisy(str)), target: maybe(0.6, () => noisy(() => pick(['direct', 'proxy', '美国', '']))) })

const routing = () => ({
  policies: maybe(0.7, () => noisy(() => Array.from({ length: Math.floor(rnd() * 5) }, () => (chance(0.08) ? garbage() : policy())))),
  custom: maybe(0.6, () => noisy(custom)),
  fallbackDefault: maybe(0.4, () => noisy(() => pick(['direct', 'proxy', '美国', '', ' direct ']))),
  fallbackName: maybe(0.3, () => noisy(() => pick(['其他', '兜底', '', ' 其他 ', '美国']))),
  fallbackIcon: maybe(0.2, () => noisy(str)),
  categories: maybe(0.25, () => noisy(() => Array.from({ length: Math.floor(rnd() * 3) }, () => (chance(0.1) ? garbage() : category())))),
  directRulesets: maybe(0.25, () => noisy(strs)), fallback: maybe(0.2, () => noisy(() => pick(['direct', 'proxy', '']))),
  regions: maybe(0.25, () => noisy(() => Array.from({ length: Math.floor(rnd() * 3) }, () => (chance(0.1) ? garbage() : region())))),
  regionId: maybe(0.25, () => noisy(() => pick(['cn', 'hkmo', 'other', 'jp', '', ' cn ']))),
  regionMode: maybe(0.2, () => noisy(() => pick(['CN', 'HKMO', 'OTHER', 'cn', 'constructor', '']))),
  outboundOptions: maybe(0.3, () => noisy(() => ({ direct: maybe(0.5, garbage), reject: maybe(0.5, garbage), groups: maybe(0.5, garbage) }))),
  adBlock: maybe(0.3, () => noisy(() => chance(0.5))), adRuleset: maybe(0.2, () => noisy(str)),
  proxyTag: maybe(0.2, () => noisy(str)),
})

// 通过 JSON 往返一次再求值:Go 那边拿到的就是这份数据,undefined 在对象里等于没写
const rt = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const cases = []

const hand = [
  undefined, null, {}, [], 'x', 5,
  { policies: [{ name: '美国', rulesets: ['geosite-netflix'] }] },
  { policies: [{ name: 'a', ruleUrls: ['https://e.com/x.list'], rulesets: ['geosite-cn'] }], fallbackDefault: 'proxy' },
  { categories: [{ ruleset: 'geosite-netflix', target: '美国' }], directRulesets: ['geosite-cn', 'geosite-apple'], fallback: 'direct' },
  { regionMode: 'HKMO', policies: [{ name: 'p', domain: ['a.com'] }] },
  { regionId: 'other' }, { regions: [{ id: 'jp', name: '日本', rules: [{ type: 'geosite', value: 'jp', action: 'direct' }], catchAll: 'proxy' }], regionId: 'jp' },
  { custom: { rules: [{ type: 'port', value: '51820', outbound: 'direct' }, { type: 'ruleUrl', value: 'https://a/b', outbound: '节点' }] } },
  { fallbackName: '兜底', policies: [{ name: '兜底', domain: ['x'] }, { name: '其他', domain: ['y'] }, { name: 'ok', domain: ['z'] }] },
]
const norm = (args, tags) => ({ fn: 'normalizeRouting', args, ...(tags ? { geoTags: tags } : {}), ...withGeo(tags, () => ({ want: rt(m.normalizeRouting(...args)), fp: m.routingFingerprint(...args) })) })
for (const h of hand) {
  const args = h === undefined ? [] : [rt(h)]
  cases.push(norm(args, null))
}
// 随包规则库缺规则集的手写用例
for (const [tags, r] of [
  [['geosite-cn'], { policies: [{ name: 'a', rulesets: ['geosite-cn', 'geoip-cn', 'list-deadbeef'] }, { name: 'only', rulesets: ['geoip-cn'] }, { name: 'off', enabled: false, rulesets: ['geoip-xx'], domain: ['a.com'] }] }],
  [[], { custom: { rules: [{ type: 'geosite', value: 'cn', outbound: 'direct' }, { type: 'geoip', value: 'cn', outbound: 'direct' }, { type: 'domain', value: 'a.com', outbound: 'direct' }, { type: 'ruleset', value: 'geosite-x', outbound: 'direct' }] }, policies: [{ name: 'a', ruleUrls: ['https://e.com/x.list'], rulesets: ['geosite-cn'] }] }],
  [['geoip-cn'], { custom: { enabled: false, rules: [{ type: 'geosite', value: 'cn', outbound: 'direct' }] }, policies: [{ name: 'a', rulesets: ['geosite-cn'], domain: ['x'] }] }],
  [['geosite-cn', 'geoip-cn'], { directRulesets: ['geosite-cn', 'geoip-cn', 'geosite-apple'], categories: [{ ruleset: 'geosite-netflix', target: '美国' }] }],
  [['geosite-cn'], { regionId: 'cn' }],
]) cases.push(norm([rt(r)], tags))
for (let i = 0; i < 450; i++) {
  const args = [rt(routing())]
  cases.push(norm(args, geoTagsFor()))
}
for (let i = 0; i < 250; i++) {
  const raw = chance(0.1) ? rt(garbage()) : rt(policy())
  const args = chance(0.5) ? [raw, Math.floor(rnd() * 5)] : raw === undefined ? [] : [raw]
  const tags = geoTagsFor()
  cases.push({ fn: 'normalizePolicy', args, ...(tags ? { geoTags: tags } : {}), want: withGeo(tags, () => rt(m.normalizePolicy(...args))) })
}
// 老档案迁移:返回 { routing, changed }
for (const h of [undefined, null, {}, [], 'x', { policies: [] }, { adBlock: true }, { proxyTag: 'P' }, { outboundOptions: {}, policies: [{ name: 'a' }] }, { adRuleset: 'x', policies: [] }, { categories: [{ ruleset: 'geosite-netflix', target: '美国' }] }, { directRulesets: ['geosite-cn'] }, { regionId: 'other', policies: [{ name: 'p', domain: ['a.com'] }] }, { regionMode: 'CN', fallbackDefault: 'proxy' }, { fallback: 'direct', policies: [] }]) {
  const args = h === undefined ? [] : [rt(h)]
  cases.push({ fn: 'migrateStoredRouting', args, want: rt(m.migrateStoredRouting(...args)) })
}
for (let i = 0; i < 260; i++) {
  const args = [rt(routing())]
  const tags = geoTagsFor()
  cases.push({ fn: 'migrateStoredRouting', args, ...(tags ? { geoTags: tags } : {}), want: withGeo(tags, () => rt(m.migrateStoredRouting(...args))) })
}
writeFileSync(out, JSON.stringify({ generatedBy: 'gen-golden.mjs', cases }) + '\n')
console.log('写入', cases.length, '条 →', out)
