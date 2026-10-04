import express from 'express'
import { SITE_MAX_SAMPLES, TIMED_OUT, createLatencyHistory } from '../system/latency-history.mjs'
import net from 'node:net'
import tls from 'node:tls'
import { PANEL_INBOUND_PORT, PANEL_INBOUND_TAG } from '../engine/config.mjs'
import { CLASH_API_BASE } from './penetration.mjs'

// 概览里的站点延时小卡片(站点表来自面板设置 → 测试站点)。
// 第一版是面板进程自己对站点发 HEAD。开发路由器上证明不行:路由器自己发出的连接不走内核分流(DNS 拿到的是内核
// 的 FakeIP,连过去内核又找不到记录,直接重置;换成真实 IP 也连不上)。
// 第二版是先推算走哪个出站,再让内核的 /proxies/<出站>/delay 去测。正式路由器上查出两个毛病:
//   1. 内核把这次的结果记进了那个节点的延迟历史,还立刻让含它的自动组重新择优——站点测出来的 600 多毫秒盖掉了
//      节点卡片上的 50 毫秒,自动组跟着换节点。站点卡片每开一次概览就把几个节点带乱一次;
//   2. delay 量的是一次全新 HTTPS 访问的总耗时(建连 + TLS 握手 + 请求,三四个往返),百度直连都有 160 多毫秒,
//      和大家心里的「延时」差了几倍。
// 现在改成面板经内核的回环 mixed 入站(panel-in)真去访问一次:CONNECT → TLS → 同一条连接上连发两次 HEAD。
// 连接像终端流量一样过内核的分流规则,不用推算出站,也不碰节点的延迟历史。卡片上的数是连接建好之后一次请求
// 往返的时间(两次里小的那个,和 ping 一个意思,只是走的是真实线路);首次打开的总耗时一并带回去放悬停提示。
// 走了哪条线路趁连接还在去内核连接表里按来源端口找。
// 默认的四个(GET 不带正文时用);面板设置里改过就由前端 POST 过来(id + 网址),图标 / 名字前端自己管
export const SITES = [
  { id: 'baidu', url: 'https://www.baidu.com/favicon.ico' },
  { id: 'google', url: 'https://www.google.com/generate_204' },
  { id: 'openai', url: 'https://api.openai.com/v1/models' },
  { id: 'telegram', url: 'https://telegram.org/favicon.ico' },
]
export const MAX_SITES = 8
export const SITE_TIMEOUT_MS = 5000
// 第二次往返最多再等这么久;等不到(对端答完就关、不理第二个请求)就用第一次的
export const SECOND_ROUND_MS = 2000

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))
// 只认 http(s) 网址(主机名是域名或 IP 都行)
export const siteHost = (url) => {
  try {
    const parsed = new URL(String(url || '').trim())
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname : ''
  } catch {
    return ''
  }
}
// 前端 POST 过来的站点表:最多 MAX_SITES 个,id 只认小写字母数字和横线,网址不合法的照样带回去报「网址无效」
export const normalizeSites = (input) => {
  if (!Array.isArray(input)) return null
  if (input.length === 0 || input.length > MAX_SITES) return null
  const sites = []
  const seen = new Set()
  for (const item of input) {
    const id = item && typeof item.id === 'string' ? item.id.trim() : ''
    const url = item && typeof item.url === 'string' ? item.url.trim() : ''
    if (!/^[a-z0-9-]{1,32}$/.test(id) || seen.has(id) || url.length > 2048) return null
    seen.add(id)
    sites.push({ id, url })
  }
  return sites
}

const describeProbeFailure = (message) => {
  if (/^inbound:/.test(message)) return '内核没在运行(回环入站连不上)'
  if (/timeout/i.test(message)) return '超时'
  if (/ECONNRESET|socket hang up|closed|EPIPE/i.test(message)) return '连接被断开'
  return message || '连接失败'
}

