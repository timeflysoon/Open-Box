// Count real HTTP CONNECT requests from the patched core. In particular, never
// make a fake /group endpoint silently behave as though force=false was sent.
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { configMetaPath } from './deploy.mjs'
import { createFailoverManager } from './failover-manager.mjs'
import { createLatencyProbeCoordinator } from './latency-probe-coordinator.mjs'

// 和 http-latency.integration.test.mjs 一样:默认用本机的测试内核(panel/.tools/sing-box),只认打了补丁的
// (1.14.0-openbox-tcp2 起有 force / interval 参数和内核的 Probe 缓存);以前只在设了 OPENBOX_TEST_SINGBOX
// 时才跑,默认一直跳过(审查第三项)
const binary = (() => {
  const candidate = process.env.OPENBOX_TEST_SINGBOX || fileURLToPath(new URL('../../.tools/sing-box', import.meta.url))
  if (!fs.existsSync(candidate)) return ''
  try { return /openbox-tcp([2-9]|\d{2,})/.test(execFileSync(candidate, ['version'], { encoding: 'utf8', timeout: 5000 })) ? candidate : '' } catch { return '' }
})()
const listen = async (s) => { s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s.address().port }
// connectDelayMs:两个节点各自隔多久才接通(节点的延迟)
const fixture = async (t, interval = '5m', failoverIntervalMs = 300_000, clock = null, { connectDelayMs = [100, 100] } = {}) => {
  const connections = [[], []]
  const sockets = new Set()
  const modes = ['up', 'up']
  const endpoint = http.createServer((req, res) => res.writeHead(204).end())
  const port = await listen(endpoint)
  const url = `http://127.0.0.1:${port}/probe`
  const servers = [endpoint]
  const nodePorts = []
  for (let i = 0; i < 2; i++) {
    const s = http.createServer()
    servers.push(s)
    s.on('connect', async (_req, client) => {
      connections[i].push(Date.now())
      if (modes[i] === 'timeout') return
      if (modes[i] === 'down') { client.destroy(); return }
      await sleep(connectDelayMs[i])
      if (client.destroyed) return
      const upstream = net.connect(port, '127.0.0.1')
      sockets.add(upstream)
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
      client.on('close', () => upstream.destroy())
      upstream.once('connect', () => { client.write('HTTP/1.1 200 OK\r\n\r\n'); client.pipe(upstream).pipe(client) })
    })
    nodePorts.push(await listen(s))
  }
  for (const s of servers) s.on('connection', (socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))))
  })
  const reserve = net.createServer()
  const apiPort = await listen(reserve)
  await new Promise((resolve) => reserve.close(resolve))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-dedup-'))
  const paths = createPaths(dir)
  fs.mkdirSync(paths.etc, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const tags = ['node-a', 'node-b']
  const config = {
    log: { level: 'error' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}` } },
    outbounds: [
      ...nodePorts.map((p, i) => ({ type: 'http', tag: tags[i], server: '127.0.0.1', server_port: p })),
      { type: 'block', tag: 'reject' },
      ...['auto', '__fo:test:A'].map((tag) => ({ type: 'urltest', tag, outbounds: tags, url, interval, idle_timeout: '1h' })),
      { type: 'selector', tag: 'failover', outbounds: ['__fo:test:A', 'reject'] },
    ],
  }
  fs.writeFileSync(paths.configPath, JSON.stringify(config))
  let output = ''
  const child = spawn(binary, ['run', '-c', paths.configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (b) => { output += b })
  child.stderr.on('data', (b) => { output += b })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done } })
  const base = `http://127.0.0.1:${apiPort}`
  const api = async (route) => {
    const res = await fetch(base + route, { signal: AbortSignal.timeout(8000) })
    return { status: res.status, body: await res.json() }
  }
  const until = async (fn) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output)
      try { if (await fn()) return } catch { /* API not listening yet */ }
      await sleep(20)
    }
    assert.fail(`core not ready: ${output}`)
  }
  await until(async () => (await api('/version')).status === 200)
  // Establish one known result through the real Clash API. Native startup
  // URLTest is intentionally asynchronous and must not be used as a test
  // readiness signal.
  const warm = `url=${encodeURIComponent(url)}&timeout=1000`
  await api(`/group/auto/delay?${warm}`)
  // 内核 1.14.1-openbox-tcp14 起测速全内核排队(相邻两次开始隔 0.25 秒),组正在做启动自测时组测速接口直接返回空
  // (上游行为):以「测速队列空了、两个节点都有结果」为准,不能以接口返回为准
  const probesIdle = async () => {
    const q = await api('/openbox/probes')
    if (q.status !== 200) return true // 老内核没有这个接口
    return q.body.running === 0 && q.body.interactive === 0 && q.body.background === 0
  }
  await until(async () => (await probesIdle()) && (await api('/proxies/node-a')).body.history.length > 0 && (await api('/proxies/node-b')).body.history.length > 0)
  await sleep(150)
  const counts = () => connections.map((v) => v.length)
  const fetchImpl = (target, init) => fetch(base + new URL(target).pathname + new URL(target).search, init)
  const coordinator = createLatencyProbeCoordinator()
  const memory = new Map()
  const manager = createFailoverManager({ paths, probeCoordinator: coordinator, ...(clock ? { now: () => clock.value } : {}),
    store: { getRaw: (key) => memory.get(key), setRaw: (key, value) => memory.set(key, value) },
    ctx: createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify({ generatedAt: 'test', failover: [{
      id: 'test', tag: 'failover', rejectTag: 'reject',
      lanes: [{ id: 'A', index: 0, members: tags, valid: tags, mode: 'urltest', ref: '__fo:test:A', subTag: '__fo:test:A' }],
      settings: { testUrl: url, intervalMs: failoverIntervalMs, timeoutMs: 1000, failureThreshold: 1 },
    }] }) }, execResults: { 'pidof sing-box': { code: 1 } } }), fetchImpl,
  })
  return { api, url, counts, connections, modes, manager, coordinator, paths, config, fetchImpl }
}

