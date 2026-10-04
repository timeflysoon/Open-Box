// Runs the bundled core against local HTTP nodes and a local 204 server. No
// public test endpoint, real subscription, TUN or router configuration is used.
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { configMetaPath } from './deploy.mjs'
import { createFailoverManager } from './failover-manager.mjs'
import { createLatencyScheduler } from './latency-scheduler.mjs'

const binary = process.env.OPENBOX_TEST_SINGBOX || fileURLToPath(new URL('../../.tools/sing-box', import.meta.url))
const inCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
// 这组用例只对打了 http-latency 补丁的内核(1.14.0-openbox-tcp2 起)成立:上游 1.14.0 会把 http 测速地址
// 丢掉换成 gstatic、也不认 force / interval 参数,跑起来全是 503。没有补丁内核就跳过,不假失败
const kernelPatched = (() => {
  if (!fs.existsSync(binary)) return false
  try { return /openbox-tcp([2-9]|\d{2,})/.test(execFileSync(binary, ['version'], { encoding: 'utf8', timeout: 5000 })) } catch { return false }
})()
const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const until = async (fn, ms = 8000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await sleep(30) }
  assert.fail('Timed out waiting for the core')
}

// A real HTTP CONNECT proxy, with controllable failure and link latency. Reject
// unexpected destinations so the upstream HTTP-to-gstatic bug fails locally.
const makeNode = async (t, destination, latency) => {
  const sockets = new Set()
  const state = { mode: 'up', targets: [] }
  const server = http.createServer()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('connect', async (req, client, head) => {
    state.targets.push(req.url)
    if (state.mode === 'down' || req.url !== destination) { client.destroy(); return }
    if (state.mode === 'timeout') return
    await sleep(latency)
    if (client.destroyed) return
    const upstream = net.connect(Number(destination.split(':')[1]), '127.0.0.1')
    sockets.add(upstream)
    upstream.on('error', () => client.destroy())
    upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
    client.on('close', () => upstream.destroy())
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client).pipe(upstream)
    })
  })
  state.port = await listen(server)
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)) })
  return state
}

