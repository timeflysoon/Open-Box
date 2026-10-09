// 故障转移管理器的调度(GitHub #514):各组的轮次各跑各的、首轮错开、全局测速名额、刷新 / 重新检测立刻生效、
// 进了兜底拒绝每分钟复查候选。判断本身的用例在 failover-manager.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { configMetaPath } from './deploy.mjs'
import { createFailoverManager, FIRST_ROUND_STAGGER_MS } from './failover-manager.mjs'
import { createLatencyProbeCoordinator } from './latency-probe-coordinator.mjs'
import { createProbeLimiter } from './probe-limiter.mjs'
import { fetchJson } from './fetch-json.mjs'
import { REJECT_RETRY_MS } from '../engine/failover-core.mjs'

const paths = createPaths('/opt/open-box')
const T0 = Date.parse('2026-10-09T20:00:00+08:00')
const URL = 'https://www.gstatic.com/generate_204'
const iso = (t) => new Date(t).toISOString()
const settle = () => new Promise((r) => setTimeout(r, 5))
const until = async (cond, what = 'condition') => {
  const deadline = Date.now() + 3000
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

const memStore = () => {
  const m = new Map()
  return { getRaw: (k) => (m.has(k) ? m.get(k) : null), setRaw: (k, v) => m.set(k, v), delRaw: (k) => m.delete(k), getClashSecret: () => 's' }
}

// 组定义:lanes = [[节点...], ...];一个节点的页签是单节点页签,多个节点是内部 urltest 子组
const groupDef = (id, lanes, settings = {}) => ({
  id, tag: `组${id}`, rejectTag: '拒绝',
  lanes: lanes.map((members, i) => (members.length > 1
    ? { id: `L${i}`, name: '', index: i, members, valid: members, mode: 'urltest', ref: `__fo:${id}:L${i}`, subTag: `__fo:${id}:L${i}` }
    : { id: `L${i}`, name: '', index: i, members, valid: members, mode: 'single', ref: members[0], subTag: null })),
  settings: { intervalMs: 30_000, testUrl: URL, timeoutMs: 1000, restorePrimary: true, recoveryHoldMs: 60_000, ...settings },
})

// 可控的假内核:节点 up / down / { status, error } / 挂住(gate);记下每个测速请求和同时在测的峰值
const fakeKernel = (defs, clock) => {
  const proxies = { '拒绝': { type: 'Reject', history: [] } }
  for (const d of defs) {
    for (const lane of d.lanes) {
      for (const n of lane.valid) proxies[n] = proxies[n] || { type: 'ss', history: [] }
      if (lane.subTag) proxies[lane.subTag] = { type: 'URLTest', all: [...lane.valid], now: lane.valid[0], history: [] }
    }
    proxies[d.tag] = { type: 'Selector', all: [...d.lanes.map((l) => l.ref), '拒绝'], now: d.lanes[0].ref, history: [] }
  }
  const behavior = new Map()
  const gates = new Map()
  const probes = []
  let inflight = 0
  let peak = 0
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const fetchImpl = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:9095', '')
    const path = decodeURIComponent(u)
    let m
    if ((m = path.match(/^\/proxies\/([^/?]+)\/delay\?(.*)$/))) {
      const tag = m[1]
      const q = new URLSearchParams(u.split('?')[1])
      probes.push({ tag, force: q.get('force') === 'true', since: Number(q.get('since') || 0), priority: q.get('priority') })
      inflight += 1
      peak = Math.max(peak, inflight)
      try {
        if (gates.has(tag)) await gates.get(tag).promise
        await settle()
        const b = behavior.get(tag) || 'up'
        if (b === 'up') {
          proxies[tag].history = [{ time: iso(clock()), delay: 100 }]
          return json(200, { delay: 100, time: iso(clock()), reused: false })
        }
        proxies[tag].history = []
        if (typeof b === 'object') return json(b.status, { message: 'error', error: b.error, time: iso(clock()), reused: false })
        return json(504, { message: 'Timeout', error: 'context deadline exceeded', time: iso(clock()), reused: false })
      } finally { inflight -= 1 }
    }
    if (path === '/proxies') return json(200, { proxies: JSON.parse(JSON.stringify(proxies)) })
    if ((m = path.match(/^\/group\/([^/?]+)\/delay\?/))) {
      const g = proxies[m[1]]
      const best = g.all.find((n) => proxies[n].history.length)
      if (best) g.now = best
      return json(200, {})
    }
    if ((m = path.match(/^\/proxies\/([^/?]+)$/))) {
      const p = proxies[m[1]]
      if (!p) return json(404, {})
      if (init.method === 'PUT') { p.now = JSON.parse(init.body).name; return json(204, {}) }
      return json(200, JSON.parse(JSON.stringify(p)))
    }
    throw new Error('unexpected ' + path)
  }
  const hang = (tag) => {
    let release
    const promise = new Promise((r) => { release = r })
    gates.set(tag, { promise, release: () => { gates.delete(tag); release() } })
    return gates.get(tag).release
  }
  return { proxies, behavior, probes, fetchImpl, hang, peak: () => peak, parentNow: (tag) => proxies[tag].now }
}

