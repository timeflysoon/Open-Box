// 自动组的硬性定时测速。
//
// sing-box 的 URLTest 组是"懒惰"的:interval 只在这个组有流量经过时才起作用——启动时测一遍,
// 之后只有连接真正经过它才启动定时器,超过 idle_timeout 没流量又停掉。闲置的组永远停在启动
// 那一次结果上,用户设的检测间隔在没流量时不成立。这里由面板服务端按 interval 严格
// 定时:每 tick 看一眼每个 urltest 组最近一轮是什么时候(自己记的,或者成员里最新的一条——
// 内核启动自测、有流量时内核自己测都算),到点就调内核的组测速接口把这组测一遍。
//
// 到点的成员逐个用单节点测速接口测(GitHub #514;以前一次一个组调组测速接口):force=false,最近 interval 内测过的
// 内核直接复用,几个组共用的节点每个 interval 只测一次,代价 = 节点数,不是组数 × 节点数。请求都经面板全局的测速名额
// (协调器带的 limiter,后台那一档),拿到名额才发,排队不算超时。测完再读一次 /proxies:有新结果的记进延迟历史;
// 内核答失败(503 / 504)的记 0。
//
// 以前的组测速有三处咬成一个死循环:组测速排在内核后台队里,还要等组自己正在跑的检测(队头阻塞);面板按成员数算的
// 期限一到就掐断请求,内核那一批后面的成员跟着不测;掐断的那轮不记账,30 秒后原样再发。单节点测速不跟着请求断
// (内核测完照样记结果),每个成员测完不管通没通、有没有回话都记账,到下一个 interval 才再测。
import { CLASH_API_BASE } from '../api/penetration.mjs'
import { processUptime } from './service.mjs'
import { fetchJson } from './fetch-json.mjs'
import { parseDuration } from '../engine/duration.mjs'
import { isInternalTag } from '../engine/user-groups.mjs'
import { expectedQuery, kernelTestUrl, probeKeyUrl } from '../engine/test-url.mjs'

export { parseDuration }

const DEFAULT_INTERVAL_MS = 300_000
const latestTime = (proxy) => {
  const history = proxy && Array.isArray(proxy.history) ? proxy.history : []
  const last = history[history.length - 1]
  const t = last ? Date.parse(last.time) : NaN
  return Number.isFinite(t) ? t : 0
}

// URLTest 组可以引用另一个组。调度按真实节点(叶子出站)去重,否则后一个组会把
// 已经由前一个组测过的嵌套成员误认为尚未测速。
const leafMembersOf = (proxies, members, seen = new Set()) => {
  const leaves = []
  for (const member of Array.isArray(members) ? members : []) {
    if (seen.has(member)) continue
    const proxy = proxies[member]
    if (proxy && Array.isArray(proxy.all) && proxy.all.length) {
      seen.add(member)
      leaves.push(...leafMembersOf(proxies, proxy.all, seen))
      continue
    }
    leaves.push(member)
  }
  return [...new Set(leaves)]
}

// 后台测速在内核里可能要排很久(内核刚启动时自己把所有组自测一遍,也在后台那一档):本地多等一会儿。等不到也不要紧,
// 内核测完照样记结果,下一个 tick 从 /proxies 里看得到
const BACKGROUND_QUEUE_GRACE_MS = 10 * 60_000

