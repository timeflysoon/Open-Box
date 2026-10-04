// 探测请求拿到的 HTTP 响应头里认「人机验证」:chatgpt.com 这类站给非浏览器客户端一律回 403 + Cloudflare
// 的 managed challenge(cf-mitigated: challenge),浏览器跑一段 JS 就过了,和线路通不通没关系。规则页的
// 「真实路由」把它和真正的 403 分开说,不然用户看到「拒绝了访问」以为节点不行(chatgpt.com 实测就是这样)。
// 只认有明确标记的:普通的 Cloudflare 403 可能是真的 WAF / 地区封锁,那和线路有关,不能一概说成人机验证
export const parseHeaderBlock = (text) => {
  const out = {}
  for (const line of String(text || '').split('\r\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    if (!(name in out)) out[name] = line.slice(i + 1).trim()
  }
  return out
}

// 只把和判定有关的几个头带回前端,别把整份响应头塞进结果
export const pickProbeHeaders = (headers) => {
  const out = {}
  for (const name of ['server', 'cf-mitigated', 'cf-ray']) if (headers && headers[name]) out[name] = String(headers[name]).slice(0, 120)
  return out
}

export const detectChallenge = (status, headers) => {
  if (!headers) return ''
  if (String(headers['cf-mitigated'] || '').toLowerCase() === 'challenge') return 'cloudflare'
  return ''
}
