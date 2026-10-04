// 机场订阅响应里的 `subscription-userinfo` 头(Clash / sing-box 生态的事实标准):
//   subscription-userinfo: upload=123; download=456; total=107374182400; expire=1735660800
// upload / download / total 是字节,expire 是到期时间(Unix 秒);四项都可能缺。刷新订阅时顺手记下来,
// 卡片上显示「已用 / 总量 · 到期」。这里只做解析,不猜:缺的就是 null
const FIELDS = ['upload', 'download', 'total', 'expire']

export const parseSubscriptionUserinfo = (header) => {
  const text = typeof header === 'string' ? header : ''
  if (!text.trim()) return null
  const out = { upload: null, download: null, total: null, expire: null }
  let seen = false
  for (const part of text.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const key = part.slice(0, i).trim().toLowerCase()
    if (!FIELDS.includes(key)) continue
    const value = Number(part.slice(i + 1).trim())
    if (!Number.isFinite(value) || value < 0) continue
    // 有的机场把没有的项写成 0(total=0、expire=0):0 字节总量和 1970 年到期都没有意义,当作没给
    if (value === 0 && (key === 'total' || key === 'expire')) continue
    out[key] = Math.floor(value)
    seen = true
  }
  return seen ? out : null
}

// 从 fetch 的 Response(headers.get)或普通对象里取这个头
export const userinfoFromHeaders = (headers) => {
  if (!headers) return null
  if (typeof headers.get === 'function') return parseSubscriptionUserinfo(headers.get('subscription-userinfo'))
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'subscription-userinfo')
  return key ? parseSubscriptionUserinfo(headers[key]) : null
}