test('真实内核计数：故障转移消费刚完成的自动优选结果，子组重选不再探测', {
  skip: !binary ? 'Set OPENBOX_TEST_SINGBOX to a runnable core' : false,
}, async (t) => {
  const f = await fixture(t)
  const before = f.counts()
  await f.manager.tick()
  assert.deepEqual(f.counts(), before, 'fresh native results must be reused; sub-group selection must not send more CONNECTs')
})

test('真实内核计数：单节点检查与两个组并发，整个 interval 内只发一次请求', {
  skip: !binary ? 'Set OPENBOX_TEST_SINGBOX to a runnable core' : false,
}, async (t) => {
  const f = await fixture(t)
  const before = f.counts()
  const q = `url=${encodeURIComponent(f.url)}&timeout=1000&force=false&interval=300000`
  const forced = `url=${encodeURIComponent(f.url)}&timeout=1000&force=true`
  await Promise.all([f.api(`/proxies/node-a/delay?${forced}`), f.api(`/proxies/node-a/delay?${forced}`)])
  assert.deepEqual(f.counts().map((n, i) => n - before[i]), [1, 0], 'concurrent forced probes must share the actual network request')
  const after = f.counts()
  await Promise.all([f.api(`/proxies/node-a/delay?${q}`), f.api(`/group/auto/delay?${q}`), f.api(`/group/__fo:test:A/delay?${q}`)])
  assert.deepEqual(f.counts(), after, 'sequential scheduled request must reuse within interval')
  await f.api(`/proxies/node-a/delay?url=${encodeURIComponent(f.url)}&timeout=1000`)
  assert.equal(f.counts()[0], after[0] + 1, 'manual probe must still run immediately')
})

