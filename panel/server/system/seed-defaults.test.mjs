import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadStorageDefaults, LOGIN_DEFAULTS_REPAIR_KEY, repairLoginDefaultsBurst, seedDefaultStorage } from './seed-defaults.mjs'

const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-defaults-'))
  fs.writeFileSync(path.join(dir, 'storage-defaults.json'), JSON.stringify({
    'config/theme-mode': 'light', 'config/access-password': 'nope', 'openbox/profile': '{}', 'config/x': 1,
  }))
  fs.writeFileSync(path.join(dir, 'background-image.txt'), 'data:image/jpeg;base64,AAAA\n')
  return dir
}

test('loadStorageDefaults:只收 config/*（排除 access-*）的字符串值;背景必须是 data:image', () => {
  const { entries, background } = loadStorageDefaults(tmpDir())
  assert.deepEqual(entries, { 'config/theme-mode': 'light' })
  assert.equal(background, 'data:image/jpeg;base64,AAAA')
  assert.deepEqual(loadStorageDefaults('/nonexistent'), { entries: {}, background: '' })
})

test('seedDefaultStorage:全新安装写入默认值和背景;已有 config/* 时不动', () => {
  const dir = tmpDir()
  const rows = {}
  const r = seedDefaultStorage({ countConfigEntries: () => 0, insert: (k, v) => { rows[k] = v }, dir })
  assert.equal(r.seeded, 2)
  assert.equal(rows['config/theme-mode'], 'light')
  assert.equal(rows.__background_image__, 'data:image/jpeg;base64,AAAA')
  const rows2 = {}
  assert.deepEqual(seedDefaultStorage({ countConfigEntries: () => 5, insert: (k, v) => { rows2[k] = v }, dir }), { seeded: 0, profile: false })
  assert.deepEqual(rows2, {})
})

test('随包的默认值文件本身合法:有主题等关键项,背景是 data:image', () => {
  const { entries, background } = loadStorageDefaults()
  assert.equal(entries['config/theme-mode'], 'light')
  assert.equal(entries['config/corner-radius'], '26', '全局圆角默认照 iOS 27 的卡片圆角')
  assert.ok(!Object.keys(entries).some((k) => k.startsWith('config/access-')))
  assert.ok(background.startsWith('data:image/'))
})

test('全新安装同时写入默认档案（目标分流）;已有 openbox/profile 或已有 config/* 时不动', async () => {
  const { loadProfileDefaults, PROFILE_KEY } = await import('./seed-defaults.mjs')
  const defaults = loadProfileDefaults()
  assert.ok(defaults && defaults.routing && defaults.routing.policies.length >= 5, '随包的 profile-defaults.json 要有一套站点集')
  const names = defaults.routing.policies.map((p) => p.name)
  for (const n of ['Speed', 'AI', 'Youtube', 'Google', 'Microsoft', 'Apple', 'Games', '国内']) assert.ok(names.includes(n), n)
  // Speed 必须排最前:站点集是从上往下先命中先生效,排在「国外」后面的话 speedtest.net
  // 这类会被「国外」先接走,测速就不走指定线路了(用户明确要求提到最上面)
  assert.equal(names[0], 'Speed', `Speed 要排第一,实际顺序:${names.join(' / ')}`)
  const speed = defaults.routing.policies[0]
  assert.ok((speed.domain.length + speed.domainSuffix.length) >= 50, '测速站点名单不该是空的')
  // 出口必须是占位符:新装机器上没有作者的节点组,写死组名会指向一个不存在的出口
  for (const p of defaults.routing.policies) assert.ok(['proxy', 'direct'].includes(p.default), `${p.name} 的出口要用占位符,实际 ${p.default}`)
  assert.equal(defaults.routing.fallbackName, '其他')
  // 不带任何个人域名
  // 默认档案取自作者自己的路由器,发出去之前必须把个人域名摘干净
  const PERSONAL = /angeworld|opendoor|superdoor|wanhouse|wan\.family|ok1248/
  for (const p of defaults.routing.policies)
    for (const d of [...(p.domain || []), ...(p.domainSuffix || []), ...(p.domainKeyword || [])])
      assert.ok(!PERSONAL.test(d), d)
  // 全新:写入
  const fresh = new Map()
  const r1 = seedDefaultStorage({ countConfigEntries: () => 0, insert: (k, v) => fresh.set(k, v), hasKey: (k) => fresh.has(k) })
  assert.equal(r1.profile, true)
  assert.deepEqual(JSON.parse(fresh.get(PROFILE_KEY)).routing.policies.map((p) => p.name), names)
  // 已有档案:不覆盖
  const withProfile = new Map([[PROFILE_KEY, '{"routing":{"policies":[]}}']])
  const r2 = seedDefaultStorage({ countConfigEntries: () => 0, insert: (k, v) => withProfile.set(k, v), hasKey: (k) => withProfile.has(k) })
  assert.equal(r2.profile, false)
  assert.equal(withProfile.get(PROFILE_KEY), '{"routing":{"policies":[]}}')
  // 老安装(有 config/*):什么都不写
  const old = new Map()
  const r3 = seedDefaultStorage({ countConfigEntries: () => 5, insert: (k, v) => old.set(k, v), hasKey: (k) => old.has(k) })
  assert.equal(r3.profile, false)
  assert.equal(old.size, 0)
})

