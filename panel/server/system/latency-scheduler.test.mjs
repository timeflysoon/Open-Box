import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { createLatencyHistory } from './latency-history.mjs'
import { createLatencyProbeCoordinator } from './latency-probe-coordinator.mjs'
import { createLatencyScheduler, parseDuration } from './latency-scheduler.mjs'
import { createProbeLimiter } from './probe-limiter.mjs'

const paths = createPaths('/opt/open-box')
const memStore = () => {
  const m = new Map()
  return { getRaw: (k) => (m.has(k) ? m.get(k) : null), setRaw: (k, v) => m.set(k, v), delRaw: (k) => m.delete(k), getClashSecret: () => 's' }
}
const T0 = Date.parse('2026-09-06T18:03:24+08:00')
const iso = (t) => new Date(t).toISOString()
const config = { outbounds: [
  { type: 'urltest', tag: '香港-自动', url: 'https://www.gstatic.com/generate_204', interval: '5m', outbounds: ['hk-1', 'hk-2', 'hk-3'] },
  { type: 'urltest', tag: '所有-自动', url: 'https://www.gstatic.com/generate_204', interval: '5m', outbounds: ['hk-1', 'us-1'] },
  { type: 'selector', tag: '国外', outbounds: ['香港-自动'] },
] }

test('parseDuration:sing-box 的时长写法', () => {
  assert.equal(parseDuration('5m'), 300_000)
  assert.equal(parseDuration('1h30m'), 5_400_000)
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration('250ms'), 250)
  assert.equal(parseDuration(''), 0)
  assert.equal(parseDuration('abc'), 0)
})

// 一个可变的"内核":/proxies 返回当前 history;单节点测速接口 /proxies/<节点>/delay 像 sing-box 一样:force=false 时
// interval 内测过的直接复用;hk-3 一直超时(504,history 清空),别的成功(写 history)
const kernel = () => {
  const proxies = {
    'hk-1': { type: 'ss', history: [{ time: iso(T0), delay: 93 }] },
    'hk-2': { type: 'ss', history: [{ time: iso(T0), delay: 113 }] },
    'hk-3': { type: 'ss', history: [] },                  // 启动时就超时,一直没结果
    'us-1': { type: 'ss', history: [{ time: iso(T0), delay: 376 }] },
    '香港-自动': { type: 'URLTest', all: ['hk-1', 'hk-2', 'hk-3'], now: 'hk-1', history: [{ time: iso(T0), delay: 93 }] },
  }
  const calls = []
  let clock = T0
  const down = new Set(['hk-3'])
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const fetchImpl = async (url) => {
    const u = String(url)
    calls.push(u)
    const m = u.match(/\/proxies\/([^/?]+)\/delay\?(.*)$/)
    if (m) {
      const tag = decodeURIComponent(m[1])
      if (!proxies[tag]) return json(404, { message: 'Proxy not found' })
      if (down.has(tag)) { proxies[tag].history = []; return json(504, { message: 'Timeout', error: 'context deadline exceeded', time: iso(clock), reused: false }) }
      const delay = 100 + tag.length
      proxies[tag].history = [{ time: iso(clock), delay }]
      return json(200, { delay, time: iso(clock), reused: false })
    }
    if (u.endsWith('/proxies')) return json(200, { proxies: JSON.parse(JSON.stringify(proxies)) })
    throw new Error('unexpected ' + u)
  }
  const delayCalls = () => calls.filter((u) => u.includes('/delay?'))
  const probed = () => delayCalls().map((u) => decodeURIComponent(u.match(/\/proxies\/([^/?]+)\/delay/)[1]))
  return { proxies, calls, down, fetchImpl, delayCalls, probed, setClock: (t) => { clock = t }, now: () => clock }
}
const ctxWithKernel = (startedAt, cfg = config) => {
  const upSeconds = 1000
  return createMockContext({
    files: { [paths.configPath]: JSON.stringify(cfg), '/proc/123/stat': `123 (sing-box) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${Math.round((upSeconds - (Date.now() - startedAt) / 1000) * 100)} 0`, '/proc/uptime': `${upSeconds} 0` },
    execResults: { 'pidof sing-box': { code: 0, stdout: '123\n' } },
  })
}

