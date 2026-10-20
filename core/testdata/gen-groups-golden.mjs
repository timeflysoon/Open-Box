// 生成节点组三个方法的金标准:normalizeGroups / builtinTags / emitGroups(旧实现里叫 emitUserGroups)。
// 用法: node core/testdata/gen-groups-golden.mjs <旧 engine 目录> [输出文件]
//   旧 engine 目录要含 user-groups.mjs、rename.mjs、duration.mjs、test-url.mjs、dictionaries.mjs、countries.mjs
//   且需要一个 {"type":"module"} 的 package.json。
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./groups_golden.json', import.meta.url).pathname)
const m = await import(pathToFileURL(resolve(dir, 'user-groups.mjs')).href)

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
const maybe = (p, f) => (chance(p) ? f() : undefined)
const garbage = () => pick([undefined, null, true, false, 0, 3, -1, 'x', '', ' ', [], {}, ['y'], { a: 1 }])
const noisy = (f) => (chance(0.1) ? garbage() : f())

const NODE_TAGS = ['香港-01', '香港-02', '美国-01', '美国-02', '日本-01', 'US-03', '🇭🇰香港 01', '🇺🇸US 02', 'cn2线路', 'CN-01', 'CN20-x', '破晓 | 香港-03', '其他-01', 'HK01', 'Singapore', '俄罗斯-01', 'Russia-1', 'jp_05']
const REGIONS = ['香港', '美国', '日本', '中国', '', undefined]
const NAMES = ['所有-自动', '所有-手动', '香港-自动', '美国-自动', 'A', 'B', 'C', '直连', '拒绝', '其他', '香港-01', ' 带空格 ', '直连X']
const KEYWORDS = ['hk', '香港', 'us', '美国', 'cn', 'cn2', 'jp', '🇭🇰', '', '  ', 'HK', '日本', 'sg', 'russia']
const MEMBERS = [...NAMES, ...NODE_TAGS, '不存在', '直连', '拒绝']
const ICONS = ['hk', 'HK', 'globe:ASIA', 'Brand:Google', 'misc:dart', ' us ', 'abc', '', 'x', null]
const NUMS = [0, 100, -5, '50', null, 1.5, 'abc', true, [], 1e9, '0x10', 7, 60000, 60001, 20, 25, '  3 ']
const SCALES = [0, 3, -30, 25, '4', null, 2.5, -2.5, 'x', 0.49999999999999994, -0.5, [5], true]
const INTERVALS = ['300s', '5m', '1h', '90s', 'abc', '', '1s', '25h', ' 10m ', '5000ms', '30', 'x1h30m']

const lane = () => ({
  id: maybe(0.7, () => pick(['l1', 'l2', 'l1', ' l3 ', ''])), name: maybe(0.5, () => pick(['主用', '备用 1', ' '])),
  icon: maybe(0.3, () => pick(ICONS)), members: noisy(() => [pick(NODE_TAGS), ...some(NODE_TAGS, 2), ...(chance(0.1) ? ['不存在', ' 香港-01 '] : [])]),
})
const failoverObj = () => ({
  timeoutMs: maybe(0.6, () => pick(NUMS)), failureThreshold: maybe(0.6, () => pick(NUMS)),
  restorePrimary: maybe(0.5, () => pick([true, false, null, 0, 'false'])), recoveryHoldMs: maybe(0.6, () => pick(NUMS)),
})
const group = () => {
  const type = pick(['selector', 'selector', 'urltest', 'urltest', 'failover', 'bogus', undefined])
  const builtin = chance(0.2) ? pick(['builtin-direct', 'builtin-block']) : undefined
  return {
    id: builtin ?? maybe(0.8, () => pick(['g1', 'g2', 'g3', 'g4', 'g5', ' g6 ', ''])),
    name: maybe(0.85, () => noisy(() => pick(NAMES))),
    type, mode: maybe(0.6, () => noisy(() => pick(['static', 'dynamic', 'x']))),
    allNodes: maybe(0.1, () => chance(0.7)),
    enabled: maybe(0.5, () => noisy(() => pick([true, false, null, 0]))),
    icon: maybe(0.6, () => pick(ICONS)), iconScale: maybe(0.4, () => pick(SCALES)),
    keywords: maybe(0.6, () => noisy(() => some(KEYWORDS, 3))), members: maybe(0.7, () => noisy(() => some(MEMBERS, 4))),
    testUrl: maybe(0.3, () => pick(['', ' ', 'https://a.com/204', null])), interval: maybe(0.5, () => pick(INTERVALS)),
    tolerance: maybe(0.5, () => pick(NUMS)), idleTimeout: maybe(0.4, () => pick(['12h', '5m', '1h', 'abc', '', '30'])),
    lanes: maybe(0.7, () => noisy(() => Array.from({ length: Math.floor(rnd() * 5) }, () => (chance(0.08) ? garbage() : lane())))),
    failover: maybe(0.5, () => noisy(failoverObj)),
  }
}
const groupList = () => {
  if (chance(0.05)) return garbage()
  const list = Array.from({ length: Math.floor(rnd() * 6) }, () => (chance(0.05) ? garbage() : group()))
  if (chance(0.15)) { // 互相引用的环(再带一个引用环的组,和一个引用已存在节点的组)
    list.push({ id: 'cx1', name: 'X1', type: 'selector', members: ['X2', pick(NODE_TAGS)] }, { id: 'cx2', name: 'X2', type: 'urltest', members: ['X1'] })
    if (chance(0.5)) list.push({ id: 'cx3', name: 'X3', type: 'selector', members: ['X1', 'X2', pick(NODE_TAGS)] })
  }
  if (chance(0.3)) list.push({ id: 'ok1', name: '香港-手选', type: 'selector', members: [pick(NODE_TAGS), pick(NODE_TAGS), 'A'] })
  return list
}
const nodes = () => {
  const list = [...new Set([...NODE_TAGS.slice(0, 3), ...some(NODE_TAGS, 12)])].map((tag) => ({ tag, regionName: pick(REGIONS) }))
  if (chance(0.1) && list.length) list.push({ ...list[0] }) // 重名
  return list
}

