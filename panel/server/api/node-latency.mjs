import dns from 'node:dns/promises'
import express from 'express'
import { TUN_OUTPUT_MARK } from '../system/lan-probe.mjs'
import { classifyProbeError, createNodeProber, DEFAULT_PROBE_TIMEOUT_MS } from '../system/node-probe.mjs'
import { CLASH_API_BASE } from './penetration.mjs'
import { emitEndpoint } from '../engine/emit-endpoint.mjs'
import { emitOutbound } from '../engine/emit-outbound.mjs'
import { DEFAULT_TEST_URL, expectedQuery, normalizeExpectedStatus } from '../engine/test-url.mjs'
import { activeNodes, resolveNodes } from './subscriptions.mjs'
import { fetchSelections, resolveSelections } from './deploy-runner.mjs'
import { chainNodes, parseChainNode } from '../engine/chain-proxy.mjs'
import { resolveSelectionLeaf } from '../engine/routing-model.mjs'
import { nodeDnsServers, planNodeDns, validateNodeDns, withNodeResolver } from '../engine/node-dns.mjs'

// 节点测速。
//
// 第一版是从路由器直接对 server:port 做 TCP 握手计时。真机上被证明**完全没有意义**:
// 那台路由器的网络里有东西把所有 TCP 握手就地接管了——实测连 203.0.113.7:12345
// (RFC 5737 保留网段,完全不可路由)都在 0.84ms「连上」,端口 9 也一样。于是每个节点
// 都是 0ms/1ms,数字全是假的。
//
// 第二版改用 `sing-box tools fetch`,每测一个节点起一个进程,计的是整个进程的耗时——含进程启动,
// 香港节点也要几百毫秒;而订阅卡片、代理页走的是正在运行的内核,两边数字对不上,内核里的节点
// 过期了(订阅换了密码、内核还没重启)更是一边通一边全挂。
//
// 现在全部走 system/node-probe.mjs 的测速实例:临时起一个只装待测节点的 sing-box,用它自己的
// clash API 测——和内核自动组同一段测速代码,测的是面板此刻存的节点。修改订阅弹窗(还没保存的节点)、
// 订阅卡片、代理页、链式代理都是这一种测法。

const MAX_PREVIEW_TARGETS = 100
// 代理页「全部测速」一次可能交几百个节点
const MAX_STORED_TARGETS = 1000
const DEFAULT_CHAIN_TIMEOUT_MS = 8000
const MAX_TIMEOUT_MS = 30000
// 链式代理取 IP 信息仍用 tools fetch(要网页正文,测速实例的 delay 接口只回毫秒数)
const PROBE_MARK = TUN_OUTPUT_MARK

const stripAnsi = (text) => String(text || '').replace(/\x1b\[[0-9;]*m/g, '')
const validUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim()) && u.length <= 2048

// 经临时配置里的某个出站取一次网址:`sing-box tools fetch -c <配置> -o <出站> <URL>`(链式代理取 IP 信息用;stdout 是网页正文)
const fetchVia = async (ctx, paths, configPath, tag, url, timeoutMs) => {
  const startedAt = Date.now()
  const { code, stdout, stderr } = await ctx.exec(paths.singbox, ['tools', 'fetch', '-c', configPath, '-o', tag, url], { timeoutMs })
  const ms = Date.now() - startedAt
  if (code === 0) return { ok: true, ms, stdout: String(stdout || '') }
  const reason = stripAnsi(stderr).split('\n').filter(Boolean).pop() || 'failed'
  return { ok: false, ms, error: reason.slice(0, 160) }
}

// 测速实例的失败结果 → 给前端的形状:reason 是分类(界面翻成人话),error 是原文(悬停里看)
const shapeResult = (r) => (r && r.ok ? { ok: true, ms: r.ms } : { ok: false, reason: (r && r.reason) || 'error', ...(r && r.error ? { error: r.error } : {}) })

