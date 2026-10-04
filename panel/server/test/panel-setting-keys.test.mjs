// 前端设置键表(src/constant/panelSettingKeys.ts)必须和 src 里实际用到的 'config/…' 字面量一致:
// 少登记一个,那项设置会在启动同步时被当成老键清掉;多登记一个,就是没清干净的残余。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const REGISTRY = join(SRC, 'constant', 'panelSettingKeys.ts')
const KEY_RE = /'(config\/[a-z0-9-]+)'/g

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|vue)$/.test(name)) out.push(full)
  }
  return out
}
const keysIn = (text) => new Set([...text.matchAll(KEY_RE)].map((m) => m[1]))

test('panelSettingKeys.ts 登记的键 = src 里用到的全部 config/* 字面量（config/access-* 除外）', () => {
  const registered = keysIn(readFileSync(REGISTRY, 'utf8'))
  const used = new Set()
  for (const file of walk(SRC)) {
    if (file === REGISTRY) continue
    for (const key of keysIn(readFileSync(file, 'utf8'))) {
      if (!key.startsWith('config/access-')) used.add(key)
    }
  }
  const missing = [...used].filter((k) => !registered.has(k)).sort()
  const stale = [...registered].filter((k) => !used.has(k)).sort()
  assert.deepEqual(missing, [], `src 里用了但没登记:${missing.join(', ')}`)
  assert.deepEqual(stale, [], `登记了但 src 里没人用:${stale.join(', ')}`)
  assert.ok(registered.size > 50)
})
