import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryWatchdog, recordWatchdogRestart, rssLimitMb, DEFAULT_RSS_LIMIT_MB } from './memory-watchdog.mjs'
import { createMockContext } from './context.mjs'

const MB = 1048576

test('rssLimitMb:显式上限优先;否则按堆上限 + 140;都没有用默认值;太小的显式值不认', () => {
  assert.equal(rssLimitMb({ OPENBOX_PANEL_RSS_LIMIT_MB: '260', OPENBOX_PANEL_HEAP_MB: '160' }), 260)
  assert.equal(rssLimitMb({ OPENBOX_PANEL_HEAP_MB: '160' }), 300)
  assert.equal(rssLimitMb({ OPENBOX_PANEL_HEAP_MB: '128' }), 268)
  assert.equal(rssLimitMb({}), DEFAULT_RSS_LIMIT_MB)
  assert.equal(rssLimitMb({ OPENBOX_PANEL_RSS_LIMIT_MB: '50' }), DEFAULT_RSS_LIMIT_MB, '50 MB 连 Node 自己都装不下,不认')
})

test('连续超限满次数才重启;中间回落就重新数;只触发一次', async () => {
  let rss = 100 * MB
  const events = []
  const dog = createMemoryWatchdog({ limitMb: 300, checks: 3, memoryUsage: () => ({ rss }), uptime: () => 7200, onExceed: async (e) => { events.push(e) }, log: () => {} })
  await dog.tick()
  rss = 320 * MB
  await dog.tick()
  await dog.tick()
  rss = 200 * MB
  await dog.tick()
  assert.equal(events.length, 0, '回落过,重新数')
  rss = 340 * MB
  await dog.tick()
  await dog.tick()
  assert.equal(events.length, 0)
  await dog.tick()
  assert.equal(events.length, 1)
  assert.equal(Math.round(events[0].rssMb), 340)
  await dog.tick()
  assert.equal(events.length, 1, '已经在重启了,不重复触发')
})

test('正在部署 / 升级时不重启,等忙完的下一轮再触发', async () => {
  let busy = true
  const events = []
  const dog = createMemoryWatchdog({ limitMb: 300, checks: 2, memoryUsage: () => ({ rss: 400 * MB }), uptime: () => 7200, isBusy: async () => busy, onExceed: async (e) => { events.push(e) }, log: () => {} })
  await dog.tick()
  const r = await dog.tick()
  assert.equal(r.busy, true)
  assert.equal(events.length, 0)
  busy = false
  await dog.tick()
  assert.equal(events.length, 1)
})

test('recordWatchdogRestart:追加记录,只留最近几条;文件坏了从头记', async () => {
  const ctx = createMockContext({ files: { '/d/w.json': 'not json' } })
  for (let i = 0; i < 12; i++) await recordWatchdogRestart(ctx, '/d/w.json', { at: i, rssMb: 300 + i }, { keep: 10 })
  const list = JSON.parse(await ctx.readFile('/d/w.json'))
  assert.equal(list.length, 10)
  assert.equal(list[0].at, 2)
  assert.equal(list[9].at, 11)
})

test('刚启动不到 10 分钟就超限:只记日志不重启(上限比正常水位还低时不至于每几分钟重启一次)', async () => {
  let up = 120
  const events = []
  const logs = []
  const dog = createMemoryWatchdog({ limitMb: 300, checks: 2, memoryUsage: () => ({ rss: 400 * MB }), uptime: () => up, onExceed: async (e) => { events.push(e) }, log: (m) => logs.push(m) })
  await dog.tick()
  const r = await dog.tick()
  assert.equal(r.tooYoung, true)
  assert.equal(events.length, 0)
  assert.ok(logs.some((m) => /不自动重启/.test(m)))
  up = 900
  await dog.tick()
  assert.equal(events.length, 1, '跑满 10 分钟仍超限才重启')
})