test('真实内核计数(真实时间):当前页签全部超时 → 这一轮不换、不重测;10 秒后复查,内核自己对正在用节点的复查和故障转移的复查合成一次,每个节点只多测一次,仍超时才切到拒绝兜底', {
  skip: !binary ? 'Set OPENBOX_TEST_SINGBOX to a runnable core' : false,
  timeout: 60_000,
}, async (t) => {
  // 管理器用真实时钟:内核对正在用节点的复查是真实的 10 秒定时器,和管理器的复查几乎同时到
  // node-b 慢得多(超过组的容差 50 毫秒),两个组都只选 node-a:node-b 没人用,内核不替它复查,它的第二次测试只能是故障转移的复查。
  // 以前两个节点一样快,两个组偶尔选得不一样,两个节点都「正在用」,内核把两个都复查了,盖住了 tcp14~tcp20 复查拿回失败本身的问题
  const f = await fixture(t, '5m', 300_000, null, { connectDelayMs: [100, 400] })
  assert.deepEqual([(await f.api('/proxies/auto')).body.now, (await f.api('/proxies/__fo:test:A')).body.now], ['node-a', 'node-a'], 'only node-a is in use')
  f.modes[0] = 'timeout'
  f.modes[1] = 'timeout'
  // Expire the real core's successful history without waiting five minutes:
  // an explicit/manual probe records the node failure first. The node the groups
  // use keeps its record for now and gets the kernel's own recheck in 10 s.
  const forced = `url=${encodeURIComponent(f.url)}&timeout=100&force=true`
  await Promise.all([f.api(`/proxies/node-a/delay?${forced}`), f.api(`/proxies/node-b/delay?${forced}`)])
  f.coordinator.clear()
  const before = f.counts()
  await f.manager.tick()
  assert.deepEqual(f.counts().map((n, i) => n - before[i]), [0, 0], 'first failure reuses the cached timeouts: no immediate retry')
  assert.equal((await f.api('/proxies/failover')).body.now, '__fo:test:A', 'no switch on the first failure')
  const next = f.manager.status().groups[0].nextRoundAt
  await sleep(Math.max(0, next - Date.now()) + 50)
  await f.manager.tick()
  // 内核自己的复查也在这前后:等到正在用的节点记录被删(它复查仍不通),再数连接
  const until = async (fn) => { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (await fn()) return; await sleep(50) } assert.fail('kernel recheck did not settle') }
  await until(async () => (await f.api('/proxies/node-a')).body.history.length === 0 && (await f.api('/proxies/node-b')).body.history.length === 0)
  await sleep(300)
  // node-b 那一下只能是故障转移的复查真测了:复查带的 since 是毫秒,内核把失败本身当成「更新的结果」时这里是 0(tcp14~tcp20)
  assert.deepEqual(f.counts().map((n, i) => n - before[i]), [1, 1], 'kernel recheck and failover recheck share one probe per node')
  assert.equal((await f.api('/proxies/failover')).body.now, 'reject', 'still all failed after the recheck: switch to the reject fallback')
})

test('真实时间验证：5m/5m、2m/5m、5m/2m 共用节点，间隔内不重复', {
  skip: !binary || process.env.OPENBOX_LONG_PROBE_TEST !== '1' ? 'Opt-in 315-second real-time interval check' : false,
  timeout: 340_000,
}, async (t) => {
  await Promise.all([
    ['5m', 300_000, 1], ['2m', 300_000, 2], ['5m', 120_000, 2],
  ].map(async ([autoInterval, failoverInterval, expected]) => {
    const f = await fixture(t, autoInterval, failoverInterval)
    const before = f.counts()
    const baseline = f.connections.map((times) => times[times.length - 1])
    const started = Date.now()
    const q = `url=${encodeURIComponent(f.url)}&timeout=1000&force=false`
    while (Date.now() - started < 315_000) {
      await Promise.all([f.manager.tick(), f.api(`/group/auto/delay?${q}`)])
      await sleep(5000)
    }
    assert.deepEqual(f.counts().map((n, i) => n - before[i]), [expected, expected], `${autoInterval}/${failoverInterval} counts`)
    const minInterval = Math.min(autoInterval === '2m' ? 120_000 : 300_000, failoverInterval)
    for (let i = 0; i < 2; i++) {
      const times = [baseline[i], ...f.connections[i].slice(before[i])]
      for (let j = 1; j < times.length; j++) assert.ok(times[j] - times[j - 1] >= minInterval, `${autoInterval}/${failoverInterval}: duplicate after ${times[j] - times[j - 1]}ms`)
    }
  }))
})
