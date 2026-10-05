// 拉订阅时「一次响应之后怎么办」「拉完之后怎么收尾」:路由器(api/subscriptions.mjs 的 resolveNodes、refreshSubscriptionById)
// 和 App 本地分流(client-engine 的 evaluate / finish)共用这一份——PM 2026-10-04:手机本机刷新订阅,用和路由器同一套代码。
// 只做判断,不联网:拉取由调用方做(路由器:Node fetch + 逐跳校验 + curl 兜底;App:OkHttp)。
import { parseSubscription } from './subscription.mjs'
import { excludeNodes, previewRename, renameNodes, subscriptionRenameOptions } from './rename.mjs'

// 机场订阅端点普遍按 User-Agent 决定回什么:UA 里带 clash / sing-box 之类的关键字才
// 给对应格式的订阅,不认识的 UA 通常退回一份 base64 分享链接、有时干脆是网页。Node 的
// fetch 默认发 "User-Agent: node",没有任何机场会认——实测同一个订阅地址三种 UA 拿到
// 三份完全不同的响应(base64 8.5KB / Clash YAML 36KB / sing-box JSON 15KB)。
// 按信息量从高到低依次尝试,拿到能解析出节点的那一份就停:Clash YAML 字段最全(udp、
// 指纹、alpn 都在),sing-box JSON 次之,最后才退回默认 UA 那一份。
// 逐个试的 User-Agent:有些机场只认几个客户端的 UA,别的一律 403(GitHub #27)。前面是常见的
// 第三方客户端,最后才是我们自己的名字
export const SUBSCRIPTION_USER_AGENTS = Object.freeze([
  'clash-verge/v2.0.0',
  'ClashMetaForAndroid/2.11.0',
  'mihomo/1.19.0',
  'clash-verge-rev/2.3.0',
  'sing-box/1.14.0',
  'Open-Box/1.0',
])

export const SUBSCRIPTION_FETCH_TIMEOUT_MS = 15000
export const MAX_SUBSCRIPTION_RESPONSE_BYTES = 5 * 1024 * 1024
export const MAX_SUBSCRIPTION_REDIRECTS = 3

// 订阅地址可以填多个(镜像、备用、几个机场合成一条):数组 urls 优先,老字段 url 只在没给
// 数组时算一条。去空白、去重、顺序保留——第一条兼作老字段 url,给还只认单个地址的地方用。
export const normalizeUrls = (urls, url) => {
  const list = Array.isArray(urls) && urls.length ? urls : (typeof url === 'string' ? [url] : [])
  return [...new Set(list.filter((u) => typeof u === 'string').map((u) => u.trim()).filter(Boolean))]
}

// 一条订阅记录的全部地址:新记录存 urls,老记录只有 url
export const subscriptionUrls = (sub) =>
  (sub && Array.isArray(sub.urls) && sub.urls.length ? sub.urls : (sub && sub.url ? [sub.url] : []))


// 一个节点都没解析出来时,把原因说清楚。以前这种情况是"静默成功":订阅照样存下、
// nodeCount 记 0,界面上只剩一句「0 个节点」,既看不出是没抓到、没认出格式,还是
// 协议不支持——用户除了反复点刷新无事可做。
export const describeEmptyResult = ({ format, skipped }) => {
  if (format === 'unknown') {
    return '无法识别订阅内容的格式（既不是 Clash YAML、sing-box JSON,也不是分享链接）。' +
      '请确认订阅地址填的是订阅链接本身,而不是机场的网页地址。'
  }
  const types = [...new Set((skipped || []).map((s) => s.type).filter(Boolean))]
  if (types.length) {
    return `订阅解析成功（${format} 格式）,但其中 ${skipped.length} 个节点使用的协议都不受支持:` +
      `${types.join('、')}。`
  }
  return `订阅解析成功（${format} 格式）,但里面一个节点都没有。`
}

// 所有尝试都被服务器按状态码拒了:按状态码说原因,一句话、给出下一步(用户 2026-09-30:瞬云订阅链接失效,刷新没有任何提示、
// 以前的报错把 12 次尝试逐条列出来还让去问机场)。逐条的明细只进日志
const LINK_INVALID_STATUSES = new Set([401, 403, 404, 410])
export const describeRejection = (statuses, tried) => {
  // 第一次请求就 429 才是真限流;先被 403 拒、换 UA 重试时才 429,那是我们自己敲出来的,原因还是前面的状态码
  if (statuses[0] === 429) return '订阅服务器限流了(HTTP 429,请求太频繁),过一会儿再刷新'
  const codes = [...new Set(statuses.filter((c) => c !== 429))].sort((a, b) => a - b)
  const codeText = `HTTP ${codes.join(' / ')}`
  if (codes.length && codes.every((c) => LINK_INVALID_STATUSES.has(c))) {
    return `订阅链接被机场拒绝(${codeText},换了 ${tried} 种客户端标识都一样):多半是订阅链接已重置或失效,节点通常也跟着失效。请到机场网站复制新的订阅链接,点这条订阅的「修改」换上`
  }
  if (codes.length && codes.every((c) => c >= 500)) return `订阅服务器出错(${codeText}),稍后再试;一直这样请联系机场`
  return `订阅服务器拒绝了请求(${codeText},换了 ${tried} 种客户端标识都不行),请联系机场确认是否限制第三方客户端`
}

