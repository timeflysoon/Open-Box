import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyProbeError, createNodeProber } from './node-probe.mjs'
import { createRealContext } from './context-real.mjs'

// ---- 假的子进程 / clash API ----------------------------------------------------------------
// startup:每次起实例时按顺序取一项,'ok' 就绪;字符串 = 启动失败时打印的那一行
const fakeWorld = ({ startup = ['ok'], delays = {}, fetchResults = {} } = {}) => {
  const spawned = []
  const written = {}
  const execCalls = []
  let live = null
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const mode = startup[Math.min(spawned.length, startup.length - 1)]
    spawned.push({ cmd, args, config: JSON.parse(written[args[2]]) })
    child.kill = () => { if (live === child) live = null; setImmediate(() => child.emit('exit', 0, 'SIGTERM')) }
    if (mode === 'ok') live = child
    else setImmediate(() => { child.stderr.emit('data', `\x1b[31mFATAL\x1b[0m[0000] ${mode}\n`); child.emit('exit', 1, null) })
    return child
  }
  const fetchImpl = async (url) => {
    if (!live) throw new Error('ECONNREFUSED')
    const u = new URL(url)
    if (u.pathname === '/version') return { ok: true, status: 200, json: async () => ({}) }
    const tag = decodeURIComponent(u.pathname.split('/')[2])
    const d = delays[tag]
    if (typeof d === 'number') return { ok: true, status: 200, json: async () => ({ delay: d }) }
    return { ok: false, status: d === 'timeout' ? 504 : 503, json: async () => ({}) }
  }
  const ctx = {
    async mkdirp() {},
    async writeFile(p, c) { written[p] = c },
    async remove(p) { delete written[p] },
    async exec(cmd, args) {
      execCalls.push(args)
      const tag = args[5]
      const r = fetchResults[tag]
      if (r === 'ok') return { code: 0, stdout: '', stderr: '' }
      if (r === 'killed') return { code: 1, stdout: '', stderr: '' } // 挂到超时被杀:什么都没打
      return { code: 1, stdout: '', stderr: `\x1b[31mFATAL\x1b[0m[0000] Get "http://x/generate_204": ${r || 'boom'}\n` }
    },
  }
  let port = 20000
  return { spawnImpl, fetchImpl, ctx, spawned, written, execCalls, freePort: async () => ++port }
}

const paths = { etc: '/fake/etc', singbox: '/fake/sing-box' }
const ob = (tag) => ({ type: 'shadowsocks', tag, server: 'example.com', server_port: 1, method: 'aes-128-gcm', password: 'x' })

test('测速实例:成功给 ms、504 给超时、503 补拨一次拿真实原因,结果和 jobs 一一对应', async () => {
  const w = fakeWorld({
    delays: { a: 88, b: 'timeout', c: 'error', d: 'error' },
    fetchResults: { c: 'use of closed network connection', d: 'dial tcp 1.2.3.4:443: connect: connection refused' },
  })
  const prober = createNodeProber({ ctx: w.ctx, paths, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, freePort: w.freePort, platform: 'linux' })
  const results = await prober.run({ outbounds: ['a', 'b', 'c', 'd'].map(ob), jobs: ['a', 'b', 'c', 'd', 'zz'].map((tag) => ({ tag, url: 'http://x/generate_204' })), timeoutMs: 3000 })
  assert.deepEqual(results[0], { ok: true, ms: 88 })
  assert.deepEqual(results[1], { ok: false, reason: 'timeout' })
  assert.equal(results[2].reason, 'closed')
  assert.match(results[2].error, /use of closed network connection/)
  assert.equal(results[3].reason, 'refused')
  assert.deepEqual(results[4], { ok: false, reason: 'not-found' })
  // 只起一个实例;补拨只针对 503 的两个
  assert.equal(w.spawned.length, 1)
  assert.deepEqual(w.execCalls.map((a) => a[5]).sort(), ['c', 'd'])
  // 实例配置:没有入站,只有回环上的 clash API,Linux 上打跳过内核的标记
  const cfg = w.spawned[0].config
  assert.equal(cfg.inbounds, undefined)
  assert.match(cfg.experimental.clash_api.external_controller, /^127\.0\.0\.1:\d+$/)
  assert.equal(cfg.route.default_mark, 0x2024)
  // 用完删掉(里面有节点凭据)
  assert.deepEqual(Object.keys(w.written), [])
})