// 链式代理测速要的「上游此刻落在哪个节点」:和 DNS 上游测试(api/dns-upstream-test.mjs)同一套——内核此刻的选择
// (fetchSelections / resolveSelections)→ resolveSelectionLeaf 落到末端 → 节点(订阅节点 + 链式节点)→ emitOutbound。
// 上游本身又是链式代理时顺着它的 detour 再落一层,detour 改指落到的那个节点
export const upstreamOutbounds = async ({ store, fetchImpl, upstream }) => {
  const selections = resolveSelections(store, await fetchSelections(fetchImpl, store.getClashSecret ? store.getClashSecret() : ''))
  const nodeByTag = new Map([...activeNodes(store), ...chainNodes(store.getProfile ? store.getProfile() : {})].filter((n) => n && n.tag).map((n) => [n.tag, n]))
  // 上游节点所在订阅配了专用解析器(#136)的,临时配置里也带上,和正式配置一样解析节点域名
  const nodeDns = planNodeDns(store.getSubscriptions ? store.getSubscriptions() : [])
  const dnsServers = []
  const outbounds = []
  let name = upstream
  for (let depth = 0; depth < 8; depth++) {
    const leaf = resolveSelectionLeaf(selections, name)
    const node = nodeByTag.get(leaf)
    if (!node) throw new Error(`上游「${name}」此刻落在「${leaf}」,不是可以测的节点`)
    if (outbounds.length) outbounds[outbounds.length - 1].detour = leaf
    const resolver = nodeDns.bySubscription.get(node.subscriptionId)
    outbounds.push(withNodeResolver(emitOutbound(node), resolver))
    if (resolver) for (const s of nodeDns.servers) if ((s.tag === resolver || s.tag === `${resolver}-bootstrap`) && !dnsServers.includes(s)) dnsServers.push(s)
    if (!node.detour) return { via: outbounds[0].tag, outbounds, dnsServers }
    name = node.detour
  }
  throw new Error('上游的链式代理嵌套太深')
}

// 链式代理的 IP 信息只取这几家(面板设置里「IP 信息接口」的选项,见 src/api/geoip.ts),别的网址不经这里取
export const CHAIN_IP_HOSTS = ['api.ip.sb', 'ipwho.is', 'api.ipapi.is']
const CHAIN_PROBE_TAG = 'probe-chain'

// 手动测速走正在运行的内核(用户 2026-09-30 定的 A 方案):内核里所有测速共用一份额度、一个排队(手动插在后台前面,
// 见内核 1.14.1-openbox-tcp14 的 common/urltest/pacer.go),同一个节点正在测就等它的结果、KERNEL_REUSE_MS 内刚测过
// 就直接用。内核在线替换出站之后,内核里的节点就是面板存的节点;内核里没有的、内核还在用旧定义的(kernelStale),
// 以及修改订阅弹窗里还没保存的节点,才用临时测速实例。
const KERNEL_REUSE_MS = 15_000
// 同时交给内核几个:内核自己最多 4 个一起测,再多几个在它的 interactive 队里等着,轮到就测,不用来回
const KERNEL_REQUESTS = 6
// 等内核回话的上限:排队不占节点自己的超时(内核拿到名额才开始计),这里要给排队留足时间
const KERNEL_QUEUE_GRACE_MS = 120_000
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Smart'])

const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
let chainProbeSeq = 0

