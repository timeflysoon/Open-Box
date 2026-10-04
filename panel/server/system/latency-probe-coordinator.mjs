// 自动优选和故障转移共用的节点探测时间线。
//
// 同一个节点只有在测速地址相同的情况下才能复用结果。每个使用者注册自己的
// interval,节点下一次实际探测时间取这些 interval 的最小值;较长 interval 的
// 使用者到点时直接复用较短 interval 产生的结果,不再另发一次请求。

const keyOf = (tag, url) => `${String(tag || '')}\0${String(url || '')}`

export const createLatencyProbeCoordinator = ({ now = () => Date.now() } = {}) => {
  const registrations = new Map() // probe key -> owner -> interval ms
  const entries = new Map() // probe key -> last completed result
  const inFlight = new Map() // probe key -> Promise<result>

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

  const request = async ({ tag, url, intervalMs, run, force = false }) => {
    const key = keyOf(tag, url)
    const at = now()
    const cached = entries.get(key)
    const effective = intervalFor(key, intervalMs)
    if (!force && cached && at - cached.at >= 0 && at - cached.at < effective) {
      return { ...cached, reused: true }
    }
    // force 只绕过缓存的新鲜度判断,不能绕过正在进行的请求;超时立即复查也
    // 必须在共享节点上只产生一个复查请求。
    if (inFlight.has(key)) return { ...(await inFlight.get(key)), reused: true }
    if (typeof run !== 'function') return cached ? { ...cached, reused: true } : null
    const pending = Promise.resolve().then(run).then((result) => {
      const observed = observe(tag, url, { ...(result || {}), at: Number(result?.at) || now() })
      return observed || { ...(result || {}), at: now() }
    }).finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key)
    })
    inFlight.set(key, pending)
    return pending
  }

  const clear = () => {
    registrations.clear()
    entries.clear()
    inFlight.clear()
  }

  return { keyOf, register, unregisterOwner, intervalFor, latest, observe, request, clear }
}

export { keyOf }