test('测速实例:每个任务出结果就报一次 onResult(界面的测速进度),not-found 的开测时就报,每个只报一次', async () => {
  const w = fakeWorld({ delays: { a: 88, b: 'timeout', c: 'error' }, fetchResults: { c: 'use of closed network connection' } })
  const prober = createNodeProber({ ctx: w.ctx, paths, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, freePort: w.freePort, platform: 'linux' })
  const seen = []
  const results = await prober.run({ outbounds: ['a', 'b', 'c'].map(ob), jobs: ['zz', 'a', 'b', 'c'].map((tag) => ({ tag, url: 'http://x/generate_204' })), timeoutMs: 3000, onResult: (i) => seen.push(i) })
  assert.equal(results.length, 4)
  assert.equal(seen[0], 0, 'not-found 的不用等测')
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3])
  // 实例起不来也一样每个报一次
  const broken = fakeWorld({ startup: ['some unrelated failure'] })
  const p2 = createNodeProber({ ctx: broken.ctx, paths, fetchImpl: broken.fetchImpl, spawnImpl: broken.spawnImpl, freePort: broken.freePort, platform: 'linux' })
  const seen2 = []
  await p2.run({ outbounds: ['a', 'b'].map(ob), jobs: ['a', 'b'].map((tag) => ({ tag, url: 'http://x/' })), timeoutMs: 3000, onResult: (i) => seen2.push(i) })
  assert.deepEqual([...seen2].sort(), [0, 1])
})

test('测速实例:某个节点配置内核不认(initialize outbound[i])就剔掉它重起,别的照测', async () => {
  const w = fakeWorld({
    startup: ['create service: initialize outbound[1]: decode public_key: illegal base64 data at input byte 10', 'ok'],
    delays: { a: 50, c: 70 },
  })
  const prober = createNodeProber({ ctx: w.ctx, paths, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, freePort: w.freePort, platform: 'linux' })
  const results = await prober.run({ outbounds: ['a', 'bad', 'c'].map(ob), jobs: ['a', 'bad', 'c'].map((tag) => ({ tag, url: 'http://x/' })) })
  assert.deepEqual(results[0], { ok: true, ms: 50 })
  assert.equal(results[1].reason, 'invalid')
  assert.match(results[1].error, /decode public_key/)
  assert.deepEqual(results[2], { ok: true, ms: 70 })
  assert.equal(w.spawned.length, 2)
  assert.deepEqual(w.spawned[1].config.outbounds.map((o) => o.tag), ['a', 'c'])
})

test('测速实例:第一次 503、补拨却成功 = 时好时坏,按失败记', async () => {
  const w = fakeWorld({ delays: { a: 'error' }, fetchResults: { a: 'ok' } })
  const prober = createNodeProber({ ctx: w.ctx, paths, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, freePort: w.freePort })
  const [r] = await prober.run({ outbounds: [ob('a')], jobs: [{ tag: 'a', url: 'http://x/' }] })
  assert.deepEqual(r, { ok: false, reason: 'unstable' })
})

test('测速实例:补拨挂到超时被杀(没有任何输出)= 超时,不是空原因的 error', async () => {
  const w = fakeWorld({ delays: { a: 'error' }, fetchResults: { a: 'killed' } })
  const prober = createNodeProber({ ctx: w.ctx, paths, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, freePort: w.freePort })
  const [r] = await prober.run({ outbounds: [ob('a')], jobs: [{ tag: 'a', url: 'http://x/' }] })
  assert.deepEqual(r, { ok: false, reason: 'timeout' })
})

test('测速实例:macOS 上不带 default_mark(那边整个实例会 FATAL)', async () => {
  const w = fakeWorld({ delays: { a: 1 } })
  const prober = createNodeProber({ ctx: w.ctx, paths, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, freePort: w.freePort, platform: 'darwin' })
  await prober.run({ outbounds: [ob('a')], jobs: [{ tag: 'a', url: 'http://x/' }] })
  assert.equal(w.spawned[0].config.route, undefined)
})

