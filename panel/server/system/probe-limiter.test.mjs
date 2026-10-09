import assert from 'node:assert/strict'
import test from 'node:test'
import { createProbeLimiter } from './probe-limiter.mjs'

// 一个可控的测速:started 记下开始顺序,finish(name) 让它结束
const harness = (limiter) => {
  const started = []
  const finishers = new Map()
  const job = (priority, name, opts) => limiter.schedule(priority, () => new Promise((resolve) => {
    started.push(name)
    finishers.set(name, () => resolve(name))
  }), opts)
  const finish = async (name) => { finishers.get(name)(); await new Promise((r) => setImmediate(r)) }
  return { started, job, finish }
}
const tick = () => new Promise((r) => setImmediate(r))

test('同一时刻最多 limit 个在测;空出来的名额 critical → interactive → background,同一档先来先测', async () => {
  const limiter = createProbeLimiter({ limit: 2 })
  const h = harness(limiter)
  h.job('interactive', 'i1'); h.job('interactive', 'i2')
  h.job('interactive', 'i3'); h.job('critical', 'c1'); h.job('critical', 'c2')
  await tick()
  assert.deepEqual(h.started, ['i1', 'i2'])
  assert.deepEqual(limiter.stats(), { limit: 2, running: 2, critical: 2, interactive: 1, background: 0 })
  await h.finish('i1')
  assert.deepEqual(h.started, ['i1', 'i2', 'c1'])
  await h.finish('i2')
  await h.finish('c1')
  assert.deepEqual(h.started, ['i1', 'i2', 'c1', 'c2', 'i3'])
})

test('后台:和 interactive 都在等时至少拿到 1 个,最多占一半名额;没人跟它抢时也不超过一半', async () => {
  const limiter = createProbeLimiter({ limit: 4 })
  const h = harness(limiter)
  for (let i = 1; i <= 4; i++) h.job('background', `b${i}`)
  await tick()
  assert.deepEqual(h.started, ['b1', 'b2'], '后台最多 2 个(4 个的一半)')
  for (let i = 1; i <= 4; i++) h.job('interactive', `i${i}`)
  await tick()
  assert.deepEqual(h.started, ['b1', 'b2', 'i1', 'i2'])
  // b1 测完:后台还有 1 个在跑(b2),空出来的给 interactive
  await h.finish('b1')
  assert.equal(h.started.at(-1), 'i3')
  // b2 测完:后台一个都不在跑了,interactive 还有人等也先给后台一个,不让定时测速饿死
  await h.finish('b2')
  assert.equal(h.started.at(-1), 'b3')
})

test('bump:还在排队的挪到更急的一档;signal 中止:还在排队的退出(以 cancelled 拒绝),已经开始的照常跑完', async () => {
  const limiter = createProbeLimiter({ limit: 1 })
  const h = harness(limiter)
  h.job('interactive', 'run')
  const b = h.job('background', 'bg')
  h.job('interactive', 'i')
  const controller = new AbortController()
  const gone = h.job('interactive', 'gone', { signal: controller.signal })
  b.bump('critical')
  controller.abort()
  await assert.rejects(gone.result, (err) => err.cancelled === true)
  assert.deepEqual(limiter.stats(), { limit: 1, running: 1, critical: 1, interactive: 1, background: 0 })
  await h.finish('run')
  assert.equal(h.started.at(-1), 'bg', '挪到 critical 的后台测速先测')
  await h.finish('bg')
  await h.finish('i')
  assert.deepEqual(h.started, ['run', 'bg', 'i'])
  // 已经开始的,中止信号不打断它
  const c2 = new AbortController()
  const running = h.job('interactive', 'r2', { signal: c2.signal })
  await tick()
  c2.abort()
  await h.finish('r2')
  assert.equal(await running.result, 'r2')
})

test('吞吐:最近 10 分钟每秒测完几个;刚开始不到 1 分钟不下结论', async () => {
  let clock = 0
  const limiter = createProbeLimiter({ limit: 4, now: () => clock })
  for (let i = 0; i < 10; i++) await limiter.run('interactive', async () => { clock += 1000 })
  assert.equal(limiter.throughput(), null)
  for (let i = 0; i < 110; i++) await limiter.run('interactive', async () => { clock += 1000 })
  assert.ok(Math.abs(limiter.throughput() - 1) < 0.05, String(limiter.throughput()))
})
