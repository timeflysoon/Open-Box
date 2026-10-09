// 发一个请求并读出 JSON 正文,整个过程(连回应正文)受同一个期限约束(GitHub #514)。以前的写法期限只管到回应头:
// 回应头到了、正文一直不结束时会一直挂着,等它的那一轮(以及共享这个请求的别的调用方)也跟着挂住。
// 读正文和中止信号赛跑,不依赖底层 fetch 会不会在中止时打断正文。正文不是 JSON(204 之类)给 null
export const fetchJson = async (fetchImpl, url, init, timeoutMs) => {
  const controller = new AbortController()
  let onAbort = null
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), aborted])
    if (!res) return { res: null, body: null }
    let body = null
    try {
      body = await Promise.race([typeof res.json === 'function' ? res.json() : null, aborted])
    } catch (err) {
      if (err && err.name === 'AbortError') throw err
    }
    return { res, body }
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
