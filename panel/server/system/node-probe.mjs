// 统一的节点测速:面板里所有「测速」都走这里(订阅卡片、修改订阅弹窗、代理页、链式代理)。
//
// 做法:临时起一个只装待测节点的 sing-box 实例——没有入站、不碰 tun,只开一个回环地址上的 clash API——
// 再用它自己的 /proxies/<节点>/delay 逐个测,测完就停掉。
//   · 测速代码和内核自动组用的是同一段(URLTest:拨号 + 发一次 HTTP),数字和内核自己测的一致;
//     以前弹窗用 `tools fetch` 计的是整个进程的耗时,含进程启动,香港也要几百毫秒。
//   · 测的是面板此刻存的节点,不是内核启动时装进去的那份:订阅刚换过、内核还没重启也照样测得准
//     (机场换了密码时,内核那份是旧密码,走内核测会全挂)。
//   · 不写内核的延迟历史、不触发内核自动组重选(内核的 delay 接口两样都会做,见记忆里的副作用)。
//
// clash API 的 delay 失败只回一句「An error occurred in the delay test」(503),原因被吞了。
// 这种失败再用 `tools fetch` 补拨一次拿真实报错,归成几类给界面显示;超时(504)不用补。
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import net from 'node:net'
import { TUN_OUTPUT_MARK } from './lan-probe.mjs'
import { childEnv } from './timezone.mjs'

// 探测实例自己的连接打上内核自身流量的标记,跳过正在运行的内核(和 init 脚本、entry-bypass 用的是同一个)
export const PROBE_MARK = TUN_OUTPUT_MARK
export const DEFAULT_PROBE_TIMEOUT_MS = 5000
export const MAX_PROBE_TIMEOUT_MS = 30000
// 实例里并发测几个。和内核(1.14.1-openbox-tcp14)的测速额度一致:实例自己也最多 4 个一起测、相邻两次开始隔 0.25 秒,
// 多交的只会在实例里排队、白白吃掉下面那个等待时限
const CONCURRENCY = 4
// 补拨一次 = 起一个进程,并发压低
const REASON_CONCURRENCY = 4
const READY_TIMEOUT_MS = 8000
// 某个节点配置非法会让整个实例起不来(initialize outbound[i]),剔掉它重来;连着剔这么多次还起不来就放弃
const MAX_START_ATTEMPTS = 6

const stripAnsi = (text) => String(text || '').replace(/\x1b\[[0-9;]*m/g, '')
const lastLine = (text) => stripAnsi(text).split('\n').map((l) => l.trim()).filter(Boolean).pop() || ''

// 把 sing-box / Go 的报错归成几类(界面按类显示成人话,原文放悬停里)。
// closed:连上了又被对端断开——anytls / trojan / vless 这类协议密码或 UUID 不对时服务端就是这么静默断开的
export const classifyProbeError = (message) => {
  const m = String(message || '').toLowerCase()
  if (!m) return 'error'
  if (/i\/o timeout|deadline exceeded|timeout|timed out/.test(m)) return 'timeout'
  if (/no such host|nxdomain|lookup |server misbehaving|dns/.test(m)) return 'dns'
  if (/connection refused/.test(m)) return 'refused'
  if (/network is unreachable|no route to host|host is unreachable/.test(m)) return 'unreachable'
  if (/x509|certificate|tls:|handshake|reality/.test(m)) return 'tls'
  if (/use of closed network connection|connection reset|broken pipe|\beof\b|unexpected eof|closed/.test(m)) return 'closed'
  return 'error'
}

const defaultFreePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer()
  srv.unref()
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})

// 最多 n 个同时进行的小信号量:补拨是起进程,并发要压低
const semaphore = (n) => {
  let active = 0
  const waiters = []
  const release = () => { active--; const next = waiters.shift(); if (next) next() }
  return async (fn) => {
    if (active >= n) await new Promise((r) => waiters.push(r))
    active++
    try { return await fn() } finally { release() }
  }
}

const runPool = async (items, limit, worker) => {
  const results = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    }),
  )
  return results
}