test('到 interval 才测:成员最近一轮结果还新鲜就不发;到点逐个测,成功的记新结果、内核答失败的记超时', async () => {
  const k = kernel()
  const store = memStore()
  const history = createLatencyHistory({ store, now: k.now })
  const ctx = ctxWithKernel(T0 - 60_000)
  const s = createLatencyScheduler({ store, ctx, paths, history, fetchImpl: k.fetchImpl, now: k.now, log: () => {} })
  // 启动后 1 分钟:有结果的成员还新鲜;hk-3 启动时就没结果、我们也没测过 → 立刻补测一次,内核答超时 → 记超时
  k.setClock(T0 + 60_000)
  const r1 = await s.tick()
  assert.deepEqual(r1.tested, ['香港-自动'])
  assert.deepEqual(r1.timeouts, ['hk-3'])
  assert.deepEqual(k.probed(), ['hk-3'])
  assert.deepEqual(history.get()['hk-1'].map((x) => x.delay), [93])
  assert.deepEqual(history.get()['hk-3'].map((x) => x.delay), [0])
  // 5 分钟后:有结果的成员到点;hk-1 两组共用、同一个测速地址,只测一次;hk-3 一分钟前刚测过,这轮不算到点
  k.setClock(T0 + 5 * 60_000 + 1000)
  const r2 = await s.tick()
  assert.deepEqual(r2.tested, ['香港-自动', '所有-自动'])
  assert.deepEqual(k.probed().slice(1).sort(), ['hk-1', 'hk-2', 'us-1'])
  // timeout 是每个成员自己的超时,跟面板「测速超时」设置走,没设就是 5 秒;force=false、后台那一档
  const hk1 = k.delayCalls().find((u) => u.includes('/proxies/hk-1/delay'))
  assert.ok(hk1.includes('url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000&force=false&interval=300000&priority=background'), hk1)
  assert.deepEqual(history.get()['hk-1'].map((x) => x.delay), [93, 104])
  assert.deepEqual(history.get()['hk-3'].map((x) => x.delay), [0])
  assert.deepEqual(r2.timeouts, [])
  // 再过 1 分钟(T0+6m):hk-1 / hk-2 刚测过不动;hk-3 上次是 T0+1m 测的,正好 5 分钟到点 → 只测它,
  // 连续超时第二笔也要记(和上一笔隔了 5 分钟,不算重复)
  k.setClock(T0 + 6 * 60_000)
  const r3 = await s.tick()
  assert.deepEqual(r3.tested, ['香港-自动'])
  assert.deepEqual(r3.timeouts, ['hk-3'])
  assert.equal(k.probed().length, 5)
  assert.deepEqual(history.get()['hk-3'].map((x) => x.delay), [0, 0])
  // T0+10m:hk-1 / hk-2 / us-1 到点,hk-3 才 4 分钟不到点
  k.setClock(T0 + 10 * 60_000 + 2000)
  const r4 = await s.tick()
  assert.deepEqual(r4.tested, ['香港-自动', '所有-自动'])
  assert.deepEqual(r4.timeouts, [])
  assert.deepEqual(history.get()['hk-3'].map((x) => x.delay), [0, 0])
  assert.equal(history.get()['hk-1'].length, 3)
  assert.ok(!k.calls.some((u) => u.includes('/group/')), '不再调组测速接口')
})

test('内核没在跑（/proxies 拿不到）→ 这个 tick 什么都不做;sync 只读不测', async () => {
  const store = memStore()
  const history = createLatencyHistory({ store })
  const ctx = ctxWithKernel(Date.now() - 10_000)
  const down = createLatencyScheduler({ store, ctx, paths, history, fetchImpl: async () => { throw new Error('ECONNREFUSED') }, log: () => {} })
  assert.deepEqual(await down.tick(), { skipped: 'kernel' })
  const k = kernel()
  const up = createLatencyScheduler({ store, ctx, paths, history, fetchImpl: k.fetchImpl, now: k.now, log: () => {} })
  k.setClock(T0 + 60_000)
  await up.sync()
  assert.deepEqual(history.get()['hk-1'].map((x) => x.delay), [93])
  assert.deepEqual(k.delayCalls(), [])
})

test('测速请求没等到结果(超时 / 断开)→ 不把它记成超时;tick 叠着来时后一个直接跳过;这轮记过账,30 秒后不原样重发', async () => {
  const store = memStore()
  const history = createLatencyHistory({ store })
  const ctx = ctxWithKernel(T0 - 60_000, { outbounds: [{ type: 'urltest', tag: 'G', url: 'https://t', interval: '5m', outbounds: ['hk-1', 'hk-2'] }] })
  let release
  const gate = new Promise((r) => { release = r })
  const proxies = { 'hk-1': { type: 'ss', history: [] }, 'hk-2': { type: 'ss', history: [] } }
  let delayCalls = 0
  const fetchImpl = async (url) => {
    if (String(url).includes('/delay?')) {
      delayCalls += 1
      // 测速:挂住,直到外面放行才失败(模拟请求中断)
      await gate
      const err = new Error('aborted'); err.name = 'AbortError'; throw err
    }
    return { ok: true, status: 200, json: async () => ({ proxies }) }
  }
  let clock = T0 + 10 * 60_000
  const s = createLatencyScheduler({ store, ctx, paths, history, fetchImpl, now: () => clock, log: () => {} })
  const first = s.tick()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(await s.tick(), { skipped: 'busy' })
  release()
  const r = await first
  assert.deepEqual(r.tested, ['G'])
  assert.deepEqual(r.timeouts, [])
  assert.equal(history.get()['hk-1'], undefined)
  assert.equal(delayCalls, 2)
  // 以前掐断的那轮不记账,30 秒后原样再发;现在到下一个 interval 才再测
  clock += 30_000
  const again = await s.tick()
  assert.deepEqual(again.tested, [])
  assert.equal(delayCalls, 2)
  clock += 5 * 60_000
  await s.tick()
  assert.equal(delayCalls, 4)
})

