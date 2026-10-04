// 自动组的硬性定时测速。
//
// sing-box 的 URLTest 组是"懒惰"的:interval 只在这个组有流量经过时才起作用——启动时测一遍,
// 之后只有连接真正经过它才启动定时器,超过 idle_timeout 没流量又停掉。闲置的组永远停在启动
// 那一次结果上,用户设的检测间隔在没流量时不成立。这里由面板服务端按 interval 严格
// 定时:每 tick 看一眼每个 urltest 组最近一轮是什么时候(自己记的,或者成员里最新的一条——
// 内核启动自测、有流量时内核自己测都算),到点就调内核的组测速接口把这组测一遍。
//
// 内核那个接口是 force=false 的:最近 interval 内测过的成员会被跳过,所以几个组共用的节点
// 每个 interval 只测一次,代价 = 节点数,不是组数 × 节点数。测完再读一次 /proxies:有新结果
// 的记进延迟历史;这轮该测(结果比 interval 老或本来就没有)却仍没有结果的成员就是超时,记 0。
import { CLASH_API_BASE } from '../api/penetration.mjs'
import { processUptime } from './service.mjs'
import { parseDuration } from '../engine/duration.mjs'
import { isInternalTag } from '../engine/user-groups.mjs'
import { kernelTestUrl } from '../engine/test-url.mjs'

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