test('测速实例:同一时刻只起一个,两批并发调用排队', async () => {
  let running = 0
  let peak = 0
  const w = fakeWorld({ delays: { a: 1, b: 2 } })
  const slowFetch = async (url) => {
    if (url.includes('/delay')) { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running-- }
    return w.fetchImpl(url)
  }
  const prober = createNodeProber({ ctx: w.ctx, paths, fetchImpl: slowFetch, spawnImpl: w.spawnImpl, freePort: w.freePort })
  const [r1, r2] = await Promise.all([
    prober.run({ outbounds: [ob('a')], jobs: [{ tag: 'a', url: 'http://x/' }] }),
    prober.run({ outbounds: [ob('b')], jobs: [{ tag: 'b', url: 'http://x/' }] }),
  ])
  assert.deepEqual(r1, [{ ok: true, ms: 1 }])
  assert.deepEqual(r2, [{ ok: true, ms: 2 }])
  assert.equal(peak, 1)
  assert.equal(w.spawned.length, 2)
})

test('报错归类', () => {
  assert.equal(classifyProbeError('use of closed network connection'), 'closed')
  assert.equal(classifyProbeError('read tcp 1.2.3.4:5->6.7.8.9:443: read: connection reset by peer'), 'closed')
  assert.equal(classifyProbeError('unexpected EOF'), 'closed')
  assert.equal(classifyProbeError('dial tcp 10.255.255.1:443: i/o timeout'), 'timeout')
  assert.equal(classifyProbeError('lookup no-such-host.invalid: (exchange4: NXDOMAIN | exchange6: NXDOMAIN)'), 'dns')
  assert.equal(classifyProbeError('dial tcp 127.0.0.1:1: connect: connection refused'), 'refused')
  assert.equal(classifyProbeError('tls: failed to verify certificate: x509: certificate signed by unknown authority'), 'tls')
  assert.equal(classifyProbeError('dial tcp: network is unreachable'), 'unreachable')
  assert.equal(classifyProbeError('something else'), 'error')
})

// ---- 真 sing-box:本机起一个 HTTP 服务当测速目标,不依赖外网 -----------------------------------
const here = path.dirname(fileURLToPath(import.meta.url))
const SINGBOX = path.resolve(here, '../../.tools/sing-box')

test('测速实例(真 sing-box):直连出站测出毫秒数,端口没开的补拨归成 refused,坏节点单独标 invalid', { skip: !fs.existsSync(SINGBOX) && 'no .tools/sing-box' }, async () => {
  const server = http.createServer((_req, res) => { res.statusCode = 204; res.end() })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/generate_204`
  const etc = fs.mkdtempSync(path.join(os.tmpdir(), 'node-probe-'))
  try {
    const prober = createNodeProber({ ctx: createRealContext(), paths: { etc, singbox: SINGBOX } })
    const results = await prober.run({
      outbounds: [
        { type: 'direct', tag: '直连 | 本机' },
        { type: 'shadowsocks', tag: 'refused', server: '127.0.0.1', server_port: 1, method: 'aes-128-gcm', password: 'x' },
        { type: 'vless', tag: '坏 | 节点', server: '127.0.0.1', server_port: 443, uuid: 'bf000d23-0752-40b4-affe-68f7707a9661', tls: { enabled: true, server_name: 'x.com', reality: { enabled: true, public_key: 'not-base64!!', short_id: '12' }, utls: { enabled: true, fingerprint: 'chrome' } } },
      ],
      jobs: [{ tag: '直连 | 本机', url }, { tag: 'refused', url }, { tag: '坏 | 节点', url }],
      timeoutMs: 3000,
    })
    assert.equal(results[0].ok, true, JSON.stringify(results[0]))
    assert.ok(results[0].ms > 0 && results[0].ms < 1000)
    assert.equal(results[1].reason, 'refused', JSON.stringify(results[1]))
    assert.equal(results[2].reason, 'invalid', JSON.stringify(results[2]))
    // 临时配置都删了
    assert.deepEqual(fs.readdirSync(path.join(etc, 'probe')), [])
  } finally {
    server.close()
    fs.rmSync(etc, { recursive: true, force: true })
  }
})