// prober:system/node-probe.mjs 的测速实例(index.mjs 建一个全局共用,同一时刻只起一个);history:延迟历史,
// 测面板存的节点时把结果记进去(订阅卡片的圆点、代理页的时间线都读它)
export const registerNodeLatencyRoutes = (app, { ctx, paths, store = null, fetchImpl = globalThis.fetch, lookup = dns.lookup, prober = null, history = null, kernelStale = null, limiter = null, now = () => Date.now() } = {}) => {
  const probe = prober || createNodeProber({ ctx, paths })
  const kernelHeaders = () => {
    const secret = store && store.getClashSecret ? store.getClashSecret() : ''
    return secret ? { Authorization: `Bearer ${secret}` } : {}
  }
  // 内核里此刻有的节点(不含组);内核没在跑 / 读不到就是 null,全部走测速实例
  const kernelNodeTags = async () => {
    try {
      const res = await fetchImpl(`${CLASH_API_BASE}/proxies`, { headers: kernelHeaders(), signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      const body = await res.json()
      const proxies = (body && body.proxies) || {}
      return new Set(Object.entries(proxies).filter(([, p]) => p && !GROUP_TYPES.has(p.type) && !(Array.isArray(p.all) && p.all.length)).map(([tag]) => tag))
    } catch {
      return null
    }
  }
  // 内核测一个节点。null = 内核里没有这个节点(交给测速实例);reused = 内核拿的是别人刚测完的结果(不另记一笔)
  // expected:可接受状态码(内核 tcp19,'' = 不限)
  // 经面板全局的测速名额(GitHub #514,interactive 那一档):拿到名额才发,期限从发出去才开始算
  const kernelDelay = (tag, url, timeoutMs, expected = '') => (limiter ? limiter.run('interactive', () => kernelDelayNow(tag, url, timeoutMs, expected)) : kernelDelayNow(tag, url, timeoutMs, expected))
  const kernelDelayNow = async (tag, url, timeoutMs, expected = '') => {
    const q = `url=${encodeURIComponent(url)}&timeout=${timeoutMs}&force=false&interval=${KERNEL_REUSE_MS}&priority=interactive${expectedQuery(expected)}`
    let res
    try {
      res = await fetchImpl(`${CLASH_API_BASE}/proxies/${encodeURIComponent(tag)}/delay?${q}`, { headers: kernelHeaders(), signal: AbortSignal.timeout(timeoutMs + KERNEL_QUEUE_GRACE_MS) })
    } catch {
      return { ok: false, reason: 'timeout' }
    }
    if (res.status === 404) return null
    const body = await res.json().catch(() => ({}))
    const reused = body && body.reused === true
    const time = body && typeof body.time === 'string' ? body.time : null
    const delay = Number(body && body.delay)
    if (res.ok && delay > 0) return { ok: true, ms: delay, reused, time }
    const error = body && typeof body.error === 'string' ? body.error.slice(0, 200) : ''
    const reason = res.status === 504 ? 'timeout' : error ? classifyProbeError(error) : 'error'
    return { ok: false, reason, ...(error ? { error } : {}), reused, time }
  }
  // 测的地址跟「分流与策略 → 其他」里的全局测速地址走(用户改了就按改的测;#35);`tools fetch` 认 http,不用升 https
  const testUrl = () => {
    try {
      const u = store?.getProfile?.()?.testUrl
      return typeof u === 'string' && u.trim() ? u.trim() : DEFAULT_TEST_URL
    } catch { return DEFAULT_TEST_URL }
  }
  // 用全局测速地址测的时候,也按全局的「可接受状态码」判(后端设置 · 测速地址;内核 tcp19,GitHub #482):和自动择优 /
  // 故障转移的判断一致,站点回 403 的节点手动测也显示不通。用别的地址测(组自己的地址等)不带
  const expectedFor = (url) => {
    if (url !== testUrl()) return ''
    try { return normalizeExpectedStatus(store?.getProfile?.()?.testExpectedStatus) ?? '' } catch { return '' }
  }
  // 交给测速实例的任务:不限状态码时不带 expected 字段,和以前一样
  const probeJob = (tag, url) => {
    const expected = expectedFor(url)
    return expected ? { tag, url, expected } : { tag, url }
  }
  const router = express.Router({ caseSensitive: true })
  router.use(express.json({ limit: '10mb' }))

  // POST /api/openbox/nodes/latency,两种用法,测法完全一样(同一个测速实例):
  //   · 修改 / 添加订阅弹窗:{ url? | urls? | content?, renameOptions?, nodeDns?, tags: [originalTag...], testUrl?, timeoutMs? }
  //     用 url/content 重新解析而不是让前端把节点配置传上来:节点里含密码,没有理由为了测速把它们送到浏览器再送回来。
  //     结果不进延迟历史(还没保存的节点)。
  //   · 订阅卡片 / 代理页:{ jobs: [{ tag, url?, record? }], timeoutMs? } 测面板此刻存的节点——订阅刚换过、内核还没重启
  //     也测的是新的那份。结果记进延迟历史(record:false 的除外,比如 IPv6 探测),连同整份历史一起返回。
  //     带 progress:true 时回逐行 JSON:每测完一个节点一行 {"done":[下标…]}(请求里 jobs 的下标,重复的那几条一起报),
  //     最后一行是和不带进度时一样的 { results, history };中途出错最后一行是 { error }。界面右上角那条测速提示按它
  //     走 1/N、2/N……N/N,测完在同一条提示里出结果(store/proxies.ts)
  router.post('/nodes/latency', async (req, res) => {
    const body = req.body || {}
    const preview = body.url !== undefined || body.urls !== undefined || body.content !== undefined
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
    try {
      if (preview) return await previewLatency(body, timeoutMs, res)
      const parsed = storedJobs(body)
      if (parsed.error) return res.status(parsed.status).json({ error: parsed.error })
      if (body.progress !== true) return res.json(await storedLatency(parsed.jobs, timeoutMs))
      // 反向代理(nginx 等)别攒着整份再发,压缩也会攒
      res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' })
      res.flushHeaders()
      const line = (obj) => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(obj)}\n`) }
      line({ done: [] })
      line(await storedLatency(parsed.jobs, timeoutMs, (done) => line({ done })))
      res.end()
    } catch (err) {
      const error = (err && err.message) || String(err)
      if (!res.headersSent) res.status(500).json({ error })
      else if (!res.writableEnded) res.end(`${JSON.stringify({ error })}\n`)
    }
  })

  const previewLatency = async (body, timeoutMs, res) => {
    const tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : null
    if (!tags || !tags.length) return res.status(400).json({ error: 'tags must be a non-empty array' })
    if (tags.length > MAX_PREVIEW_TARGETS) return res.status(400).json({ error: `too many targets (max ${MAX_PREVIEW_TARGETS})` })
    // 订阅编辑框里填的节点专用解析器(#136,还没保存也按它测):节点出站带 domain_resolver,实例配置带上这台 DoH
    const nodeDnsError = validateNodeDns(body.nodeDns)
    if (nodeDnsError) return res.status(400).json({ error: nodeDnsError })
    const nodeDns = nodeDnsServers(body.nodeDns, 'probe')
    const url = validUrl(body.testUrl) ? body.testUrl.trim() : testUrl()

    let nodes
    try {
      nodes = (await resolveNodes({ url: body.url, urls: body.urls, content: body.content, name: body.name }, fetchImpl, body.renameOptions, lookup)).renamed
    } catch (err) {
      return res.status(400).json({ error: (err && err.message) || String(err) })
    }

    // probe-<下标> 作为出站 tag:节点自己的名字可能重复、含空格或特殊字符
    const results = new Array(tags.length).fill(null)
    const outbounds = []
    const jobs = []
    const jobIndex = []
    // 订阅里真有同名的原始节点:第 k 次出现的名字对第 k 个同名节点(和预览列表的顺序一致)。以前一律找第一个,
    // 两行都测成第一个节点,第二个根本没测(审查第十三项)。单独测某一行时前端用 occurrences 说明是第几个
    const occurrences = Array.isArray(body.occurrences) && body.occurrences.length === tags.length ? body.occurrences : null
    const seen = new Map()
    for (let i = 0; i < tags.length; i++) {
      const k = occurrences && Number.isInteger(occurrences[i]) && occurrences[i] >= 0 ? occurrences[i] : (seen.get(tags[i]) || 0)
      seen.set(tags[i], (seen.get(tags[i]) || 0) + 1)
      const node = nodes.filter((n) => n.originalTag === tags[i])[k]
      if (!node) { results[i] = { ok: false, reason: 'not-found', error: 'not found' }; continue }
      // 以前这里挡内网 / 回环地址的节点(怕接口被拿去探测内网)。挡不住什么:同样的节点保存下来,内核照样去连,
      // 订阅卡片也照样能测;只落得弹窗和卡片两种结果、自建在局域网里的节点在弹窗里测不了。
      // 和卡片统一:什么节点都照测
      let outbound
      try {
        outbound = withNodeResolver({ ...emitOutbound(node), tag: `probe-${i}` }, nodeDns && nodeDns.tag)
      } catch {
        results[i] = { ok: false, reason: 'invalid', error: 'unsupported' }
        continue
      }
      outbounds.push(outbound)
      jobs.push(probeJob(outbound.tag, url))
      jobIndex.push(i)
    }
    const probed = await probe.run({ outbounds, dnsServers: nodeDns ? nodeDns.servers : [], jobs, timeoutMs })
    probed.forEach((r, k) => { results[jobIndex[k]] = shapeResult(r) })
    res.json({ results })
  }

  // 面板存的节点 → 测速实例里的出站:订阅节点和部署时生成得一模一样(带订阅的专用解析器);链式节点连同它此刻
  // 经过的上游一起放进去;内置「直连」这类组就是一个 direct 出站。别的(组、已经不在订阅里的)按 not-found 回
  const storedTargets = async (tags) => {
    const nodes = new Map(activeNodes(store).map((n) => [n.tag, n]))
    const chain = new Set(chainNodes(store.getProfile ? store.getProfile() : {}).map((n) => n.tag))
    const direct = new Set((store.getGroups ? store.getGroups() : []).filter((g) => g && g.kind === 'direct').map((g) => g.name))
    const nodeDns = planNodeDns(store.getSubscriptions ? store.getSubscriptions() : [])
    const outbounds = new Map()
    const endpoints = new Map()
    const dnsServers = []
    const addDns = (resolver) => {
      if (!resolver) return
      for (const srv of nodeDns.servers) if ((srv.tag === resolver || srv.tag === `${resolver}-bootstrap`) && !dnsServers.includes(srv)) dnsServers.push(srv)
    }
    const problems = new Map()
    for (const tag of tags) {
      if (outbounds.has(tag) || endpoints.has(tag) || problems.has(tag)) continue
      const node = nodes.get(tag)
      try {
        if (node && node.type === 'wireguard') {
          endpoints.set(tag, emitEndpoint(node))
        } else if (node) {
          const resolver = nodeDns.bySubscription.get(node.subscriptionId)
          outbounds.set(tag, withNodeResolver(emitOutbound(node), resolver))
          addDns(resolver)
        } else if (chain.has(tag)) {
          const set = await upstreamOutbounds({ store, fetchImpl, upstream: tag })
          for (const o of set.outbounds) if (!outbounds.has(o.tag) || o.tag === tag) outbounds.set(o.tag, o)
          for (const srv of set.dnsServers) if (!dnsServers.includes(srv)) dnsServers.push(srv)
        } else if (direct.has(tag)) {
          outbounds.set(tag, { type: 'direct', tag })
        }
      } catch (err) {
        problems.set(tag, { ok: false, reason: 'invalid', error: (err && err.message) || String(err) })
      }
    }
    return { outbounds: [...outbounds.values()], endpoints: [...endpoints.values()], dnsServers, problems }
  }

  // 订阅卡片 / 代理页那种请求的核对:{ jobs } 或 { status, error }
  const storedJobs = (body) => {
    if (!store) return { status: 500, error: 'store unavailable' }
    const raw = Array.isArray(body.jobs) ? body.jobs : null
    if (!raw || !raw.length) return { status: 400, error: 'jobs must be a non-empty array' }
    if (raw.length > MAX_STORED_TARGETS) return { status: 400, error: `too many targets (max ${MAX_STORED_TARGETS})` }
    const jobs = []
    for (const j of raw) {
      if (!j || typeof j.tag !== 'string' || !j.tag || j.tag.length > 256) return { status: 400, error: 'jobs[] must be { tag, url?, record? }' }
      if (j.url !== undefined && !validUrl(j.url)) return { status: 400, error: `bad url for ${j.tag}` }
      const url = j.url ? j.url.trim() : testUrl()
      jobs.push({ tag: j.tag, url, expected: expectedFor(url), record: j.record !== false })
    }
    return { jobs }
  }

  // onDone(下标数组):每测完一个节点报一次,下标是请求里 jobs 的
  const storedLatency = async (jobs, timeoutMs, onDone = () => {}) => {
    // 同一个节点、同一个测速地址只测一次、只记一笔历史(页面发来的本来就去过重,接口层再防一下;审查第十三项),
    // 结果按请求里的顺序展开;要记历史的那条和不记的重了,按要记算
    const unique = []
    const slotOf = new Map()
    const slots = jobs.map((j) => {
      const key = `${j.tag}\0${j.url}\0${j.expected}`
      if (!slotOf.has(key)) { slotOf.set(key, unique.length); unique.push({ ...j }) } else if (j.record) unique[slotOf.get(key)].record = true
      return slotOf.get(key)
    })
    const uniqueResults = new Array(unique.length).fill(null)
    // 测完一个报一个(界面的测速进度);同一个节点重复的那几条一起报
    const reported = new Set()
    const report = (u) => {
      if (reported.has(u)) return
      reported.add(u)
      onDone(slots.flatMap((slot, k) => (slot === u ? [k] : [])))
    }
    // 1. 内核能测的交给内核(内核里有、而且内核用的就是面板此刻存的那份定义)
    const inKernel = await kernelNodeTags()
    const stale = kernelStale ? (await kernelStale.get().catch(() => null))?.staleTags || new Set() : new Set()
    const viaKernel = inKernel ? unique.map((j, i) => ({ ...j, i })).filter((j) => inKernel.has(j.tag) && !stale.has(j.tag)) : []
    const kernelResults = await mapLimit(viaKernel, KERNEL_REQUESTS, async (j) => {
      const r = await kernelDelay(j.tag, j.url, timeoutMs, j.expected)
      // null = 内核里其实没有,下面交给测速实例,那时再报
      if (r) report(j.i)
      return r
    })
    const reusedAt = new Map()
    viaKernel.forEach((j, k) => {
      const r = kernelResults[k]
      if (!r) return // 内核里其实没有(刚被删):交给测速实例
      uniqueResults[j.i] = shapeResult(r)
      if (r.reused) reusedAt.set(j.i, r.time)
    })
    // 2. 剩下的(内核里没有、内核还是旧定义、内核没在跑)照旧起测速实例
    const rest = unique.map((j, i) => ({ ...j, i })).filter((j) => !uniqueResults[j.i])
    if (rest.length) {
      const { outbounds, endpoints, dnsServers, problems } = await storedTargets([...new Set(rest.map((j) => j.tag))])
      for (const j of rest) if (problems.has(j.tag)) { uniqueResults[j.i] = problems.get(j.tag); report(j.i) }
      const runnable = rest.filter((j) => !problems.has(j.tag))
      const probed = runnable.length
        ? await probe.run({ outbounds, endpoints, dnsServers, jobs: runnable.map(({ tag, url, expected }) => (expected ? { tag, url, expected } : { tag, url })), timeoutMs, onResult: (k) => report(runnable[k].i) })
        : []
      runnable.forEach((j, k) => { uniqueResults[j.i] = shapeResult(probed[k]) })
    }
    unique.forEach((_, u) => report(u))
    const results = slots.map((slot) => uniqueResults[slot])

    if (history) {
      const time = new Date(now()).toISOString()
      const samples = []
      unique.forEach((j, i) => {
        if (!j.record) return
        // 内核拿的是别人刚测完的结果:那一笔已经记过了(定时测速 / 上一次手动测速),不再记
        if (reusedAt.has(i)) return
        const r = uniqueResults[i]
        // 组、已经不在订阅里的节点(not-found)不是测速结果,不记
        if (!r || (!r.ok && r.reason === 'not-found')) return
        samples.push({ name: j.tag, time, delay: r.ok ? r.ms : 0, src: 'probe', ...(r.ok ? {} : { reason: r.reason }) })
      })
      if (samples.length) history.recordSamples(samples)
    }
    return { results, ...(history ? { history: history.get() } : {}) }
  }

  // GET /api/openbox/nodes/latency/queue:手动测速开始前看一眼内核的测速排队(内核 tcp14 的 GET /openbox/probes),
  // 前面有测速在跑 / 在排队,界面在右上角提示「已排队」。内核没在跑 / 老内核没有这个接口就当不忙
  router.get('/nodes/latency/queue', async (req, res) => {
    let kernel = null
    try {
      const r = await fetchImpl(`${CLASH_API_BASE}/openbox/probes`, { headers: kernelHeaders(), signal: AbortSignal.timeout(3000) })
      if (r.ok) kernel = await r.json()
    } catch { /* 当不忙 */ }
    const running = Number(kernel && kernel.running) || 0
    const waiting = (Number(kernel && kernel.interactive) || 0) + (Number(kernel && kernel.background) || 0)
    const limit = Number(kernel && kernel.limit) || 0
    res.json({ busy: Boolean(kernel) && (waiting > 0 || (limit > 0 && running >= limit)), running, waiting })
  })

  // POST /api/openbox/chain-proxies/latency
  //   { link, upstream, testUrl?, timeoutMs?, ipUrls? }
  // 链式代理编辑框里的「测速 / IP 地区」:测的是框里填的这一份(还没保存也能测)。做法和上面的订阅节点测速一样,
  // 只是临时配置里多放上游此刻选中的那个节点,链式出站 detour 过去(见 upstreamOutbounds)。
  // testUrl / timeoutMs 是面板设置里的「测速地址 / 测速超时」(前端传);ipUrls 是面板设置里选的 IP 信息接口(加兜底),
  // 经这条链再取一次,正文原样交回前端按答话那一家的格式解析
  router.post('/chain-proxies/latency', async (req, res) => {
    const body = req.body || {}
    const parsed = parseChainNode(typeof body.link === 'string' ? body.link : '')
    if (parsed.error) return res.status(400).json({ error: parsed.error })
    const upstream = typeof body.upstream === 'string' ? body.upstream.trim() : ''
    if (!upstream || upstream.length > 64) return res.status(400).json({ error: '还没有选上游' })
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || DEFAULT_CHAIN_TIMEOUT_MS, 2000), MAX_TIMEOUT_MS)
    const url = validUrl(body.testUrl) ? body.testUrl.trim() : testUrl()
    // ipUrls:面板设置里选的 IP 信息接口排第一,其余几家依次兜底(前端按 src/api/geoip.ts 的 ipInfoUrls 排好)。
    // 兜底是因为有的接口不认 tools fetch 这种非浏览器请求:api.ip.sb 对 curl / Go 的 User-Agent 一律 403(开发路由器实测),
    // 而 tools fetch 改不了 User-Agent
    const ipUrls = []
    for (const raw of (Array.isArray(body.ipUrls) ? body.ipUrls : []).slice(0, CHAIN_IP_HOSTS.length)) {
      let u = null
      try { u = new URL(String(raw)) } catch { /* 下面按不合法处理 */ }
      if (!u || u.protocol !== 'https:' || !CHAIN_IP_HOSTS.includes(u.hostname)) return res.status(400).json({ error: 'ipUrls 只能是面板设置里的 IP 信息接口' })
      ipUrls.push(u.toString())
    }

    let upstreamSet
    try {
      upstreamSet = await upstreamOutbounds({ store, fetchImpl, upstream })
    } catch (err) {
      return res.status(409).json({ error: (err && err.message) || String(err) })
    }
    let chainOutbound
    try {
      chainOutbound = { ...emitOutbound(parsed.node), tag: CHAIN_PROBE_TAG, detour: upstreamSet.via }
    } catch (err) {
      return res.status(400).json({ error: `生成不出这个节点的出站:${(err && err.message) || err}` })
    }

    // 测速:和订阅节点同一个测速实例
    const [latency] = await probe.run({ outbounds: [chainOutbound, ...upstreamSet.outbounds], dnsServers: upstreamSet.dnsServers, jobs: [probeJob(CHAIN_PROBE_TAG, url)], timeoutMs })
    const shaped = shapeResult(latency)
    const out = { via: upstreamSet.via, ...shaped, ...(shaped.ok ? {} : { error: shaped.error || shaped.reason }) }

    // IP 信息要网页正文,测速实例的 delay 接口只回毫秒数:这里仍用 tools fetch 经同一条链取。
    // 临时配置里有链式节点和上游节点的凭据:单独一个文件,用完就删;每次一个文件,两个编辑框同时测不会互相改掉对方的配置
    if (ipUrls.length) {
      const configPath = `${paths.etc}/config.latency-chain-${++chainProbeSeq}.json`
      try {
        await ctx.mkdirp(paths.etc)
        await ctx.writeFile(configPath, JSON.stringify({
          log: { level: 'error' },
          ...(upstreamSet.dnsServers.length ? { dns: { servers: upstreamSet.dnsServers } } : {}),
          ...(process.platform === 'linux' ? { route: { default_mark: PROBE_MARK } } : {}),
          outbounds: [chainOutbound, ...upstreamSet.outbounds],
        }, null, 2))
      } catch (err) {
        return res.status(500).json({ error: `failed to write probe config: ${(err && err.message) || err}` })
      }
      try {
        const errors = []
        for (const ipUrl of ipUrls) {
          const ip = await fetchVia(ctx, paths, configPath, CHAIN_PROBE_TAG, ipUrl, timeoutMs)
          let data = null
          try { data = ip.ok ? JSON.parse(ip.stdout) : null } catch { /* 不是 JSON:多半是拒绝页 */ }
          if (data && typeof data.ip === 'string' && data.ip) {
            out.ip = { ok: true, url: ipUrl, body: ip.stdout.slice(0, 16384) }
            break
          }
          errors.push(`${new URL(ipUrl).hostname}: ${ip.ok ? '返回的不是 IP 信息' : ip.error}`)
          if (!ip.ok && !out.ok) break // 线路本身不通,别的接口也一样,不再挨个等超时
        }
        if (!out.ip) out.ip = { ok: false, error: errors.join(';') }
      } finally {
        // 先删再回:临时配置里有凭据,不能等响应发出去之后再删
        await ctx.remove(configPath).catch(() => {})
      }
    }
    res.json(out)
  })

  app.use('/api/openbox', router)
}
