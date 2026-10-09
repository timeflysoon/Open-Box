import assert from 'node:assert/strict'
import test from 'node:test'
import { createLatencyProbeCoordinator } from './latency-probe-coordinator.mjs'

test('共享节点使用所有组中最短 interval,长周期组复用短周期结果', async () => {
  let clock = 0
  let calls = 0
  const c = createLatencyProbeCoordinator({ now: () => clock })
  c.register('auto', 'node', 'https://test', 2 * 60_000)
  c.register('failover', 'node', 'https://test', 5 * 60_000)
  const run = () => { calls += 1; return { ok: true, delay: 120, at: clock } }

  await c.request({ tag: 'node', url: 'https://test', run })
  clock = 60_000
  assert.equal((await c.request({ tag: 'node', url: 'https://test', run })).reused, true)
  clock = 2 * 60_000
  assert.equal((await c.request({ tag: 'node', url: 'https://test', run })).reused, false)
  clock = 3 * 60_000
  assert.equal((await c.request({ tag: 'node', url: 'https://test', run })).reused, true)
  assert.equal(calls, 2)
})

test('不同测速地址不共享结果,同一地址并发只发一个请求', async () => {
  let clock = 0
  let calls = 0
  const c = createLatencyProbeCoordinator({ now: () => clock })
  const run = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 2))
    return { ok: true, delay: 100, at: clock }
  }
  const a = c.request({ tag: 'node', url: 'https://a', run })
  const b = c.request({ tag: 'node', url: 'https://a', run })
  const d = c.request({ tag: 'node', url: 'https://b', run })
  await Promise.all([a, b, d])
  assert.equal(calls, 2)
})

test('force 只绕过缓存,仍与并发复查共享一个请求', async () => {
  let clock = 0
  let calls = 0
  const c = createLatencyProbeCoordinator({ now: () => clock })
  c.register('failover', 'node', 'https://test', 5 * 60_000)
  const run = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 2))
    return { ok: false, delay: 0, reason: 'probe-timeout', at: clock }
  }
  await c.request({ tag: 'node', url: 'https://test', run })
  const a = c.request({ tag: 'node', url: 'https://test', run, force: true })
  const b = c.request({ tag: 'node', url: 'https://test', run, force: true })
  await Promise.all([a, b])
  assert.equal(calls, 2)
})

test('经名额排队:更急的调用方加入还在排队的同一个请求,把它挪到自己那一档', async () => {
  const { createProbeLimiter } = await import('./probe-limiter.mjs')
  const limiter = createProbeLimiter({ limit: 1 })
  const c = createLatencyProbeCoordinator({ now: () => 0, limiter })
  const order = []
  let releaseFirst
  const blocker = c.request({ tag: 'busy', url: 'https://t', run: () => new Promise((r) => { releaseFirst = () => r({ ok: true, delay: 1, at: 0 }) }), priority: 'interactive' })
  const bg = c.request({ tag: 'node', url: 'https://t', run: async () => { order.push('node'); return { ok: true, delay: 5, at: 0 } }, priority: 'background' })
  const other = c.request({ tag: 'other', url: 'https://t', run: async () => { order.push('other'); return { ok: true, delay: 5, at: 0 } }, priority: 'interactive' })
  // 复查(critical)加入还在后台队里的 node:挪到最前
  const recheck = c.request({ tag: 'node', url: 'https://t', run: async () => { order.push('dup'); return null }, priority: 'critical', force: true })
  await new Promise((r) => setImmediate(r))
  releaseFirst()
  await Promise.all([blocker, bg, other, recheck])
  assert.deepEqual(order, ['node', 'other'], '同一个请求只测一次,挪到 critical 后排在 interactive 前面')
  assert.equal((await recheck).reused, true)
})

test('探测本身出了问题(ok: null)不进时间线:下一个请求照常真测,不复用「未知」', async () => {
  let calls = 0
  const c = createLatencyProbeCoordinator({ now: () => 1000 })
  c.register('failover', 'node', 'https://t', 300_000)
  const run = async () => { calls += 1; return calls === 1 ? { ok: null, at: 1000, reason: 'probe-timeout' } : { ok: true, delay: 90, at: 1000 } }
  assert.equal((await c.request({ tag: 'node', url: 'https://t', run })).ok, null)
  const second = await c.request({ tag: 'node', url: 'https://t', run })
  assert.equal(second.ok, true)
  assert.equal(calls, 2)
})

test('取消:等这个请求的调用方都退出了,还在排队的撤掉;还有人在等就不撤', async () => {
  const { createProbeLimiter } = await import('./probe-limiter.mjs')
  const limiter = createProbeLimiter({ limit: 1 })
  const c = createLatencyProbeCoordinator({ now: () => 0, limiter })
  let releaseFirst
  const blocker = c.request({ tag: 'busy', url: 'https://t', run: () => new Promise((r) => { releaseFirst = () => r({ ok: true, delay: 1, at: 0 }) }) })
  let ran = 0
  const run = async () => { ran += 1; return { ok: true, delay: 7, at: 0 } }
  const a = new AbortController()
  const b = new AbortController()
  const first = c.request({ tag: 'node', url: 'https://t', run, signal: a.signal })
  const second = c.request({ tag: 'node', url: 'https://t', run, signal: b.signal })
  a.abort()
  assert.equal((await first).reason, 'cancelled')
  assert.equal(limiter.stats().interactive, 1, '还有人在等,请求留在队里')
  b.abort()
  assert.equal((await second).reason, 'cancelled')
  assert.equal(limiter.stats().interactive, 0, '都退出了:撤掉')
  releaseFirst()
  await blocker
  assert.equal(ran, 0)
  // 撤掉以后再来的调用方照常发起新请求
  assert.equal((await c.request({ tag: 'node', url: 'https://t', run })).delay, 7)
})

test('每秒要测几个:每个「节点 + 地址」按所有使用者里最短的间隔算一次', () => {
  const c = createLatencyProbeCoordinator()
  c.register('auto', 'n1', 'https://a', 120_000)
  c.register('failover', 'n1', 'https://a', 300_000)
  c.register('failover', 'n1', 'https://b', 300_000)
  c.register('failover', 'n2', 'https://b', 60_000)
  assert.ok(Math.abs(c.demandPerSec() - (1 / 120 + 1 / 300 + 1 / 60)) < 1e-9)
})