const cases = []
const N = (fn, args) => cases.push({ fn, args, want: rt(m[{ normalizeGroups: 'normalizeGroups', builtinTags: 'builtinTags', emitGroups: 'emitUserGroups' }[fn]](...args)) })
for (let i = 0; i < 700; i++) {
  const k = i % 5
  if (k === 0) N('normalizeGroups', [rt(groupList())])
  else if (k === 1) N('builtinTags', [rt(groupList())])
  else N('emitGroups', [rt(groupList()), rt(nodes()), rt(chance(0.3) ? { testUrl: pick(['https://t.example/204', '', ' ']) } : chance(0.5) ? {} : undefined) ?? {}])
}
// 手写几条:默认组、环、空组占位、故障转移
const hand = [
  [[], [], {}],
  [[{ id: 'a', name: 'A', type: 'selector', members: ['B'] }, { id: 'b', name: 'B', type: 'selector', members: ['A'] }], [{ tag: '香港-01' }], {}],
  [[{ id: 'e', name: '爱尔兰-自动', type: 'urltest', mode: 'dynamic', keywords: ['ie'] }], [{ tag: '香港-01' }], {}],
  [[{ id: 'f', name: '主备', type: 'failover', lanes: [{ id: 'p', members: ['香港-01', '香港-02'] }, { id: 'q', members: ['美国-01'] }, { members: ['不存在'] }] }], [{ tag: '香港-01' }, { tag: '香港-02' }, { tag: '美国-01' }], {}],
  [[{ id: 'builtin-block', name: '拒绝', enabled: false }, { id: 'f', name: '主备', type: 'failover', lanes: [{ id: 'p', members: ['香港-01'] }] }], [{ tag: '香港-01' }], {}],
]
// 关键词边界:短码(2~3 位 ASCII)前后不能是字母;cn 不匹配 cn2 线路;国旗 emoji 还原成字母
const dyn = (id, kw) => ({ id, name: id, type: 'selector', mode: 'dynamic', keywords: kw })
hand.push(
  [[dyn('K1', ['us'])], [{ tag: 'Russia-1' }, { tag: 'US-03' }, { tag: '美国-01' }, { tag: 'Aus-1' }, { tag: 'us1' }, { tag: 'bus' }], {}],
  [[dyn('K2', ['cn'])], [{ tag: 'cn2线路' }, { tag: 'CN20-x' }, { tag: 'cn1' }, { tag: 'CN-01' }, { tag: 'scn' }, { tag: 'cn22' }, { tag: 'cn2a' }, { tag: 'cn' }], {}],
  [[dyn('K3', ['hk'])], [{ tag: 'HK01' }, { tag: 'hk' }, { tag: '🇭🇰香港 01' }, { tag: '🇭🇰🇨🇳' }, { tag: 'chk-1' }, { tag: 'hkg' }], {}],
  [[dyn('K4', ['香港', 'jp'])], [{ tag: 'x', regionName: '香港' }, { tag: 'jp_05' }, { tag: 'jpn' }, { tag: 'Ajp' }], {}],
  [[dyn('K5', ['🇭🇰', 'HK '])], [{ tag: 'hk-1' }, { tag: '🇭🇰 a' }], {}],
)
for (const [g, n, o] of hand) N('emitGroups', [rt(g), rt(n), o])
writeFileSync(out, JSON.stringify({ generatedBy: 'gen-groups-golden.mjs', cases }) + '\n')

const emits = cases.filter((c) => c.fn === 'emitGroups').map((c) => c.want)
const count = (f) => emits.filter(f).length
console.log('写入', cases.length, '条 →', out)
console.log('emitGroups:', emits.length, '| 有环丢弃', count((w) => w.dropped.length), '| 有占位', count((w) => w.placeholders.length), '| 故障转移', count((w) => w.failover.length),
  '| 内部子组', count((w) => w.internalTags.length), '| 内置拒绝停用', count((w) => !w.builtin.blockEnabled), '| urltest', count((w) => w.outbounds.some((o) => o.type === 'urltest')))