// 登录同步 bug 冲掉的面板设置:升级后第一次启动修一次(seed-defaults.mjs 的 repairLoginDefaultsBurst)
const BURST = '2026-10-07 03:10:43'
const SHIPPED_IMAGE = 'data:image/jpeg;base64,SHIPPED'
const repairDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-repair-'))
  fs.writeFileSync(path.join(dir, 'storage-defaults.json'), JSON.stringify({
    'config/custom-background-image': 'local-image-1788361724032',
    'config/dashboard-transparent': '75',
    'config/blur-intensity': '7',
    'config/two-columns': 'false',
    'config/proxy-sort-type': 'latencyasc',
    'config/low-latency': '500',
    'config/corner-radius': '26',
    'config/theme-mode': 'light',
  }))
  fs.writeFileSync(path.join(dir, 'background-image.txt'), `${SHIPPED_IMAGE}\n`)
  return dir
}
// 假的 app_storage:那次 bug 同一秒写了 40 个键(前端出厂值),另有老键和出事之后用户自己改过的键
const bugTable = ({ image = SHIPPED_IMAGE, at = BURST, overrides = {}, filler = 32 } = {}) => {
  const table = new Map()
  const put = (key, value, updatedAt) => table.set(key, { key, value, updated_at: updatedAt })
  const burst = {
    'config/custom-background-image': '',
    'config/dashboard-transparent': '90',
    'config/blur-intensity': '10',
    'config/two-columns': 'true',
    'config/proxy-group-columns': '2',
    'config/proxy-sort-type': 'defaultsort',
    'config/corner-radius': '26',
    'config/theme-mode': 'light',
    ...overrides,
  }
  for (const [key, value] of Object.entries(burst)) put(key, value, at)
  for (let i = 0; i < filler; i += 1) put(`config/filler-${i}`, `v${i}`, at)
  put('config/global-radius', '24', '2026-10-02 11:30:39')
  put('config/low-latency', '450', '2026-10-07 05:00:00')
  if (image) put('__background_image__', image, '2026-09-20 03:50:23')
  return {
    table,
    rows: () => [...table.values()].filter((row) => row.key.startsWith('config/')),
    get: (key) => table.get(key)?.value ?? null,
    set: (key, value) => put(key, value, 'NOW'),
  }
}
const valueOf = (t, key) => t.table.get(key)?.value
const configSnapshot = (t) => JSON.stringify([...t.table.values()].filter((row) => row.key.startsWith('config/')))

test('repairLoginDefaultsBurst:随包那张图 + 同一秒被冲成出厂值 → 那一秒的键改回随包默认、圆角 / 列数照换算,之后改过的不动,只做一次', () => {
  const t = bugTable()
  const logs = []
  const { repaired } = repairLoginDefaultsBurst({ ...t, log: (m) => logs.push(m), now: () => 1234, dir: repairDir() })
  assert.deepEqual([...repaired].sort(), [
    'config/blur-intensity',
    'config/corner-radius',
    'config/custom-background-image',
    'config/dashboard-transparent',
    'config/proxy-group-columns',
    'config/proxy-sort-type',
    'config/two-columns',
  ])
  assert.equal(valueOf(t, 'config/custom-background-image'), 'local-image-1788361724032')
  assert.equal(valueOf(t, 'config/dashboard-transparent'), '75')
  assert.equal(valueOf(t, 'config/blur-intensity'), '7')
  assert.equal(valueOf(t, 'config/two-columns'), 'false')
  assert.equal(valueOf(t, 'config/proxy-group-columns'), '1', '照恢复后的 two-columns 换算')
  assert.equal(valueOf(t, 'config/proxy-sort-type'), 'latencyasc')
  assert.equal(valueOf(t, 'config/corner-radius'), '24', '老键 24 不是出厂的 15 / 16,照前端换算')
  assert.equal(valueOf(t, 'config/low-latency'), '450', '出事之后用户自己改的不动')
  assert.equal(valueOf(t, 'config/theme-mode'), 'light')
  assert.equal(valueOf(t, 'config/filler-0'), 'v0')
  assert.ok(valueOf(t, LOGIN_DEFAULTS_REPAIR_KEY))
  assert.equal(logs.length, 1)
  // 只做一次:之后背景地址再变成空也不再动
  t.set('config/custom-background-image', '')
  assert.deepEqual(repairLoginDefaultsBurst({ ...t, dir: repairDir() }).repaired, [])
  assert.equal(valueOf(t, 'config/custom-background-image'), '')
})

test('repairLoginDefaultsBurst:自己上传的图只改回背景地址,透明度 / 模糊不动', () => {
  const t = bugTable({ image: 'data:image/png;base64,MINE' })
  const { repaired } = repairLoginDefaultsBurst({ ...t, now: () => 1234, dir: repairDir() })
  assert.deepEqual(repaired, ['config/custom-background-image'])
  assert.equal(valueOf(t, 'config/custom-background-image'), 'local-image-1234')
  assert.equal(valueOf(t, 'config/dashboard-transparent'), '90')
  assert.equal(valueOf(t, 'config/blur-intensity'), '10')
})

test('repairLoginDefaultsBurst:不是那个 bug 留下的就不动,看过一次就记下', () => {
  const cases = {
    没有背景图: bugTable({ image: '' }),
    背景地址不是空的: bugTable({ overrides: { 'config/custom-background-image': 'https://example.com/a.jpg' } }),
    同一秒写的键太少: bugTable({ filler: 5 }),
    出事之前就是这样: bugTable({ at: '2026-09-30 10:00:00' }),
    透明度不是出厂值像导入设置: bugTable({ overrides: { 'config/dashboard-transparent': '75' } }),
  }
  for (const [name, t] of Object.entries(cases)) {
    const before = configSnapshot(t)
    assert.deepEqual(repairLoginDefaultsBurst({ ...t, dir: repairDir() }).repaired, [], name)
    assert.equal(configSnapshot(t), before, name)
    assert.ok(valueOf(t, LOGIN_DEFAULTS_REPAIR_KEY), `${name}:看过一次就记下`)
  }
})