const setup = (defs, { limit = 4, coordinator = false, tickMs = 5000 } = {}) => {
  let clock = T0
  const k = fakeKernel(defs, () => clock)
  const ctx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify({ generatedAt: 'v1', failover: defs }) }, execResults: { 'pidof sing-box': { code: 1 } } })
  const limiter = createProbeLimiter({ limit, now: () => clock })
  const probeCoordinator = coordinator ? createLatencyProbeCoordinator({ now: () => clock, limiter }) : null
  const logs = []
  const mgr = createFailoverManager({ store: memStore(), ctx, paths, fetchImpl: k.fetchImpl, now: () => clock, limiter, probeCoordinator, tickMs, log: (m) => logs.push(m) })
  return { k, mgr, limiter, logs, advance: (ms) => { clock += ms }, clock: () => clock, ctx }
}
const groupOf = (mgr, tag) => mgr.status().groups.find((g) => g.tag === tag)

test('部署后各组按先后错开 2 秒开始,不再同一个 tick 齐发', async () => {
  const defs = [groupDef('a', [['n1']]), groupDef('b', [['n2']]), groupDef('c', [['n3']])]
  const { k, mgr, advance } = setup(defs)
  const r1 = await mgr.tick()
  assert.deepEqual(Object.keys(r1.ran), ['组a'])
  assert.deepEqual(k.probes.map((p) => p.tag), ['n1'])
  assert.equal(groupOf(mgr, '组b').nextRoundAt - T0, FIRST_ROUND_STAGGER_MS)
  assert.equal(groupOf(mgr, '组c').nextRoundAt - T0, 2 * FIRST_ROUND_STAGGER_MS)
  advance(FIRST_ROUND_STAGGER_MS)
  assert.deepEqual(Object.keys((await mgr.tick()).ran), ['组b'])
  advance(FIRST_ROUND_STAGGER_MS)
  assert.deepEqual(Object.keys((await mgr.tick()).ran), ['组c'])
})

test('一个组的轮次卡住,别的组照常按自己的间隔进下一轮(派发不等轮次跑完);它放行后自己跑完', async () => {
  const defs = [groupDef('a', [['n1']]), groupDef('b', [['n2']])]
  const { k, mgr, advance } = setup(defs, { tickMs: 1 })
  const release = k.hang('n1')
  mgr.start()
  try {
    await until(() => k.probes.some((p) => p.tag === 'n1'), 'group a probing')
    advance(FIRST_ROUND_STAGGER_MS)
    await until(() => groupOf(mgr, '组b')?.status === 'ok', 'group b first round')
    assert.equal(groupOf(mgr, '组a').inFlight, true)
    // b 到下一轮(30 秒)照常再测;a 还卡着
    advance(30_000)
    await until(() => k.probes.filter((p) => p.tag === 'n2').length >= 2, 'group b second round')
    assert.equal(groupOf(mgr, '组a').inFlight, true)
    assert.equal(k.probes.filter((p) => p.tag === 'n1').length, 1, '卡住的组不叠着再开一轮')
    release()
    await until(() => groupOf(mgr, '组a').status === 'ok', 'group a finishes')
  } finally { mgr.stop() }
})

test('全局名额:3 个组各 6 个节点同时到点,同时在内核那边的测速不超过名额(以前每组 4 个、合起来 12 个)', async () => {
  const nodes = (p) => Array.from({ length: 6 }, (_, i) => `${p}${i}`)
  const defs = [groupDef('a', [nodes('a')]), groupDef('b', [nodes('b')]), groupDef('c', [nodes('c')])]
  const { k, mgr, advance } = setup(defs, { limit: 4 })
  await mgr.tick() // 载入映射,第一个组先跑
  advance(2 * FIRST_ROUND_STAGGER_MS)
  const r = await mgr.tick()
  assert.deepEqual(Object.keys(r.ran).sort(), ['组b', '组c'], '另外两个组同时到点')
  assert.equal(k.probes.length, 18)
  assert.equal(k.peak(), 4)
  for (const tag of ['组a', '组b', '组c']) assert.equal(groupOf(mgr, tag).status, 'ok')
})