test('真实 Clash API：HTTP 指定地址、手动选择、自动优选、故障切换及恢复', {
  skip: !kernelPatched && !inCI ? 'Set OPENBOX_TEST_SINGBOX to a core built with scripts/singbox-tcp-dns-hotfix (1.14.0-openbox-tcp2+)' : false,
  // 内核 1.14.1-openbox-tcp14 起正在用的节点不通要 10 秒后复查才换,自动优选、故障转移两段各多等十几秒
  timeout: 120_000,
}, async (t) => {
  assert.ok(fs.existsSync(binary), 'CI must install the bundled core before testing')
  const requests = []
  const endpoint = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url })
    res.writeHead(204).end()
  })
  const endpointPort = await listen(endpoint)
  t.after(() => new Promise((resolve) => { endpoint.closeAllConnections(); endpoint.close(resolve) }))
  const destination = `127.0.0.1:${endpointPort}`
  const url = `http://${destination}/probe-204?source=openbox`
  const nodes = await Promise.all([15, 65, 110].map((delay) => makeNode(t, destination, delay)))
  const tags = ['node-a', 'node-b', 'node-c']
  // 「拥挤组」:12 个 1.2 秒才应答的成员(内核一次只测 10 个,第二波在 1.2 秒后才开始)+ 1 个 1.8 秒的:
  // 成员超时给 1.5 秒时,12 个都该通(tcp3 会在请求 1.5 秒到期时把第二波砍掉),1.8 秒那个该自己超时失败
  // (tcp4 写死 15 秒时它反而会通)。见 protocol/group/urltest.go 补丁里的说明
  const crowd = await Promise.all(Array.from({ length: 12 }, () => makeNode(t, destination, 1200)))
  const tooSlow = await makeNode(t, destination, 1800)
  const crowdTags = crowd.map((_, i) => `crowd-${i + 1}`)
  const reserved = net.createServer()
  const apiPort = await listen(reserved)
  await new Promise((resolve) => reserved.close(resolve))
  const base = `http://127.0.0.1:${apiPort}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-http-latency-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const paths = createPaths(dir)
  fs.mkdirSync(paths.etc, { recursive: true })
  const config = {
    log: { level: 'error' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}` } },
    outbounds: [
      ...nodes.map((node, i) => ({ type: 'http', tag: tags[i], server: '127.0.0.1', server_port: node.port })),
      { type: 'direct', tag: 'direct' }, { type: 'block', tag: 'reject' },
      { type: 'urltest', tag: 'auto', outbounds: tags.slice(0, 2), url, interval: '1h', idle_timeout: '2h', tolerance: 0 },
      { type: 'selector', tag: 'manual', outbounds: tags },
      { type: 'urltest', tag: '__fo:test:A', outbounds: tags.slice(0, 2), url, interval: '1h', idle_timeout: '2h', tolerance: 0 },
      { type: 'selector', tag: 'failover', outbounds: ['__fo:test:A', 'node-c', 'reject'], default: '__fo:test:A' },
      ...crowd.map((node, i) => ({ type: 'http', tag: crowdTags[i], server: '127.0.0.1', server_port: node.port })),
      { type: 'http', tag: 'node-tooslow', server: '127.0.0.1', server_port: tooSlow.port },
      { type: 'urltest', tag: 'crowded', outbounds: [...crowdTags, 'node-tooslow'], url, interval: '1h', idle_timeout: '2h', tolerance: 0 },
    ],
  }
  fs.writeFileSync(paths.configPath, JSON.stringify(config))
  let output = ''
  const child = spawn(binary, ['run', '-c', paths.configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (b) => { output += b })
  child.stderr.on('data', (b) => { output += b })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
  })
  const api = async (route, init) => {
    const res = await fetch(base + route, { ...init, signal: AbortSignal.timeout(7000) })
    const body = res.status === 204 ? null : await res.json()
    return { status: res.status, body }
  }
  const proxy = async (name) => (await api(`/proxies/${encodeURIComponent(name)}`)).body
  const delay = (name, timeout = 1000) => api(`/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`)
  await until(async () => {
    assert.equal(child.exitCode, null, output)
    try { return (await api('/version')).status === 200 } catch { return false }
  })
  await until(async () => (await proxy('node-a')).history.length > 0 && (await proxy('node-b')).history.length > 0 && (await proxy('auto')).now === 'node-a')

  await t.test('直连与单节点：原样发送 HTTP HEAD，经过指定节点，超时仍失败', async () => {
    for (const tag of ['direct', ...tags]) {
      const result = await delay(tag)
      assert.equal(result.status, 200, JSON.stringify(result))
      assert.ok(result.body.delay > 0)
    }
    for (const node of nodes) assert.ok(node.targets.length && node.targets.every((target) => target === destination))
    assert.ok(requests.length && requests.every((r) => r.method === 'HEAD' && r.url === '/probe-204?source=openbox'))
    nodes[2].mode = 'timeout'
    assert.equal((await delay('node-c', 100)).status, 504)
    assert.deepEqual((await proxy('node-c')).history, [])
    nodes[2].mode = 'up'
    assert.equal((await delay('node-c')).status, 200)
  })

  await t.test('手动选择：测速跟随所选节点，批量检测不更改用户选择', async () => {
    assert.equal((await api('/proxies/manual', { method: 'PUT', body: JSON.stringify({ name: 'node-b' }) })).status, 204)
    const before = nodes.map((node) => node.targets.length)
    assert.equal((await delay('manual')).status, 200)
    assert.deepEqual(nodes.map((node, i) => node.targets.length - before[i]), [0, 1, 0])
    const result = await api(`/group/manual/delay?url=${encodeURIComponent(url)}&timeout=1000`)
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.body).sort(), tags)
    assert.ok(Object.values(result.body).every((value) => value > 0))
    assert.equal((await proxy('manual')).now, 'node-b')
  })

  await t.test('自动优选与定时调度：当前节点失败，切到可用节点并返回新延迟', async () => {
    nodes[0].mode = 'down'
    const failedAt = Date.now()
    assert.equal((await delay('node-a')).status, 503)
    // 内核 1.14.1-openbox-tcp14 起:正在用的节点不通,先不换(记录留着),10 秒后单独复查一次,仍不通才换
    assert.equal((await proxy('auto')).now, 'node-a', 'no switch on the first failure')
    await until(async () => (await proxy('auto')).now === 'node-b', 20_000)
    assert.ok(Date.now() - failedAt >= 9000, `switched after ${Date.now() - failedAt}ms, before the 10 s recheck`)
    const result = await delay('auto')
    assert.equal(result.status, 200)
    assert.ok(result.body.delay > 0)
    const ctx = createMockContext({ files: { [paths.configPath]: JSON.stringify(config) }, execResults: { 'pidof sing-box': { code: 1, stdout: '' } } })
    const samples = []
    const scheduler = createLatencyScheduler({
      ctx, paths, store: {}, fetchImpl: (target, init) => fetch(base + new URL(target).pathname + new URL(target).search, init),
      history: { recordFromProxies() {}, recordSamples(items) { samples.push(...items) } },
    })
    const tick = await scheduler.tick()
    // 配置里还有下面那个用来复现拥挤场景的 crowded 组,调度器也会测它;这里只关心 auto
    assert.ok(tick.tested.includes('auto'), JSON.stringify(tick.tested))
    assert.ok(samples.some((s) => s.name === 'node-a' && s.delay === 0))
    assert.equal((await proxy('auto')).now, 'node-b')
  })

  // 以前这条被跳过(tcp3 起就不通过):管理器用假时钟每轮 +5 秒,内核的探测缓存(Probe,按 interval 复用结果)却按真实时间算,
  // 几百毫秒前的结果都还算新鲜,节点断了也照样复用上一轮的「通过」。现在内核这边的缓存间隔给 200 毫秒、每轮之前真等
  // 250 毫秒,内核每轮都真测;管理器的轮次、失败轮数、回切等待仍按假时钟推进(审查第三项)
  await t.test('故障转移：组内换节点、阈值后换备用、全部失败拒绝、主用恢复后回切', async () => {
    nodes[0].mode = 'up'
    const mapping = {
      id: 'test', tag: 'failover', rejectTag: 'reject',
      lanes: [
        { id: 'A', index: 0, members: tags.slice(0, 2), valid: tags.slice(0, 2), mode: 'urltest', ref: '__fo:test:A', subTag: '__fo:test:A' },
        { id: 'B', index: 1, members: ['node-c'], valid: ['node-c'], mode: 'single', ref: 'node-c', subTag: null },
      ],
      settings: { testUrl: url, intervalMs: 200, timeoutMs: 1000, failureThreshold: 2, restorePrimary: true, recoveryHoldMs: 6000 },
    }
    let clock = Date.now()
    const memory = new Map()
    const manager = createFailoverManager({
      paths, now: () => clock,
      store: { getRaw: (key) => memory.get(key), setRaw: (key, value) => memory.set(key, value) },
      ctx: createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify({ generatedAt: 'test', failover: [mapping] }) }, execResults: { 'pidof sing-box': { code: 1, stdout: '' } } }),
      fetchImpl: (target, init) => fetch(base + new URL(target).pathname + new URL(target).search, init),
    })
    t.after(() => manager.stop())
    // 管理器按 interval 下限 5 秒排下一轮(假时钟);真实时间等过内核的 200 毫秒缓存间隔,每轮都是新探测
    const round = async () => { clock += 5001; await sleep(250); return manager.tick() }
    await round()
    assert.equal((await proxy('failover')).now, '__fo:test:A')
    nodes[0].mode = 'down'
    await round()
    // 页签里正在用的 node-a 不通:内核先不换,10 秒(真实时间)后复查仍不通才换到 node-b;这期间页签还有能用的节点,
    // 故障转移不动
    assert.equal((await proxy('failover')).now, '__fo:test:A')
    await until(async () => (await proxy('__fo:test:A')).now === 'node-b', 20_000)
    assert.equal((await proxy('failover')).now, '__fo:test:A')
    nodes[1].mode = 'down'
    await round()
    assert.equal((await proxy('failover')).now, '__fo:test:A')
    await round()
    assert.equal((await proxy('failover')).now, 'node-c')
    assert.ok((await delay('failover')).body.delay > 0)
    // node-b 是页签里正在用的节点,内核等 10 秒(真实时间)复查仍不通才删它的记录;管理器这里用的是假时钟,
    // 等内核复查落定再往下走,不然后面 node-a 恢复时页签可能又按 node-b 的旧记录选回它
    await until(async () => (await proxy('node-b')).history.length === 0, 20_000)
    nodes[2].mode = 'down'
    await round(); await round()
    assert.equal((await proxy('failover')).now, 'reject')
    nodes[2].mode = 'up'
    await round()
    assert.equal((await proxy('failover')).now, 'node-c')
    nodes[0].mode = 'up'
    await round(); await round()
    assert.equal((await proxy('failover')).now, 'node-c', 'recovery hold must be respected')
    await round()
    assert.equal((await proxy('failover')).now, '__fo:test:A')
    assert.equal((await proxy('__fo:test:A')).now, 'node-a')
    assert.ok((await delay('failover')).body.delay > 0)
  })

  await t.test('组测速:timeout 是每个成员自己的超时——超过它的成员失败,排在第二波的成员不被请求到期砍掉', async () => {
    // 内核启动时自己会把 crowded 测一遍(成员各自 15 秒上限,1.8 秒那个也通),等它选出结果再发我们的强制一轮
    await until(async () => Boolean((await proxy('crowded')).now))
    assert.ok((await proxy('node-tooslow')).history.length, '启动自测按 15 秒上限,1.8 秒的成员应有结果')
    const started = Date.now()
    const result = await api(`/group/crowded/delay?url=${encodeURIComponent(url)}&timeout=1500&force=true`)
    const elapsed = Date.now() - started
    assert.equal(result.status, 200, JSON.stringify(result))
    // 12 个 1.2 秒的成员分两波(10 + 2),第二波 1.2 秒后才开始,整次至少 2.3 秒——请求没有在 1.5 秒被砍断
    assert.ok(elapsed >= 2300, `两波成员应都测完,实际 ${elapsed}ms 就回了`)
    assert.deepEqual(Object.keys(result.body).sort(), [...crowdTags].sort(), JSON.stringify(result.body))
    for (const tag of crowdTags) assert.ok((await proxy(tag)).history.length, `${tag} 应有结果`)
    // 1.8 秒的成员超过了 1.5 秒的成员超时:失败、历史被删
    assert.deepEqual((await proxy('node-tooslow')).history, [], '超过成员超时的成员应失败并丢掉历史')
    assert.ok(crowdTags.includes((await proxy('crowded')).now), (await proxy('crowded')).now)
  })

  // 放在最后:这一轮 1.5 秒的成员超时会让 1.8 秒的慢成员失败、丢掉历史,别影响前面那条
  await t.test('组测速:组正在测时再发一次,等那一轮测完拿到完整名单和 X-Openbox-Group-Check(不是空结果)', async () => {
    await until(async () => Boolean((await proxy('crowded')).now))
    const q = `url=${encodeURIComponent(url)}&timeout=1500`
    const first = api(`/group/crowded/delay?${q}&force=true`)
    await sleep(300)
    const res = await fetch(`${base}/group/crowded/delay?${q}&force=false`, { signal: AbortSignal.timeout(60_000) })
    const joined = await res.json()
    const own = await first
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-openbox-group-check'), 'complete')
    assert.ok(Object.keys(joined).length > 0, '加入正在进行的那一轮,不能回空')
    assert.deepEqual(Object.keys(joined).sort(), Object.keys(own.body).sort(), '和那一轮的名单一致')
  })


  await t.test('测速排队:后台组测速占着名额时,critical 复查一个还在后台队里的成员——把它提到最前立刻测,不等整组', async () => {
    const q = `url=${encodeURIComponent(url)}&timeout=5000`
    const bgStarted = Date.now()
    const bg = api(`/group/crowded/delay?${q}&force=true&priority=background`)
    // 后台最多占 3 个名额(留一个给手动 / 复查),12 个 1.2 秒的成员要排好几波
    await until(async () => { const p = (await api('/openbox/probes')).body; return p.running >= 3 && p.background >= 1 })
    const last = crowdTags[crowdTags.length - 1]
    const started = Date.now()
    const r = await api(`/proxies/${encodeURIComponent(last)}/delay?${q}&force=true&priority=critical`)
    const waited = Date.now() - started
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(waited < 3000, `critical 复查等了 ${waited}ms(应当提到最前、测一次约 1.2 秒)`)
    await bg
    assert.ok(Date.now() - bgStarted > waited + 2000, '整组还在测的时候复查就已经回来了')
  })

})
