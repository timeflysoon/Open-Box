// 生成 DNS 过滤(buildFilterConfig)的金标准。
// 基线:上游 v0.1.318 快照(tag engine-snapshot)里 panel/server/engine/ 的明文源码。
// 用法: node core/testdata/gen-dnsfilter-golden.mjs <engine 基线目录> [输出文件]
//   目录要含 dns-filter.mjs,上层 panel/server/ 需要 {"type":"module"} 的 package.json。
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./dnsfilter_golden.json', import.meta.url).pathname)
const df = await import(pathToFileURL(resolve(dir, 'dns-filter.mjs')).href)

let seed = 4242
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rnd() * a.length)]
const chance = (p) => rnd() < p
const int = (n) => Math.floor(rnd() * n)
const rt = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const garbage = () => pick([undefined, null, true, false, 0, 5, -1, 'x', '', ' ', [], {}, ['y'], { a: 1 }])

const tag = () => `dns-filter-${pick(['a', 'b', 'anti-ad', 'x_1'])}-${int(16 ** 8).toString(16).padStart(16, '0')}`
const tags = (n) => Array.from({ length: n }, tag)
const blocks = () => Array.from({ length: int(5) }, () => ({ tag: tag(), important: chance(0.4) }))
const sometimes = (p, v) => (chance(p) ? v : undefined)
const artifact = (key) => {
  const a = { key }
  const sets = sometimes(0.8, Array.from({ length: int(4) }, () => ({ type: 'local', tag: tag(), format: 'binary', path: `/x/${int(99)}.srs` })))
  if (sets) a.sets = sets
  const b = sometimes(0.85, blocks()); if (b) a.blocks = b
  for (const f of ['allow', 'allowImportant', 'userAllow']) { const t = sometimes(0.5, tags(int(3))); if (t) a[f] = t }
  return a
}
const filterVal = () => ({
  enabled: pick([true, true, true, true, true, true, true, true, false, 1, 0, 'yes', '', null, undefined]),
  lists: [{ id: 'anti-ad', name: 'x', url: 'https://x/y', enabled: true }],
  allowDomains: chance(0.5) ? [] : ['a.com'],
  ...(chance(0.4) ? { autoUpdate: { enabled: chance(0.5), days: 1 + int(5), hour: int(24) } } : {}),
})
const profile = () => {
  if (chance(0.05)) return garbage()
  const dns = chance(0.04) ? garbage() : { mode: 'hijack', ...(chance(0.04) ? {} : { filter: chance(0.04) ? garbage() : filterVal() }) }
  return chance(0.03) ? { dns: garbage() } : { dns }
}

const cases = []
const stats = { off: 0, ready: 0, notReady: 0 }
for (let i = 0; i < 900; i++) {
  const p = rt(profile())
  const enabled = Boolean(p?.dns?.filter?.enabled)
  let real = ''
  if (enabled) real = df.filterKey(df.filterSettings(p))
  let art
  const r = rnd()
  if (r < 0.62) art = artifact(real)
  else if (r < 0.72) art = artifact('0'.repeat(16))
  else art = pick([undefined, null, {}, { key: 5 }, { key: '' }, 'x', 7, [], false])
  const a = rt(art)
  const want = (() => {
    try { return { want: rt(df.buildFilterConfig(p, a)) } } catch (e) { return { error: e.message } }
  })()
  cases.push({ args: [p, a, enabled ? real : null], ...want })
  if (want.error) stats.notReady++
  else if (enabled) stats.ready++
  else stats.off++
}
writeFileSync(out, JSON.stringify({ cases }))
console.log(JSON.stringify(stats), 'cases', cases.length)