test('刷新立刻生效:正在跑的那轮作废,还在排队的测速撤掉不发,马上开新一轮', async () => {
  const defs = [groupDef('a', [['n1', 'n2', 'n3', 'n4']])]
  const { k, mgr, limiter } = setup(defs, { limit: 1, tickMs: 1 })
  const release = k.hang('n1')
  mgr.start()
  try {
    await until(() => k.probes.length === 1 && limiter.stats().interactive === 3, 'round queued')
    mgr.refresh()
    await until(() => limiter.stats().interactive === 4, 'new round queued behind n1')
    assert.equal(k.probes.length, 1, '作废那轮排队的 n2..n4 没发出去')
    release()
    await until(() => groupOf(mgr, '组a').status === 'ok', 'new round done')
    const sent = k.probes.map((p) => p.tag)
    assert.equal(sent.filter((t) => t === 'n2').length, 1, '每个节点只测一次:作废那轮排队的撤了,新一轮才发')
  } finally { mgr.stop() }
})

test('重新检测:正在跑的作废,整组节点强制测(比点的那一刻新的才算)、排在 interactive 那一档', async () => {
  const defs = [groupDef('a', [['n1', 'n2'], ['n3']])]
  const { k, mgr, advance } = setup(defs)
  await mgr.tick()
  assert.equal(mgr.recheck('nope'), false)
  advance(1000)
  const at = T0 + 1000
  assert.equal(mgr.recheck('a'), true)
  assert.equal(groupOf(mgr, '组a').manualRecheck, true)
  k.probes.length = 0
  await mgr.tick()
  assert.deepEqual(k.probes.map((p) => [p.tag, p.force, p.since, p.priority]), [['n1', true, at, 'interactive'], ['n2', true, at, 'interactive'], ['n3', true, at, 'interactive']])
  assert.equal(groupOf(mgr, '组a').manualRecheck, false, '做完就回到平常')
  k.probes.length = 0
  advance(30_000)
  await mgr.tick()
  assert.ok(k.probes.every((p) => !p.force))
})

test('进了兜底拒绝:每分钟复查一次(不等整个间隔),每个页签只强制测一个候选;有候选通了马上切回(recovered)', async () => {
  const defs = [groupDef('a', [['a1', 'a2'], ['b1']], { intervalMs: 300_000 })]
  const { k, mgr, advance, clock } = setup(defs, { coordinator: true })
  await mgr.tick()
  for (const n of ['a1', 'a2', 'b1']) k.behavior.set(n, 'down')
  advance(300_000)
  await mgr.tick()
  advance(10_000)
  const r = await mgr.tick()
  assert.equal(r.ran['组a'].switched.to, '拒绝')
  assert.equal(groupOf(mgr, '组a').status, 'reject')
  assert.equal(groupOf(mgr, '组a').nextRoundAt - clock(), REJECT_RETRY_MS, '拒绝时 1 分钟后复查,不是 5 分钟')
  // 一分钟后:还没恢复 → 只测每个页签的一个候选(A 页签子组选中的 a1、单节点 b1),a2 不碰
  k.probes.length = 0
  advance(REJECT_RETRY_MS)
  await mgr.tick()
  assert.deepEqual(k.probes.map((p) => [p.tag, p.force]).sort(), [['a1', true], ['b1', true]])
  assert.equal(k.parentNow('组a'), '拒绝')
  // 再一分钟:b1 恢复了 → 切回 b1
  k.behavior.set('b1', 'up')
  advance(REJECT_RETRY_MS)
  const back = await mgr.tick()
  assert.equal(back.ran['组a'].switched.to, 'b1')
  assert.equal(groupOf(mgr, '组a').lastSwitch.reason, 'recovered')
  assert.equal(groupOf(mgr, '组a').nextRoundAt - clock(), 300_000, '切回以后回到正常间隔')
})

test('失败时内核回应里的原始报错(比如状态码不符)原样进状态,面板不用再测一次就能说清原因', async () => {
  const defs = [groupDef('a', [['n1']], { expectedStatus: '200-299' })]
  const { k, mgr } = setup(defs)
  k.behavior.set('n1', { status: 503, error: 'unexpected status 404' })
  await mgr.tick()
  const node = groupOf(mgr, '组a').lanes[0].nodes.n1
  assert.equal(node.ok, false)
  assert.equal(node.reason, 'failed')
  assert.equal(node.kind, 'status', '和手动测速同一套归类:状态码不符')
  assert.equal(node.error, 'unexpected status 404')
})