export const createLatencyScheduler = ({
  store, ctx, paths, history, fetchImpl = globalThis.fetch, now = () => Date.now(),
  probeCoordinator = null, limiter = null, tickMs = 30_000, log = () => {},
}) => {
  // 每个自动优选组/成员上一次由该组发起或消费的轮次。节点是否真的需要探测,
  // 由共享协调器按所有组的 interval 决定;这里保留组自己的周期,避免长周期组
  // 因为短周期组有结果而每个 tick 重复调用内核组接口。
  const lastTested = new Map()
  const owner = (tag) => `urltest:${tag}`
  const registeredOwners = new Set()
  const headers = () => {
    const secret = store.getClashSecret ? store.getClashSecret() : ''
    return secret ? { Authorization: `Bearer ${secret}` } : {}
  }
  const fetchProxies = async () => {
    const { res, body } = await fetchJson(fetchImpl, `${CLASH_API_BASE}/proxies`, { headers: headers() }, 5000)
    if (!res || !res.ok) throw new Error(`proxies HTTP ${res ? res.status : 'none'}`)
    return (body && body.proxies) || {}
  }
  const kernelStart = async () => {
    const uptime = await processUptime(ctx, 'sing-box')
    return typeof uptime === 'number' ? now() - uptime * 1000 : null
  }
  const readGroups = async () => {
    const cfg = JSON.parse(await ctx.readFile(paths.configPath))
    // 故障转移的内部子组不在这里调度:它们的检测由 system/failover-manager.mjs 按父组的间隔统一做,两个调度器
    // 不重复发起同一批检查
    const groups = (cfg.outbounds || [])
      .filter((o) => o && o.type === 'urltest' && o.tag && !isInternalTag(o.tag))
      // 保留组配置的检测地址；随包内核的 Clash API 和原生定时探测均支持 HTTP / HTTPS。
      // keyUrl:测速去重的键,带上组的可接受状态码(内核 tcp19 的 expected_status;故障转移那边同样这么记)
      .map((o) => {
        const expected = typeof o.expected_status === 'string' ? o.expected_status : ''
        return { tag: o.tag, url: kernelTestUrl(o.url || ''), expected, keyUrl: probeKeyUrl(kernelTestUrl(o.url || ''), expected), intervalMs: parseDuration(o.interval) || DEFAULT_INTERVAL_MS, members: Array.isArray(o.outbounds) ? o.outbounds : [] }
      })
    return groups
  }

  // 只读一次 /proxies 把看到的变化记下来,不发起测速(面板手动测完后调用,结果马上进历史)
  const sync = async () => {
    let proxies
    try { proxies = await fetchProxies() } catch { return false }
    return history.recordFromProxies(proxies, { kernelStartedAt: await kernelStart(), at: now() })
  }

  const DEFAULT_MEMBER_TIMEOUT_MS = 5000
  // 每个成员的探测超时跟「面板设置 → 延迟 → 测速超时」走:浏览器把它同步到服务端同一张 KV 表的
  // config/speedtest-timeout(VueUse 存的是裸数字字符串)。没设 / 不合法按 5 秒
  const memberTimeoutMs = () => {
    try {
      const raw = typeof store.getRaw === 'function' ? store.getRaw('config/speedtest-timeout') : null
      if (raw === null || raw === undefined || raw === '') return DEFAULT_MEMBER_TIMEOUT_MS
      let n = Number(raw)
      if (!Number.isFinite(n)) n = Number(JSON.parse(raw))
      return Number.isFinite(n) && n >= 1000 && n <= 60_000 ? Math.round(n) : DEFAULT_MEMBER_TIMEOUT_MS
    } catch { return DEFAULT_MEMBER_TIMEOUT_MS }
  }

  // 测一个成员(拿到名额才调用):200 = 通过;503 / 504 = 这个节点失败;别的(请求出错、等不到、其他状态码)= 未知,
  // 不是节点的结果
  const probeMember = async (unit, memberMs) => {
    const at = now()
    try {
      const { res, body } = await fetchJson(fetchImpl, `${CLASH_API_BASE}/proxies/${encodeURIComponent(unit.member)}/delay?url=${encodeURIComponent(unit.url)}&timeout=${memberMs}&force=false&interval=${unit.intervalMs}&priority=background${expectedQuery(unit.expected)}`, { headers: headers() }, memberMs + BACKGROUND_QUEUE_GRACE_MS)
      if (!res) return { ok: null, at, reason: 'no-response' }
      const completedAt = Date.parse(body?.time)
      const observedAt = Number.isFinite(completedAt) && completedAt > 0 ? completedAt : now()
      const reused = Boolean(body && body.reused === true)
      if (res.ok) {
        const delay = body && Number.isFinite(Number(body.delay)) ? Number(body.delay) : 0
        return delay > 0 ? { ok: true, delay, at: observedAt, reused } : { ok: false, delay: 0, at: observedAt, reused, reason: 'zero-delay' }
      }
      if (res.status === 503 || res.status === 504) return { ok: false, delay: 0, at: observedAt, reused, reason: res.status === 504 ? 'timeout' : 'failed' }
      return { ok: null, at, reason: `http-${res.status}` }
    } catch (err) {
      return { ok: null, at, reason: err && err.name === 'AbortError' ? 'probe-timeout' : (err instanceof Error ? err.message : String(err)) }
    }
  }

  let inFlight = false
  const tick = async () => {
    // 上一轮还没跑完(大组一轮要一两分钟)就不叠着跑
    if (inFlight) return { skipped: 'busy' }
    inFlight = true
    try {
      return await runTick()
    } finally {
      inFlight = false
    }
  }

  const runTick = async () => {
    let proxies
    try { proxies = await fetchProxies() } catch { return { skipped: 'kernel' } }
    const kernelStartedAt = await kernelStart()
    let groups
    try { groups = await readGroups() } catch { return { skipped: 'config' } }
    if (probeCoordinator) {
      const currentOwners = new Set(groups.map((g) => owner(g.tag)))
      for (const id of registeredOwners) if (!currentOwners.has(id)) {
        probeCoordinator.unregisterOwner(id)
        registeredOwners.delete(id)
      }
      for (const g of groups) {
        const id = owner(g.tag)
        probeCoordinator.unregisterOwner(id)
        for (const member of leafMembersOf(proxies, g.members)) probeCoordinator.register(id, member, g.keyUrl, g.intervalMs)
        registeredOwners.add(id)
      }
    }
    const groupIntervals = Object.fromEntries(groups.map((g) => [g.tag, g.intervalMs]))
    history.recordFromProxies(proxies, { kernelStartedAt, at: now(), groupIntervals })

    // 1. 到点的成员:到点按成员算,不按组算——一个组里各成员上次测的时刻不一样(共用的成员可能刚被别的组测过,
    // 一轮里靠后的成员比靠前的晚一分钟),谁到了 interval 谁就该测。同一个「节点 + 地址」几个组都到点只测一次
    const at = now()
    const units = new Map()
    for (const g of groups) {
      if (!g.url || !g.members.length) continue
      for (const m of leafMembersOf(proxies, g.members)) {
        const t = latestTime(proxies[m])
        const key = probeCoordinator?.keyOf(m, g.keyUrl)
        const shared = key ? probeCoordinator.latest(m, g.keyUrl) : null
        const observedAt = Math.max(t, shared?.at || 0)
        const ownSince = lastTested.get(`${g.tag}\0${m}`) || (!probeCoordinator ? lastTested.get(m) : 0) || 0
        const since = ownSince || observedAt
        if (since && at - since < g.intervalMs) continue
        // 长周期组到点时,如果短周期组刚完成了探测,本轮直接复用;只有共享结果
        // 也超过最短 interval 才需要真正触发一次探测。
        if (shared && at - shared.at >= 0 && at - shared.at < probeCoordinator.intervalFor(key, g.intervalMs)) continue
        const unitKey = `${m}\0${g.keyUrl}`
        const unit = units.get(unitKey) || { member: m, url: g.url, expected: g.expected, keyUrl: g.keyUrl, intervalMs: g.intervalMs, groups: [] }
        unit.intervalMs = Math.min(unit.intervalMs, g.intervalMs)
        unit.groups.push(g.tag)
        units.set(unitKey, unit)
      }
    }
    if (!units.size) return { tested: [], timeouts: [] }

    // 2. 全部交给名额排队(后台那一档),拿到名额才发
    const memberMs = memberTimeoutMs()
    const results = await Promise.all([...units.values()].map(async (unit) => {
      const run = () => probeMember(unit, memberMs)
      let r
      if (probeCoordinator) {
        const viaLimiter = probeCoordinator.limiter || !limiter ? run : () => limiter.run('background', run)
        r = await probeCoordinator.request({ tag: unit.member, url: unit.keyUrl, intervalMs: unit.intervalMs, run: viaLimiter, priority: 'background' })
      } else {
        r = await (limiter ? limiter.run('background', run) : run())
      }
      return [unit, r || { ok: null, at: now(), reason: 'no-result' }]
    }))

    // 3. 记账:测过的成员不管通没通、有没有回话,都到下一个 interval 才再测(以前掐断的那轮不记账,30 秒后原样重发)
    for (const [unit] of results) {
      for (const tag of unit.groups) lastTested.set(`${tag}\0${unit.member}`, at)
      if (!probeCoordinator) lastTested.set(unit.member, at)
    }
    // 测完读一次:新结果进历史;内核答失败的记 0,时间用那次失败自己的完成时刻。复用来的失败也记:内核自己的检测
    // (组自检、正在用的节点的 10 秒复查)测出来的失败面板没记过;别人记过的,历史里同一时刻的同一笔会去重
    try { proxies = await fetchProxies() } catch { /* 读不到就只记失败 */ }
    history.recordFromProxies(proxies, { kernelStartedAt, at: now(), groupIntervals })
    const samples = []
    for (const [unit, r] of results) {
      if (r.ok === false) samples.push({ name: unit.member, time: new Date(Number(r.at) || at).toISOString(), delay: 0 })
    }
    history.recordSamples(samples)
    const tested = groups.map((g) => g.tag).filter((tag) => results.some(([unit]) => unit.groups.includes(tag)))
    for (const tag of tested) {
      const mine = results.filter(([unit]) => unit.groups.includes(tag))
      const unknown = mine.filter(([, r]) => r.ok !== true && r.ok !== false).length
      log(`[latency] 定时测速 ${tag}:测 ${mine.length} 个${unknown ? `(${unknown} 个没等到结果)` : ''}`)
    }
    const timeouts = samples.map((x) => x.name)
    return { tested, timeouts }
  }

  let timer = null
  const start = () => {
    if (timer) return
    timer = setInterval(() => { tick().catch((err) => log(`[latency] tick 失败:${err instanceof Error ? err.message : err}`)) }, tickMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const stop = () => { if (timer) clearInterval(timer); timer = null }
  return { tick, sync, start, stop }
}
