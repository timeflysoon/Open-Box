// 自动优选和故障转移共用的节点探测时间线。
//
// 同一个节点只有在测速地址相同的情况下才能复用结果。每个使用者注册自己的
// interval,节点下一次实际探测时间取这些 interval 的最小值;较长 interval 的
// 使用者到点时直接复用较短 interval 产生的结果,不再另发一次请求。
//
// 真正发给内核的请求都经 limiter(system/probe-limiter.mjs,面板全局一份测速名额,GitHub #514):拿到名额才发,排队不算
// 请求自己的超时。同一节点同一地址正在排队 / 正在测时,后来的调用方加入同一个请求;更急的(复查 critical、例行
// interactive)加入还在排队的低档请求,就把它挪到自己那一档。调用方可以带 signal(轮次作废 / 刷新):自己先退出,
// 等着这个请求的调用方全都退出了,还在排队的请求才撤掉(已经发出去的照常测完、照常记结果)。

const keyOf = (tag, url) => `${String(tag || '')}\0${String(url || '')}`
const RANK = { critical: 0, interactive: 1, background: 2 }

export const createLatencyProbeCoordinator = ({ now = () => Date.now(), limiter = null } = {}) => {
  const registrations = new Map() // probe key -> owner -> interval ms
  const entries = new Map() // probe key -> last completed result
  const inFlight = new Map() // probe key -> { promise, waiters, controller, bump, priority }

  const register = (owner, tag, url, intervalMs) => {
    const key = keyOf(tag, url)
    if (!owner || !key || !Number.isFinite(Number(intervalMs)) || Number(intervalMs) <= 0) return key
    const group = registrations.get(key) || new Map()
    group.set(String(owner), Math.max(1, Number(intervalMs)))
    registrations.set(key, group)
    return key
  }

  const unregisterOwner = (owner) => {
    const id = String(owner || '')
    if (!id) return
    for (const [key, group] of registrations) {
      group.delete(id)
      if (!group.size) registrations.delete(key)
    }
  }

  const intervalFor = (key, fallback) => {
    const values = [...(registrations.get(key)?.values() || [])]
    const own = Number(fallback)
    if (Number.isFinite(own) && own > 0) values.push(own)
    return values.length ? Math.min(...values) : 300_000
  }

  const latest = (tag, url) => {
    const item = entries.get(keyOf(tag, url))
    return item ? { ...item } : null
  }

  const observe = (tag, url, result) => {
    const key = keyOf(tag, url)
    if (!key || !result || typeof result !== 'object') return null
    const at = Number(result.at)
    if (!Number.isFinite(at)) return null
    // reused:内核说这是它缓存里别的使用者刚测完的(不是这次新发的请求),原样留着,记历史时不再记一笔
    const item = { ...result, at, reused: result.reused === true }
    const old = entries.get(key)
    if (!old || at >= old.at) entries.set(key, item)
    return { ...(entries.get(key) || item) }
  }

  // 一个调用方等某个正在进行的请求:signal 先中止就自己先回 { ok: null, reason: 'cancelled' },不再等;
  // 最后一个调用方也退出了,还在排队的请求撤掉
  const wait = (flight, signal) => {
    flight.waiters += 1
    if (!signal) return flight.promise
    return new Promise((resolve) => {
      let done = false
      const leave = () => {
        if (done) return
        done = true
        signal.removeEventListener('abort', leave)
        flight.waiters -= 1
        if (flight.waiters <= 0 && flight.queued()) {
          flight.controller.abort()
          if (inFlight.get(flight.key) === flight) inFlight.delete(flight.key)
        }
        resolve({ ok: null, at: now(), reason: 'cancelled' })
      }
      if (signal.aborted) { leave(); return }
      signal.addEventListener('abort', leave, { once: true })
      flight.promise.then((r) => {
        if (done) return
        done = true
        signal.removeEventListener('abort', leave)
        resolve(r)
      })
    })
  }

  // priority:critical | interactive | background(发给内核的那一档,也是在面板排队的那一档)
  const request = async ({ tag, url, intervalMs, run, force = false, priority = 'interactive', signal = null }) => {
    const key = keyOf(tag, url)
    const at = now()
    const cached = entries.get(key)
    const effective = intervalFor(key, intervalMs)
    if (!force && cached && at - cached.at >= 0 && at - cached.at < effective) {
      return { ...cached, reused: true }
    }
    if (signal && signal.aborted) return { ok: null, at, reason: 'cancelled' }
    // force 只绕过缓存的新鲜度判断,不能绕过正在进行的请求;超时立即复查也
    // 必须在共享节点上只产生一个复查请求。
    const existing = inFlight.get(key)
    if (existing) {
      if ((RANK[priority] ?? 1) < (RANK[existing.priority] ?? 1)) {
        existing.priority = priority
        existing.bump(priority)
      }
      return { ...(await wait(existing, signal)), reused: true }
    }
    if (typeof run !== 'function') return cached ? { ...cached, reused: true } : null
    const controller = new AbortController()
    const scheduled = limiter
      ? limiter.schedule(priority, run, { signal: controller.signal })
      : { result: Promise.resolve().then(run), bump: () => {}, queued: () => false }
    const flight = { key, waiters: 0, controller, bump: scheduled.bump, queued: scheduled.queued, priority, promise: null }
    flight.promise = scheduled.result.then((result) => {
      // 只把真结果(通过 / 失败)放进时间线:探测本身出了问题(ok: null,比如面板等不到回话)不是节点的结果,
      // 缓存下来会让之后一整个 interval 的请求都复用「未知」、一直不重测
      const real = result && (result.ok === true || result.ok === false)
      const observed = real ? observe(tag, url, { ...result, at: Number(result.at) || now() }) : null
      return observed || { ...(result || {}), at: Number(result?.at) || now() }
    }, (err) => {
      // 还在排队时调用方都退出了:没发出去,不是节点的结果,不进时间线
      if (err && err.cancelled) return { ok: null, at: now(), reason: 'cancelled' }
      return { ok: null, at: now(), reason: err instanceof Error ? err.message : String(err) }
    }).finally(() => {
      if (inFlight.get(key) === flight) inFlight.delete(key)
    })
    inFlight.set(key, flight)
    return wait(flight, signal)
  }

  // 每秒要测几个才跟得上:每个「节点 + 地址」按所有使用者里最短的 interval 算一次(GitHub #514「测速需求超过内核能力」)
  const demandPerSec = () => {
    let total = 0
    for (const key of registrations.keys()) total += 1000 / intervalFor(key)
    return total
  }

  const clear = () => {
    registrations.clear()
    entries.clear()
    for (const flight of inFlight.values()) flight.controller.abort()
    inFlight.clear()
  }

  return { keyOf, register, unregisterOwner, intervalFor, latest, observe, request, demandPerSec, clear, limiter }
}

export { keyOf }