// ---- 一个地址:按 SUBSCRIPTION_USER_AGENTS 逐个试 ----
// 过程状态(JSON 能表示,App 原样带着进出):
//   statuses       服务器回的状态码(按它说原因)
//   rejected       每次没成的明细「UA → 原因」,只进日志;tried 按它数用过几种 UA
//   firstParsed    第一份拉到了、解析得出格式却一个节点都没有的结果(报错时它优先)
//   transportError 传输层的错(地址不通、SSRF 校验、超长、跳转太多……):和 UA 无关,不再换 UA
export const newAttemptState = () => ({ statuses: [], rejected: [], firstParsed: null, transportError: '' })

// 一次响应怎么办。response = { userAgent, status, body, usage } 或 { userAgent, error }(error 是传输层错误的原文)。
// 回 { action, state, part? }:
//   accept 解析出了节点,part = { nodes, skipped, format, usage } 交给 finishSubscription
//   next   换下一个 UA 再拉(被状态码拒了、或者拉到了却一个节点都没有);没有下一个了就当 stop
//   stop   别再试了:429 限流(再换 UA 敲只会更久)、传输层出错
export const evaluateAttempt = (state, { userAgent, status, body, usage = null, error = '' }) => {
  const next = { ...state, statuses: [...state.statuses], rejected: [...state.rejected] }
  if (error) {
    next.transportError = String(error)
    next.rejected.push(`${userAgent} → ${error}`)
    return { action: 'stop', state: next }
  }
  if (!(status >= 200 && status < 300)) {
    // 带上状态码:403 / 401 这类多半是机场按 UA 拒的,换下一个 UA 再试
    next.rejected.push(`${userAgent} → HTTP ${status}`)
    next.statuses.push(status)
    return { action: status === 429 ? 'stop' : 'next', state: next }
  }
  const parsed = parseSubscription(body || '')
  if (parsed.nodes.length) return { action: 'accept', part: { ...parsed, usage }, state: next }
  if (!next.firstParsed) next.firstParsed = parsed
  return { action: 'next', state: next }
}

// 用过几种 UA(curl 那一轮和同一个 UA 算一种)
export const attemptsTried = (state) => new Set(state.rejected.map((r) => r.replace(/^curl /, '').split(' → ')[0])).size

// 一个地址试完了还没拿到节点,报什么:拉到了却没节点 > 传输层的错 > 被状态码拒
export const attemptFailure = (state) => {
  if (state.firstParsed) return describeEmptyResult(state.firstParsed)
  if (state.transportError) return state.transportError
  return describeRejection(state.statuses, attemptsTried(state))
}

// ---- 拉完收尾 ----
// parts:每个地址收下的那一份(evaluateAttempt 的 part;粘贴内容就是 parseSubscription 的结果)。
// 多个地址:各家的节点按地址顺序接起来;同一个节点在两个地址里都出现(镜像地址)只留一份,不然会被 dedupeNodeTags 编成 xx-2。
// renameNodes / groupNodesByRegion 的默认参数只兜底 undefined;显式传 null(合法 JSON 值)会在其内部触发 "options.xxx of null",
// subscriptionRenameOptions 统一归一化。prefix 是「usePrefix 开关 + 订阅名」的派生值,不进持久化的 renameOptions(base)。
// 过滤必须发生在改名之前:renameNodes / previewRename 按下标一一对应,而且被过滤掉的条目连预览表都不该出现
export const finishSubscription = ({ parts, renameOptions, name }) => {
  const { base, effective: opts } = subscriptionRenameOptions(renameOptions, name)
  const parsed = parts.length === 1 ? parts[0] : mergeParts(parts)
  const { kept, excluded, disabled } = excludeNodes(parsed.nodes, opts || {})
  return {
    renamed: renameNodes(kept, opts),
    skipped: parsed.skipped,
    excluded: excluded.map((n) => ({ name: n.originalTag })),
    disabled: disabled.map((n) => ({ name: n.originalTag })),
    format: parsed.format,
    preview: previewRename(kept, opts),
    renameOptions: base,
    // 机场给的已用 / 总量 / 到期(响应头 subscription-userinfo),粘贴内容的订阅没有
    usage: parsed.usage || null,
  }
}

const mergeParts = (parts) => {
  const seen = new Set()
  const nodes = []
  for (const part of parts) {
    for (const node of part.nodes) {
      const key = JSON.stringify(node)
      if (seen.has(key)) continue
      seen.add(key)
      nodes.push(node)
    }
  }
  const formats = [...new Set(parts.map((p) => p.format))]
  return { nodes, skipped: parts.flatMap((p) => p.skipped), format: formats.join('+'), usage: (parts.find((p) => p.usage) || {}).usage || null }
}

// 刷新成功后订阅记录上要改的字段(其余以此刻存的为准);now 是毫秒
export const refreshedFields = (resolved, now) => ({
  format: resolved.format,
  nodeCount: resolved.renamed.length,
  renameOptions: resolved.renameOptions || {},
  updatedAt: now,
  ...(resolved.usage ? { usage: { ...resolved.usage, at: now } } : {}),
})