// 经内核回环入站访问一次 url,分段计时。结果:
//   { ok, status, ms, openMs, localPort, close }  ms = 建好连接后一次往返;openMs = 从发起到第一个响应
//   { ok: false, error, localPort, close }
// 连接先不关:调用方要趁它还在去内核连接表里认线路,认完再 close()
export const probeSite = (url, { proxyPort = PANEL_INBOUND_PORT, timeoutMs = SITE_TIMEOUT_MS, secondRoundMs = SECOND_ROUND_MS } = {}) =>
  new Promise((resolve) => {
    const target = new URL(url)
    const secure = target.protocol === 'https:'
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const port = Number(target.port) || (secure ? 443 : 80)
    const hostHeader = target.host
    const dest = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`
    const request = `HEAD ${target.pathname || '/'}${target.search || ''} HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: open-box-site-latency\r\nAccept: */*\r\nConnection: keep-alive\r\n\r\n`
    const t0 = performance.now()
    let stream = null
    let settled = false
    let connected = false
    let localPort = null
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort })
    const close = () => {
      try { if (stream) stream.destroy() } catch { /* ignore */ }
      try { socket.destroy() } catch { /* ignore */ }
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 兜底:调用方忘了关也不留着
      setTimeout(close, 15000).unref?.()
      resolve({ ...result, localPort, close })
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs)
    const fail = (err) => finish({ ok: false, error: connected ? errorMessage(err) : `inbound: ${errorMessage(err)}` })
    // error 事件要一直有人接:量完之后连接还留着给调用方认线路,这期间对端重置没人接的话会把面板进程带崩
    socket.on('error', fail)
    // 没报错就被关掉(内核按规则拒绝时就是这样)也要立刻有结论,不等到超时
    socket.once('close', () => finish({ ok: false, error: 'connection closed' }))
    socket.once('connect', () => {
      connected = true
      localPort = socket.localPort
      socket.write(`CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\n\r\n`)
    })

    // 在 s 上发一次 HEAD,等到响应头结束;回 { status, ms, keepAlive }
    const roundTrip = (s) =>
      new Promise((done, reject) => {
        let head = ''
        const sentAt = performance.now()
        const cleanup = () => { s.removeListener('data', onData); s.removeListener('error', onError); s.removeListener('close', onClose) }
        const onError = (err) => { cleanup(); reject(err) }
        const onClose = () => { cleanup(); reject(new Error('connection closed')) }
        const onData = (chunk) => {
          head += chunk.toString('latin1')
          // 上一次响应多带的字节(个别站点 HEAD 也回正文)丢掉,从状态行认起
          const start = head.search(/HTTP\/1\.[01] \d{3}/)
          if (start === -1) { if (head.length > 65536) { cleanup(); reject(new Error('bad response')) } return }
          const end = head.indexOf('\r\n\r\n', start)
          if (end === -1 && head.length < 65536) return
          const ms = performance.now() - sentAt
          cleanup()
          const block = head.slice(start, end === -1 ? undefined : end)
          const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(block)[1])
          done({ status, ms, keepAlive: !/\r\nconnection:\s*close/i.test(block) })
        }
        s.on('data', onData)
        s.once('error', onError)
        s.once('close', onClose)
        s.write(request)
      })

    const measure = async (s) => {
      stream = s
      try {
        const first = await roundTrip(s)
        const openMs = performance.now() - t0
        // 第一个响应到了就不算超时了;第二次往返有自己的等待上限
        clearTimeout(timer)
        let best = first.ms
        // 明文 HTTP 的第一次往返里含着节点那头去连站点的时间(CONNECT 是内核先答 200 再拨号),第二次才是干净的往返;
        // HTTPS 的握手已经把连接建好了,两次都干净,取小的压一压抖动
        let second = null
        if (first.keepAlive) {
          const budget = Math.min(secondRoundMs, Math.max(300, first.ms * 3))
          second = await Promise.race([roundTrip(s), new Promise((r) => setTimeout(() => r(null), budget))]).catch(() => null)
        }
        if (second) best = secure ? Math.min(first.ms, second.ms) : second.ms
        finish({ ok: true, status: first.status, ms: Math.max(1, Math.round(best)), openMs: Math.round(openMs) })
      } catch (err) {
        finish({ ok: false, error: errorMessage(err) })
      }
    }

    let buf = ''
    const onConnectData = (chunk) => {
      buf += chunk.toString('latin1')
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onConnectData)
      const line = buf.slice(0, buf.indexOf('\r\n'))
      if (!/^HTTP\/1\.[01] 200/.test(line)) return finish({ ok: false, error: `CONNECT: ${line}` })
      if (!secure) return void measure(socket)
      // SNI 只能是域名(RFC 6066);证书不验:这里量的是线路,不是站点的证书
      const secureStream = tls.connect({ socket, ...(net.isIP(host) ? {} : { servername: host }), ALPNProtocols: ['http/1.1'], rejectUnauthorized: false })
      secureStream.on('error', fail)
      secureStream.once('secureConnect', () => void measure(secureStream))
    }
    socket.on('data', onConnectData)
  })

// 内核连接表里按来源端口认出这几条探测连接各自走的线路。几条探测差不多同时结束时合成一次查询
export const createChainLookup = ({ store, fetchImpl, waitMs = 30 }) => {
  let batch = null
  const fetchConnections = async () => {
    const secret = (store && typeof store.getClashSecret === 'function' && store.getClashSecret()) || ''
    const res = await fetchImpl(`${CLASH_API_BASE}/connections`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {}, signal: AbortSignal.timeout(5000) })
    const body = await res.json()
    return Array.isArray(body && body.connections) ? body.connections : []
  }
  return async (localPort) => {
    if (!localPort) return []
    if (!batch) {
      const mine = new Promise((r) => setTimeout(r, waitMs)).then(() => { batch = null; return fetchConnections() })
      batch = mine
    }
    let list
    try { list = await batch } catch { return [] }
    const hit = list.find((c) => c && c.metadata && String(c.metadata.type || '').endsWith(`/${PANEL_INBOUND_TAG}`) && String(c.metadata.sourcePort || '') === String(localPort))
    if (!hit || !Array.isArray(hit.chains)) return []
    // 连接表里的 chains 是从节点往外排的,翻过来成「策略 → 组 → 节点」;故障转移组内部的 __fo: 子组是实现细节,
    // 不给用户看(见 engine/user-groups.mjs 的 publicTags)
    return hit.chains.filter((t) => typeof t === 'string' && t && !t.startsWith('__fo:')).reverse()
  }
}

