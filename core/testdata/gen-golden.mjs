// 生成金标准:用旧版 Node 实现(backup 分支的 panel/server/engine)对固定种子造出的输入求值,
// 把输入和输出记进 routing_golden.json,Go 测试逐条对照。
//
// 用法: node core/testdata/gen-golden.mjs <旧 engine 目录> [输出文件]
//   旧 engine 目录要含 routing-model.mjs、rule-list.mjs、dns-names.mjs(来自 origin/backup:panel/server/engine/)
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

const policy = () => ({
  id: maybe(0.7, () => noisy(str)), name: maybe(0.8, () => noisy(str)), icon: maybe(0.4, () => noisy(str)),
  default: maybe(0.5, () => noisy(() => pick(['direct', 'proxy', 'block', '美国', '']))),
  enabled: maybe(0.5, () => noisy(() => chance(0.7))),
  rulesets: maybe(0.7, () => noisy(strs)), ruleUrls: maybe(0.4, () => noisy(strs)),
  domain: maybe(0.4, () => noisy(strs)), domainSuffix: maybe(0.4, () => noisy(strs)),
  domainKeyword: maybe(0.3, () => noisy(strs)), ipCidr: maybe(0.3, () => noisy(strs)),
})
const customRule = () => ({
  type: noisy(() => pick(['domainSuffix', 'domain', 'domainKeyword', 'ipCidr', 'geosite', 'geoip', 'ruleUrl', 'ruleset', 'port', 'bogus'])),
  value: noisy(str), outbound: noisy(() => pick(['direct', 'block', '美国', ' 节点1 ', ''])),
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
for (const h of hand) {
  const args = h === undefined ? [] : [rt(h)]
  cases.push({ fn: 'normalizeRouting', args, want: rt(m.normalizeRouting(...args)), fp: m.routingFingerprint(...args) })
}
for (let i = 0; i < 450; i++) {
  const args = [rt(routing())]
  cases.push({ fn: 'normalizeRouting', args, want: rt(m.normalizeRouting(...args)), fp: m.routingFingerprint(...args) })
}
for (let i = 0; i < 250; i++) {
  const raw = chance(0.1) ? rt(garbage()) : rt(policy())
  const args = chance(0.5) ? [raw, Math.floor(rnd() * 5)] : raw === undefined ? [] : [raw]
  cases.push({ fn: 'normalizePolicy', args, want: rt(m.normalizePolicy(...args)) })
}
writeFileSync(out, JSON.stringify({ generatedBy: 'gen-golden.mjs', cases }) + '\n')
console.log('写入', cases.length, '条 →', out)