test('到点按成员算:共用的成员刚被前一个组测过就不算,组里另一个成员到点照样测;一轮里靠后测到的成员在自己到点时补测', async () => {
  const k = kernel()
  const store = memStore()
  const history = createLatencyHistory({ store, now: k.now })
  const ctx = ctxWithKernel(T0 - 60_000)
  const s = createLatencyScheduler({ store, ctx, paths, history, fetchImpl: k.fetchImpl, now: k.now, log: () => {} })
  // 把 us-1 的上次结果改成比别人晚 2 分钟测的
  k.proxies['us-1'].history = [{ time: iso(T0 + 2 * 60_000), delay: 300 }]
  k.setClock(T0 + 5 * 60_000 + 1000)
  const r1 = await s.tick()
  // 香港的到点(hk-3 没结果也到点);所有-自动里 hk-1 和香港共用、这轮一起测了,us-1 才 3 分钟 → 所有-自动也算测到了(hk-1)
  assert.deepEqual(r1.tested, ['香港-自动', '所有-自动'])
  assert.ok(!k.probed().includes('us-1'))
  k.setClock(T0 + 7 * 60_000 + 1000)
  const r2 = await s.tick()
  // us-1 到点了(5 分钟),只测它
  assert.deepEqual(r2.tested, ['所有-自动'])
  assert.equal(k.probed().filter((t) => t === 'us-1').length, 1)
  assert.deepEqual(history.get()['us-1'].map((x) => x.delay), [300, 104])
  assert.equal(history.get()['hk-1'].length, 2)
})

test('同一个节点几个组都到点、测速地址一样:这一轮只测一次', async () => {
  const cfg = { outbounds: [
    { type: 'urltest', tag: 'A', url: 'https://t', interval: '5m', outbounds: ['shared'] },
    { type: 'urltest', tag: 'B', url: 'https://t', interval: '5m', outbounds: ['shared'] },
    { type: 'urltest', tag: 'C', url: 'https://other', interval: '5m', outbounds: ['shared'] },
  ] }
  const proxies = { shared: { type: 'vless', history: [{ time: iso(T0), delay: 181 }] } }
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/delay?')) return { ok: true, status: 200, json: async () => ({ delay: 184, time: iso(T0 + 5 * 60_000 + 30_000) }) }
    return { ok: true, status: 200, json: async () => ({ proxies: JSON.parse(JSON.stringify(proxies)) }) }
  }
  const store = memStore()
  const now = () => T0 + 5 * 60_000 + 30_000
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(T0 - 60_000, cfg), paths, history: createLatencyHistory({ store, now }), fetchImpl, now, log: () => {} })
  const result = await s.tick()
  assert.deepEqual(result.tested, ['A', 'B', 'C'])
  const delays = calls.filter((u) => u.includes('/delay?'))
  assert.equal(delays.length, 2, '地址一样的 A / B 合成一次,地址不同的 C 另测')
  assert.ok(delays.some((u) => u.includes('url=https%3A%2F%2Ft&')) && delays.some((u) => u.includes('url=https%3A%2F%2Fother&')))
})

test('嵌套组按叶子节点去重:前一个组测过后,后一个组不重复测同一节点', async () => {
  const cfg = { outbounds: [
    { type: 'urltest', tag: 'inner', url: 'https://t', interval: '5m', outbounds: ['shared'] },
    { type: 'urltest', tag: 'outer', url: 'https://t', interval: '5m', outbounds: ['inner'] },
  ] }
  const proxies = {
    shared: { type: 'vless', history: [{ time: iso(T0), delay: 181 }] },
    inner: { type: 'URLTest', all: ['shared'], now: 'shared', history: [] },
    outer: { type: 'URLTest', all: ['inner'], now: 'inner', history: [] },
  }
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/delay?')) return { ok: true, status: 200, json: async () => ({ delay: 180 }) }
    return { ok: true, status: 200, json: async () => ({ proxies: JSON.parse(JSON.stringify(proxies)) }) }
  }
  const store = memStore()
  const now = () => T0 + 5 * 60_000 + 30_000
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(T0 - 60_000, cfg), paths, history: createLatencyHistory({ store, now }), fetchImpl, now, log: () => {} })
  await s.tick()
  const delays = calls.filter((u) => u.includes('/delay?'))
  assert.equal(delays.length, 1)
  assert.ok(delays[0].includes('/proxies/shared/delay'))
})