test('状态里有这一轮的进度和全局名额:正在跑的轮次测了几个 / 共几个,名额里在测 / 排队的个数', async () => {
  const defs = [groupDef('a', [['n1', 'n2', 'n3']])]
  const { k, mgr } = setup(defs, { limit: 1, tickMs: 1, coordinator: true })
  const release = k.hang('n1')
  mgr.start()
  try {
    await until(() => groupOf(mgr, '组a')?.round?.total === 3, 'round started')
    const g = groupOf(mgr, '组a')
    assert.deepEqual([g.round.done, g.round.total], [0, 3])
    assert.equal(mgr.status().probes.running, 1)
    assert.equal(mgr.status().probes.interactive, 2)
    assert.equal(typeof mgr.status().probes.demandPerSec, 'number')
    release()
    await until(() => groupOf(mgr, '组a').round === null && groupOf(mgr, '组a').status === 'ok', 'round done')
  } finally { mgr.stop() }
})

test('请求连同读回应正文一起受期限约束:回应头到了、正文一直不结束也会被打断', async () => {
  const hanging = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })
  const started = Date.now()
  await assert.rejects(fetchJson(hanging, 'http://x/', {}, 30), (err) => err.name === 'AbortError')
  assert.ok(Date.now() - started < 1000)
  const empty = await fetchJson(async () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError('no body') } }), 'http://x/', {}, 1000)
  assert.equal(empty.res.status, 204)
  assert.equal(empty.body, null)
})

test('拒绝状态下两次整组盘点之间的复查轮只测候选:别的节点结果过期了也不碰(不然要排在别的组积压的测速后面);到检测间隔照常整组盘点', async () => {
  const defs = [groupDef('a', [['a1', 'a2', 'a3'], ['b1']], { intervalMs: 300_000 })]
  const { k, mgr, advance } = setup(defs, { coordinator: true })
  await mgr.tick()
  for (const n of ['a1', 'a2', 'a3', 'b1']) k.behavior.set(n, 'down')
  advance(300_000)
  await mgr.tick()
  advance(10_000)
  await mgr.tick()
  assert.equal(groupOf(mgr, '组a').status, 'reject')
  // 拒绝后的第 1~4 分钟:每轮只有两个候选
  for (let i = 0; i < 4; i++) {
    k.probes.length = 0
    advance(REJECT_RETRY_MS)
    await mgr.tick()
    assert.deepEqual(k.probes.map((p) => p.tag).sort(), ['a1', 'b1'], `第 ${i + 1} 分钟`)
  }
  // 离上次整组盘点满 5 分钟:这一轮整组盘点,a2 / a3 也测
  k.probes.length = 0
  advance(REJECT_RETRY_MS)
  await mgr.tick()
  assert.deepEqual(k.probes.map((p) => p.tag).sort(), ['a1', 'a2', 'a3', 'b1'])
  // a3 恢复了(不是子组选中的那个):整组盘点才找得到它 → 切回
  k.behavior.set('a3', 'up')
  for (let i = 0; i < 5; i++) { advance(REJECT_RETRY_MS); await mgr.tick() }
  assert.equal(groupOf(mgr, '组a').status, 'ok')
  assert.equal(groupOf(mgr, '组a').lastSwitch.reason, 'recovered')
})

test('10 秒复查那一轮:别的页签的节点间隔内照常复用,要真测的也排 critical(不排在别的组积压的例行测速后面)', async () => {
  const defs = [groupDef('a', [['a1', 'a2'], ['b1']], { intervalMs: 300_000 })]
  const { k, mgr, advance } = setup(defs, { coordinator: true })
  await mgr.tick()
  k.behavior.set('a1', 'down'); k.behavior.set('a2', 'down')
  advance(300_000)
  const r = await mgr.tick()
  assert.equal(r.ran['组a'].recheck, true)
  // b1 的结果放到过期:复查轮要真测它
  k.probes.length = 0
  advance(300_000)
  await mgr.tick()
  const byTag = Object.fromEntries(k.probes.map((p) => [p.tag, p]))
  assert.equal(byTag.a1.force, true)
  assert.equal(byTag.a1.priority, 'critical')
  assert.equal(byTag.b1.force, false, '别的页签不强制')
  assert.equal(byTag.b1.priority, 'critical', '但要真测时排 critical')
})
