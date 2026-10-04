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