// 测一个站点:访问 + 认线路
export const measureSite = async (site, { probe = probeSite, lookupChain, timeoutMs = SITE_TIMEOUT_MS }) => {
  const base = { id: site.id, url: site.url, via: null, chain: [], ms: null, openMs: null, error: null }
  if (!siteHost(site.url)) return { ...base, error: '网址无效' }
  let result
  try {
    result = await probe(site.url, { timeoutMs })
  } catch (error) {
    return { ...base, error: errorMessage(error) }
  }
  let chain = []
  try {
    chain = lookupChain ? await lookupChain(result.localPort) : []
  } finally {
    if (typeof result.close === 'function') result.close()
  }
  const routed = { ...base, chain, via: chain[0] || null }
  if (!result.ok) return { ...routed, error: describeProbeFailure(String(result.error || '')) }
  return { ...routed, ms: result.ms, openMs: result.openMs }
}

export const SITE_LATENCY_HISTORY_KEY = 'openbox/site-latency-history'

export const registerSiteLatencyRoutes = (app, { store, fetchImpl = globalThis.fetch, timeoutMs = SITE_TIMEOUT_MS, sites = SITES, probe = probeSite, history = null } = {}) => {
  const router = express.Router()
  // 概览那四张卡片要画最近 10 次的柱子:服务端记,所有浏览器看到的一样、刷新也不丢。
  // 复用节点延迟历史那套(system/latency-history.mjs),只是换一个存储键。
  // 测不通记 0(TIMED_OUT),和节点那边同一个约定,画柱子时按"红色到顶"处理。
  const siteHistory = history || createLatencyHistory({ store, key: SITE_LATENCY_HISTORY_KEY, maxSamples: SITE_MAX_SAMPLES })
  // 记历史失败绝不能连累测速本身:柱子只是锦上添花,测出来的数才是主菜
  const recordResults = (results) => {
    try {
      const time = new Date().toISOString()
      let changed = false
      for (const site of results) {
        if (!site || typeof site.id !== 'string') continue
        const delay = typeof site.ms === 'number' && Number.isFinite(site.ms) ? Math.max(0, Math.round(site.ms)) : TIMED_OUT
        // 这一笔是经哪条线路测出来的(策略 → 组 → 节点)。柱子的悬停提示要显示「检测节点」,
        // 而线路会随分流 / 自动选路变化,所以得跟着每一笔一起记,不能到时候拿"现在"的线路顶替。
        // 复用 latency-history 已有的 node 字段(节点组那边用它记"当时选中的是哪个节点")
        const node = Array.isArray(site.chain) ? site.chain.filter((x) => typeof x === 'string' && x).join(' → ') : ''
        if (siteHistory.record(site.id, { time, delay, ...(node ? { node } : {}) })) changed = true
      }
      if (changed) siteHistory.flush()
    } catch {
      // 存不下就算了,这一轮的结果照常返回
    }
  }
  const historySnapshot = () => {
    try {
      return siteHistory.get()
    } catch {
      return {}
    }
  }
  // 同一组站点同一时刻只测一轮:几个页面同时打开概览,共用这一次的结果
  const pending = new Map()
  const lookupChain = createChainLookup({ store, fetchImpl })
  const run = (key, list) => {
    if (!pending.has(key)) {
      const job = Promise.all(list.map((site) => measureSite(site, { probe, lookupChain, timeoutMs })))
        .then((results) => {
          recordResults(results)
          return { sites: results, testedAt: Date.now(), history: historySnapshot(), timeoutMs }
        })
        .finally(() => pending.delete(key))
      pending.set(key, job)
    }
    return pending.get(key)
  }
  router.use(express.json({ limit: '32kb' }))
  const keyOf = (list) => JSON.stringify(list.map((s) => [s.id, s.url]))
  // GET:默认四个;POST { sites: [{ id, url }] }:面板设置里的站点表,只测一个就只传一个
  router.get('/', async (_req, res) => res.json(await run(keyOf(sites), sites)))
  router.post('/', async (req, res) => {
    const list = normalizeSites(req.body && req.body.sites)
    if (!list) return res.status(400).json({ error: `站点表不合法(1–${MAX_SITES} 个,id 为小写字母数字横线)` })
    res.json(await run(keyOf(list), list))
  })
  // 只取历史(进概览时先把柱子画出来,不用等这一轮测完)
  // timeoutMs 一并给前端:画柱子时「不通」要按这个时长算高度(记的是 0,但实际等了这么久)
  router.get('/history', (_req, res) => res.json({ history: historySnapshot(), timeoutMs }))
  app.use('/api/openbox/site-latency', router)
  return { measureAll: () => run(keyOf(sites), sites) }
}