// 起一个常驻子进程:stdout / stderr 并在一起留最后 64 KB(启动失败时要看 FATAL 那一行)
const startChild = (spawnImpl, cmd, args) => {
  let output = ''
  const child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ GOGC: '25' }) })
  const keep = (d) => { output = (output + String(d)).slice(-65536) }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const exited = new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: -1, output: output || String(err && err.message) }))
    child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), output }))
  })
  let done = false
  exited.then(() => { done = true })
  const stop = async () => {
    if (done) return
    try { child.kill('SIGTERM') } catch { /* 已经没了 */ }
    const killed = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))])
    if (!killed) try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
  }
  return { exited, stop, isDone: () => done }
}

// jobs:[{ tag, url }];outbounds:待测节点的出站(tag 要和 jobs 对上,链式节点把它经过的上游也放进来);
// endpoints:WireGuard 节点(sing-box 1.14 里它是 endpoint);dnsServers:节点专用解析器(#136)。
// 返回与 jobs 下标一一对应的
//   { ok: true, ms } | { ok: false, reason: 'timeout'|'closed'|'refused'|'dns'|'tls'|'unreachable'|'invalid'|'not-found'|'unstable'|'error', error? }
export const createNodeProber = ({
  ctx, paths, fetchImpl = globalThis.fetch, spawnImpl = spawn, freePort = defaultFreePort,
  readyTimeoutMs = READY_TIMEOUT_MS, log = () => {}, platform = process.platform,
} = {}) => {
  // 同一时刻只起一个实例:路由器内存紧,两个页面同时点测速就排队
  let chain = Promise.resolve()
  let seq = 0

  // onResult(i):第 i 个任务有结果了就报一次(界面的测速进度,api/node-latency.mjs);开测前就定下来的(not-found /
  // 配置不认)在开测时一起报,实例起不来的在最后报
  const runOnce = async ({ outbounds = [], endpoints = [], dnsServers = [], jobs, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, onResult = null }) => {
    const results = new Array(jobs.length).fill(null)
    const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS, 1000), MAX_PROBE_TIMEOUT_MS)
    const pool = { outbound: [...outbounds], endpoint: [...endpoints] }
    const known = new Set([...pool.outbound, ...pool.endpoint].map((o) => o.tag))
    jobs.forEach((j, i) => { if (!known.has(j.tag)) results[i] = { ok: false, reason: 'not-found' } })
    const markInvalid = (tag, error) => jobs.forEach((j, i) => { if (j.tag === tag && !results[i]) results[i] = { ok: false, reason: 'invalid', error } })
    const reported = new Set()
    const report = (i) => {
      if (!onResult || reported.has(i)) return
      reported.add(i)
      try { onResult(i) } catch { /* 报进度出错不影响测速 */ }
    }
    const finish = (list) => { list.forEach((_, i) => report(i)); return list }

    const dir = `${paths.etc}/probe`
    const id = `${process.pid}-${++seq}`
    const instancePath = `${dir}/instance-${id}.json`
    const fetchPath = `${dir}/fetch-${id}.json`
    const base = () => ({
      log: { level: 'error' },
      ...(dnsServers.length ? { dns: { servers: dnsServers } } : {}),
      // default_mark 只有 Linux 认(macOS 上整个实例 FATAL);本机开发沙盒不带
      ...(platform === 'linux' ? { route: { default_mark: PROBE_MARK } } : {}),
      outbounds: pool.outbound,
      ...(pool.endpoint.length ? { endpoints: pool.endpoint } : {}),
    })

    let child = null
    let api = ''
    let secret = ''
    try {
      await ctx.mkdirp(dir)
      for (let attempt = 0; attempt < MAX_START_ATTEMPTS && results.some((r) => !r); attempt++) {
        const port = await freePort()
        secret = crypto.randomBytes(16).toString('hex')
        api = `http://127.0.0.1:${port}`
        await ctx.writeFile(instancePath, JSON.stringify({ ...base(), experimental: { clash_api: { external_controller: `127.0.0.1:${port}`, secret } } }))
        child = startChild(spawnImpl, paths.singbox, ['run', '-c', instancePath])
        const ready = await waitReady(child)
        if (ready === true) break
        await child.stop()
        child = null
        // 某个节点的配置内核不认(比如 reality 公钥不是合法 base64):initialize outbound[i]。剔掉它,别的照测
        const line = lastLine(ready.output)
        const bad = /(outbound|endpoint)\[(\d+)\]/.exec(line)
        const list = bad ? pool[bad[1]] : null
        const index = bad ? Number(bad[2]) : -1
        if (!list || index < 0 || index >= list.length) {
          jobs.forEach((_, i) => { if (!results[i]) results[i] = { ok: false, reason: 'error', error: line || 'probe instance failed to start' } })
          break
        }
        const [removed] = list.splice(index, 1)
        markInvalid(removed.tag, line.replace(/^.*?(initialize|parse) (outbound|endpoint)\[\d+\]:\s*/i, ''))
      }
      if (!child) return finish(results.map((r) => r || { ok: false, reason: 'error', error: 'probe instance failed to start' }))

      // 503(实例没说原因)的一拿到就补拨一次拿真实报错,和其它节点的测速并行——等整轮测完再补拨会把等待翻倍
      // (超时的节点占满整个超时,补拨又从头再等一遍)。补拨是独立进程、不带 clash API,不和实例抢端口
      await ctx.writeFile(fetchPath, JSON.stringify(base()))
      results.forEach((r, i) => { if (r) report(i) })
      const reasonSlot = semaphore(REASON_CONCURRENCY)
      await runPool(jobs.map((j, i) => ({ ...j, i })), CONCURRENCY, async ({ tag, url, i }) => {
        if (results[i]) return
        const r = await delayOf(tag, url, timeout)
        if (r !== 'pending') { results[i] = r; report(i); return }
        results[i] = await reasonSlot(() => reasonOf(tag, url))
        report(i)
      })
      return finish(results.map((r) => r || { ok: false, reason: 'error' }))
    } finally {
      if (child) await child.stop()
      // 临时配置里有节点凭据:用完就删
      await ctx.remove(instancePath).catch(() => {})
      await ctx.remove(fetchPath).catch(() => {})
    }

    async function waitReady(proc) {
      const deadline = Date.now() + readyTimeoutMs
      while (Date.now() < deadline) {
        if (proc.isDone()) return await proc.exited
        try {
          const res = await fetchImpl(`${api}/version`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(1000) })
          if (res.ok) return true
        } catch { /* 还没起来 */ }
        await new Promise((r) => setTimeout(r, 100))
      }
      if (proc.isDone()) return await proc.exited
      return { code: -1, output: 'probe instance did not become ready in time' }
    }

    // 补拨:同一个出站用 tools fetch 再取一次,拿 Go 的原始报错归类。挂到超时被杀(退出码非 0、没有输出)就是超时
    async function reasonOf(tag, url) {
      const r = await ctx.exec(paths.singbox, ['tools', 'fetch', '-c', fetchPath, '-o', tag, url], { timeoutMs: timeout })
      // 第一次失败、补拨成功:节点时好时坏。按失败记,原因写清楚
      if (r.code === 0) return { ok: false, reason: 'unstable' }
      const error = lastLine(r.stderr).replace(/^FATAL\[\d+\]\s*/, '').replace(/^Get "[^"]*":\s*/, '')
      if (!error) return { ok: false, reason: 'timeout' }
      return { ok: false, reason: classifyProbeError(error), error: error.slice(0, 200) }
    }

    async function delayOf(tag, url, ms) {
      const q = `url=${encodeURIComponent(url)}&timeout=${ms}`
      try {
        const res = await fetchImpl(`${api}/proxies/${encodeURIComponent(tag)}/delay?${q}`, {
          headers: { Authorization: `Bearer ${secret}` },
          // 实例里起测之间隔 0.25 秒(内核 tcp14 的额度),多给几秒
          signal: AbortSignal.timeout(ms + 5000),
        })
        if (res.status === 200) {
          const body = await res.json().catch(() => null)
          const delay = Number(body && body.delay)
          return delay > 0 ? { ok: true, ms: delay } : 'pending'
        }
        if (res.status === 504) return { ok: false, reason: 'timeout' }
        if (res.status === 404) return { ok: false, reason: 'not-found' }
        return 'pending'
      } catch {
        return { ok: false, reason: 'timeout' }
      }
    }
  }

  const run = (opts) => {
    const jobs = Array.isArray(opts && opts.jobs) ? opts.jobs : []
    if (!jobs.length) return Promise.resolve([])
    const p = chain.then(() => runOnce({ ...opts, jobs }))
    chain = p.catch((err) => log(`[node-probe] ${err && err.message ? err.message : err}`))
    return p
  }

  return { run }
}