test('组配置里的测速地址是 http:// 的,发给内核的测速请求保留 HTTP;组写了可接受状态码的带 expected', async () => {
  const httpConfig = { outbounds: [
    { type: 'urltest', tag: 'CF', url: 'http://cp.cloudflare.com/generate_204', interval: '5m', outbounds: ['cf-1'] },
    { type: 'urltest', tag: '旧默认', url: 'http://www.gstatic.com/generate_204', interval: '5m', expected_status: '204', outbounds: ['cf-2'] },
  ] }
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/delay?')) return { ok: true, status: 200, json: async () => ({ delay: 50 }) }
    return { ok: true, status: 200, json: async () => ({ proxies: { 'cf-1': { type: 'vless', history: [] }, 'cf-2': { type: 'vless', history: [] } } }) }
  }
  const store = memStore()
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(T0 - 60_000, httpConfig), paths, history: createLatencyHistory({ store, now: () => T0 + 60_000 }), fetchImpl, now: () => T0 + 60_000, log: () => {} })
  await s.tick()
  const delays = calls.filter((u) => u.includes('/delay?'))
  assert.equal(delays.length, 2)
  const cf1 = delays.find((u) => u.includes('/proxies/cf-1/delay'))
  const cf2 = delays.find((u) => u.includes('/proxies/cf-2/delay'))
  assert.ok(cf1.includes('url=http%3A%2F%2Fcp.cloudflare.com%2Fgenerate_204&') && !cf1.includes('expected='), cf1)
  assert.ok(cf2.includes('url=http%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&') && cf2.includes('&expected=204'), cf2)
})

test('成员超时跟面板「测速超时」设置走:表里 config/speedtest-timeout 是 8000 就传 8000;不合法回落 5000', async () => {
  const k = kernel()
  const store = memStore()
  store.setRaw('config/speedtest-timeout', '8000')
  const history = createLatencyHistory({ store, now: k.now })
  const ctx = ctxWithKernel(T0 - 60_000)
  const s = createLatencyScheduler({ store, ctx, paths, history, fetchImpl: k.fetchImpl, now: k.now, log: () => {} })
  k.setClock(T0 + 60_000)
  await s.tick()
  assert.ok(k.delayCalls().some((u) => u.includes('&timeout=8000&')), k.delayCalls().join('\n'))
  store.setRaw('config/speedtest-timeout', 'abc')
  k.setClock(T0 + 6 * 60_000)
  await s.tick()
  assert.ok(k.delayCalls().some((u) => u.includes('&timeout=5000&')))
})

test('经共享协调器和全局名额:结果进共享时间线(失败也进,故障转移据此判断);同时在测的不超过名额里后台那一档', async () => {
  const cfg = { outbounds: [{ type: 'urltest', tag: '大组', url: 'https://t', interval: '5m', outbounds: Array.from({ length: 12 }, (_, i) => `n${i}`) }] }
  const proxies = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`n${i}`, { type: 'ss', history: [] }]))
  let running = 0
  let peak = 0
  const fetchImpl = async (url) => {
    const u = String(url)
    const m = u.match(/\/proxies\/([^/?]+)\/delay\?/)
    if (m) {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running -= 1
      return m[1] === 'n3' ? { ok: false, status: 503, json: async () => ({ message: 'error', error: 'unexpected status 404', time: iso(T0) }) } : { ok: true, status: 200, json: async () => ({ delay: 80, time: iso(T0) }) }
    }
    return { ok: true, status: 200, json: async () => ({ proxies }) }
  }
  const limiter = createProbeLimiter({ limit: 4 })
  const coordinator = createLatencyProbeCoordinator({ now: () => T0, limiter })
  const store = memStore()
  const history = createLatencyHistory({ store, now: () => T0 })
  const s = createLatencyScheduler({ store, ctx: ctxWithKernel(T0 - 60_000, cfg), paths, history, fetchImpl, now: () => T0, probeCoordinator: coordinator, log: () => {} })
  const r = await s.tick()
  assert.deepEqual(r.timeouts, ['n3'])
  assert.equal(peak, 2, '后台那一档最多占一半名额(4 个里 2 个)')
  assert.equal(coordinator.latest('n3', 'https://t').ok, false)
  assert.equal(coordinator.latest('n0', 'https://t').ok, true)
})