const withTimeout = async (fetchImpl, url, init, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export const createLatencyScheduler = ({
  store, ctx, paths, history, fetchImpl = globalThis.fetch, now = () => Date.now(),
  probeCoordinator = null, tickMs = 30_000, log = () => {},
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
    const res = await withTimeout(fetchImpl, `${CLASH_API_BASE}/proxies`, { headers: headers() }, 5000)
    if (!res || !res.ok) throw new Error(`proxies HTTP ${res ? res.status : 'none'}`)
    const body = await res.json()
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
      .map((o) => ({ tag: o.tag, url: kernelTestUrl(o.url || ''), intervalMs: parseDuration(o.interval) || DEFAULT_INTERVAL_MS, members: Array.isArray(o.outbounds) ? o.outbounds : [] }))
    return groups
  }

  // 只读一次 /proxies 把看到的变化记下来,不发起测速(面板手动测完后调用,结果马上进历史)
  const sync = async () => {
    let proxies
    try { proxies = await fetchProxies() } catch { return false }
    return history.recordFromProxies(proxies, { kernelStartedAt: await kernelStart(), at: now() })
  }

  // 组测速请求的等待上限:按这轮真要测的成员数算,再留 15 秒余量。不能设成固定 20 秒——内核用这个请求的 ctx 跑批测,
  // 请求一断后面的成员就不测了(正式路由器「所有-自动」212 个成员,以前每轮只测到一半)。
  // 内核 1.14.1-openbox-tcp14 起组批量测速全内核限速:最多 4 个同时测、相邻两次开始至少隔 0.25 秒(以前 10 个并发一口气测完,
  // 正式路由器每小时一次 288 个节点的测速把运营商大内网的新建连接冲垮,七成节点假超时、真实流量跟着卡)
  const KERNEL_CONCURRENCY = 4
  const KERNEL_SPACING_MS = 250
  const DEFAULT_MEMBER_TIMEOUT_MS = 5000
  const MAX_ROUND_WAIT_MS = 8 * 60_000
  // 每个成员的探测超时跟「面板设置 → 延迟 → 测速超时」走:浏览器把它同步到服务端同一张 KV 表的
  // config/speedtest-timeout(VueUse 存的是裸数字字符串)。内核 1.14.0-openbox-tcp5 起把组测速接口的
  // timeout 当成员各自的超时(和 Clash API 语义一致),不再是写死的 15 秒。没设 / 不合法按 5 秒
  const memberTimeoutMs = () => {
    try {
      const raw = typeof store.getRaw === 'function' ? store.getRaw('config/speedtest-timeout') : null
      if (raw === null || raw === undefined || raw === '') return DEFAULT_MEMBER_TIMEOUT_MS
      let n = Number(raw)
      if (!Number.isFinite(n)) n = Number(JSON.parse(raw))
      return Number.isFinite(n) && n >= 1000 && n <= 60_000 ? Math.round(n) : DEFAULT_MEMBER_TIMEOUT_MS
    } catch { return DEFAULT_MEMBER_TIMEOUT_MS }
  }
  // 一轮最长 = max(波数 × 成员超时, 成员数 × 起测间隔) + 余量:不通的成员各占满自己的超时
  const roundWaitMs = (dueCount, memberMs) => Math.min(MAX_ROUND_WAIT_MS, Math.max(Math.ceil(dueCount / KERNEL_CONCURRENCY) * memberMs, dueCount * KERNEL_SPACING_MS) + 15_000)

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
        for (const member of leafMembersOf(proxies, g.members)) probeCoordinator.register(id, member, g.url, g.intervalMs)
        registeredOwners.add(id)
      }
    }
    const groupIntervals = Object.fromEntries(groups.map((g) => [g.tag, g.intervalMs]))
    history.recordFromProxies(proxies, { kernelStartedAt, at: now(), groupIntervals })

    const tested = []
    const timeouts = []
    for (const g of groups) {
      if (!g.url || !g.members.length) continue
      // 到点按成员算,不按组算:一个组里各成员上次测的时刻不一样(共用的成员可能刚被别的组测过,
      // 一轮里靠后的成员比靠前的晚一分钟),谁到了 interval 谁就该测。每个组都按此刻最新的
      // /proxies 判,前一个组刚测过的共用成员这里就不算到点。
      // 内核的组测速是 force=false 的,没到 interval 的成员它自己会跳过,所以一次请求只测到点的。
      const at = now()
      const members = leafMembersOf(proxies, g.members)
      const due = members.filter((m) => {
        const t = latestTime(proxies[m])
        const key = probeCoordinator?.keyOf(m, g.url)
        const shared = key ? probeCoordinator.latest(m, g.url) : null
        const observedAt = Math.max(t, shared?.at || 0)
        const ownSince = lastTested.get(`${g.tag}\0${m}`) || (!probeCoordinator ? lastTested.get(m) : 0) || 0
        const since = ownSince || observedAt
        if (since && at - since < g.intervalMs) return false
        // 长周期组到点时,如果短周期组刚完成了探测,本轮直接复用;只有共享结果
        // 也超过最短 interval 才需要真正触发一次探测。
        if (shared && at - shared.at >= 0 && at - shared.at < probeCoordinator.intervalFor(key, g.intervalMs)) return false
        return true
      })
      if (!due.length) continue
      let ok = false
      // 内核 1.14.1-openbox-tcp14 起组测速回应带 X-Openbox-Group-Check: complete:回来的名单就是这一轮通过的成员
      // (组正在测时加入那一轮、等它测完,不再回空),不在名单里的就是这轮没测通。老内核没有这个头,仍按历史判
      let passed = null
      try {
        // 调度器不是用户手动点的“立即测速”:明确要求内核遵守该组及共享节点
        // 最近一次结果的 interval,避免和 sing-box 自己的后台 URLTest 轮询叠加,
        // 导致同一节点在几秒内被测两遍。手动测速仍不带 force=false,保留强制行为。
        // timeout = 每个成员自己的探测超时(面板「测速超时」设置);整次请求的期限内核按成员数自己放宽,
        // 这里本地等待也按波数算。tcp3 及以前 timeout 是整次请求的期限、面板只给 5 秒:内核到点把还没测完
        // 的成员全按失败处理、删掉历史——正式路由器实测「日本-自动」6 个活节点同一秒全记成超时,组里没有
        // 一个成员有结果,内核无从切换,只能停在原来那个节点上(哪怕它这次真的超时了)
        const memberMs = memberTimeoutMs()
        const res = await withTimeout(fetchImpl, `${CLASH_API_BASE}/group/${encodeURIComponent(g.tag)}/delay?url=${encodeURIComponent(g.url)}&timeout=${memberMs}&force=false&priority=background`, { headers: headers() }, roundWaitMs(due.length, memberMs) + 5000)
        ok = Boolean(res && res.ok)
        if (!ok) log(`[latency] 组 ${g.tag} 定时测速返回 HTTP ${res ? res.status : 'none'}`)
        else if (res.headers && typeof res.headers.get === 'function' && res.headers.get('x-openbox-group-check') === 'complete') {
          const body = await res.json().catch(() => null)
          if (body && typeof body === 'object' && !Array.isArray(body)) passed = body
        }
      } catch (err) {
        log(`[latency] 组 ${g.tag} 定时测速请求失败:${err instanceof Error ? err.message : err}`)
      }
      tested.push(g.tag)
      // 测完马上读一次:新结果立刻进历史,后面的组也按新数据判要不要测
      try { proxies = await fetchProxies() } catch { break }
      history.recordFromProxies(proxies, { kernelStartedAt, at: now(), groupIntervals })
      // 这轮该测却仍没有结果的成员就是超时。请求中途断掉的那轮不判:没测到的成员不是超时
      if (ok) {
        const time = new Date(at).toISOString()
        const samples = []
        for (const m of due) {
          lastTested.set(`${g.tag}\0${m}`, at)
          if (!probeCoordinator) lastTested.set(m, at)
          const p = proxies[m]
          if (!p || typeof p !== 'object') continue
          if (Array.isArray(p.all) && p.all.length) continue
          const latest = p.history && p.history.length ? p.history[p.history.length - 1] : null
          // 这轮通没通:新内核看回来的名单(正在用的节点失败时内核先留着旧记录、10 秒后复查,历史上看不出这轮失败了);
          // 老内核失败就删历史,没有结果就是这轮没通
          const failedThisRound = passed ? !(Number(passed[m]) > 0) : !latestTime(p)
          if (failedThisRound) {
            samples.push({ name: m, time, delay: 0 })
            // 内核组测速失败时删掉历史,分不出超时还是连不上;按超时交给共享时间线(故障转移按它判「当前页签全部超时」)
            probeCoordinator?.observe(m, g.url, { ok: false, delay: 0, at, reason: 'timeout' })
          } else if (passed) {
            probeCoordinator?.observe(m, g.url, { ok: true, delay: Number(passed[m]), at: latest && Date.parse(latest.time) ? Date.parse(latest.time) : at })
          } else {
            probeCoordinator?.observe(m, g.url, { ok: Number(latest.delay) > 0, delay: Number(latest.delay) || 0, at: Date.parse(latest.time) || at })
          }
        }
        history.recordSamples(samples)
        timeouts.push(...samples.map((x) => x.name))
      }
      log(`[latency] 定时测速 ${g.tag}:测 ${due.length} 个${ok ? '' : '(请求未完成)'}`)
    }
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
