import { randomUUID } from 'node:crypto'
import dns from 'node:dns/promises'
import express from 'express'
import { parseSubscription } from '../engine/subscription.mjs'
import { groupNodesByRegion } from '../engine/groups.mjs'
import { assertPublicUrl, pinnedLookup } from './net-guard.mjs'
import { subscriptionFetch } from '../system/insecure-fetch.mjs'
import { curlFetchText } from '../system/curl-fetch.mjs'
import { userinfoFromHeaders } from '../engine/subscription-userinfo.mjs'
import { normalizeNodeDns, validateNodeDns } from '../engine/node-dns.mjs'
import {
  MAX_SUBSCRIPTION_REDIRECTS, MAX_SUBSCRIPTION_RESPONSE_BYTES, SUBSCRIPTION_FETCH_TIMEOUT_MS, SUBSCRIPTION_USER_AGENTS,
  attemptsTried, describeEmptyResult, describeRejection, evaluateAttempt, finishSubscription, newAttemptState, normalizeUrls,
  refreshedFields, subscriptionUrls,
} from '../engine/subscription-fetch.mjs'
import { activeNodesOf, dedupeNodeTags, orderNodesBySubscriptions, rebuildNodePool } from '../engine/node-pool.mjs'
import { normalizeAutoUpdate } from '../engine/subscription-schedule.mjs'
import { refreshNameError, subscriptionNameError } from '../engine/name-guard.mjs'

// 订阅拉取的判断、节点池、定期更新的计划挪进了 engine(和 App 本地分流共用,PM 2026-10-04),原来从这里引的照旧能引
export { dedupeNodeTags, describeRejection, normalizeAutoUpdate, normalizeUrls, orderNodesBySubscriptions, subscriptionUrls }

// 面板本身跑在网关上,订阅拉取又是"服务端发起、URL 客户端可控"的经典 SSRF 面——
// 不加限制的话可以拿它当跳板探测回环/内网端口。P4a 复审证明了仅做"字面 IP"层面拒绝远远
// 不够(域名不解析就直接放行、IPv6 十六进制形式的 IPv4-mapped 地址漏判、redirect 不复检
// 等四种绕过均有 PoC),所以这里改为:assertPublicUrl 真正解析 hostname(node:dns/promises
// lookup + {all:true}),对每一个解析出的地址都判定;拉取时手动处理重定向,每一跳都重新校验。
// 内网 / 本机地址放行(allowPrivate,GitHub #42):自建在局域网或路由器上的 subconverter 出的订阅地址
// 就是 192.168.x.x / 127.0.0.1,用户是面板管理员、本来就能拿路由器做任何事,拦着只是添堵;仍拒
// 未指定地址和链路本地,重定向逐跳校验、校验过的地址钉死建连这两道闸不动。

// 粘贴保存下来的内容会跟着订阅记录一起进 store,并在每次改重命名规则时重新解析。
// 给个上限:store 是整条 JSON 读写的,塞进去一个几 MB 的配置会让每次读订阅列表都变慢。
const MAX_PASTED_CONTENT_BYTES = 1024 * 1024

// 响应体大小上限:优先走真实 fetch 的可读流累计计数(边读边截断,避免恶意/超大响应把
// 进程内存吃满);测试注入的 fetchImpl 通常只给一个 text() 方法、没有可读流,退化为读完
// 整体后按字节长度校验——同一条上限,只是校验时机不同。
const readSubscriptionBody = async (res, maxBytes) => {
  const body = res.body

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let received = 0
    let text = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > maxBytes) {
          throw new Error(`subscription response exceeds ${maxBytes} byte limit`)
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
      return text
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock()
    }
  }

  const text = await res.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`subscription response exceeds ${maxBytes} byte limit`)
  }
  return text
}

const errorMessage = (err) => (err instanceof Error ? err.message : String(err))

// 系统 fetch 把底层原因藏在 err.cause 里,面上只有一句 "fetch failed"——把 cause 带出来。
// node:http 的错误(ECONNREFUSED、ETIMEDOUT…)本身带 code,也一并带上。
const describeFetchError = (err) => {
  let message = errorMessage(err)
  const code = err && typeof err === 'object' && err.code ? String(err.code) : ''
  if (code && !message.includes(code)) message = `${code}: ${message}`
  const cause = err && typeof err === 'object' ? err.cause : null
  const causeCode = cause && typeof cause === 'object' ? String(cause.code || '') : ''
  const causeMessage = cause && typeof cause === 'object' && cause.message ? String(cause.message) : ''
  if (causeMessage && causeMessage !== message) message += ` (${causeCode ? `${causeCode}: ` : ''}${causeMessage})`
  return message
}

// 拉取订阅内容,手动处理重定向:默认 fetch 会自动跟随 3xx,首跳校验通过后就对
// Location 完全不设防——P4a 复审的 PoC 正是靠一个"看起来公网"的地址 302 到回环端口
// 拿到命中。这里用 redirect:'manual' 拿到原始 3xx 响应,每一跳(含首跳)都先跑
// assertPublicUrl,再决定要不要继续跟——最多跟 3 跳,超出或缺 Location 头一律拒绝。
const fetchSubscriptionResponse = async (initialUrl, fetchImpl, lookup, userAgent) => {
  let currentUrl = initialUrl
  let redirectsFollowed = 0
  // 流量 / 到期这个头**不一定在最后那跳上**:不少机场是 302 到文件地址,头挂在 302 那一跳,
  // 跟完重定向就没了(GitHub #212)。所以每跳都看一眼,记住第一个拿到的
  let hopUsage = null

  for (;;) {
    // 校验和建连必须是同一次解析:把校验过的地址交给 fetch 实现按它去连(insecure-fetch 会
    // 接到 node:http 的 lookup 上),Host / SNI 仍是域名。否则同一个域名校验时答公网、建连时
    // 答回环,就绕过了这道闸(DNS rebinding)。每一跳重定向都重新校验、重新绑定。
    const checked = await assertPublicUrl(currentUrl, { lookup, allowPrivate: true })

    let res
    try {
      res = await fetchImpl(currentUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(SUBSCRIPTION_FETCH_TIMEOUT_MS),
        lookup: pinnedLookup(checked.validatedRecords),
      })
    } catch (err) {
      throw new Error(`failed to fetch subscription: ${describeFetchError(err)}`)
    }

    if (!res) {
      throw new Error('failed to fetch subscription: no response')
    }

    if (!hopUsage) hopUsage = userinfoFromHeaders(res.headers)

    if (res.status >= 300 && res.status < 400) {
      if (redirectsFollowed >= MAX_SUBSCRIPTION_REDIRECTS) {
        throw new Error('too many redirects while fetching subscription')
      }

      const location = typeof res.headers?.get === 'function' ? res.headers.get('location') : null
      if (!location) {
        throw new Error('redirect response missing Location header')
      }

      currentUrl = new URL(location, currentUrl).toString()
      redirectsFollowed += 1
      continue
    }

    if (!res.ok) {
      // 带上状态码:调用方据此决定换下一个 UA 再试(403 / 401 这类多半是机场按 UA 拒的)
      const err = new Error(`failed to fetch subscription: HTTP ${res.status}`)
      err.httpStatus = res.status
      throw err
    }

    // 最后那跳没给就用重定向路上看到的那份
    return { res, usage: userinfoFromHeaders(res.headers) || hopUsage }
  }
}

export const fetchSubscriptionText = async (url, fetchImpl, lookup, userAgent) => {
  const { res } = await fetchSubscriptionResponse(url, fetchImpl, lookup, userAgent)
  return readSubscriptionBody(res, MAX_SUBSCRIPTION_RESPONSE_BYTES)
}

// 正文 + 响应头里的流量 / 到期信息(engine/subscription-userinfo.mjs);没有这个头就是 null
export const fetchSubscriptionPayload = async (url, fetchImpl, lookup, userAgent) => {
  const { res, usage } = await fetchSubscriptionResponse(url, fetchImpl, lookup, userAgent)
  const text = await readSubscriptionBody(res, MAX_SUBSCRIPTION_RESPONSE_BYTES)
  return { text, usage }
}

const hostOf = (url) => { try { return new URL(url).hostname } catch { return '订阅地址' } }

// url(s) / content 二选一,统一成 resolveNodes 认的形状。粘贴保存是「节点」模式的正路,
// 不再是"只能预览":用户手上只有一堆分享链接、没有订阅地址的情况很常见。
export const normalizeSource = ({ url, urls, content }) => {
  const trimmedContent = typeof content === 'string' ? content.trim() : ''
  if (trimmedContent) {
    if (Buffer.byteLength(trimmedContent, 'utf8') > MAX_PASTED_CONTENT_BYTES) {
      throw new Error(`粘贴内容超过 ${MAX_PASTED_CONTENT_BYTES} 字节上限`)
    }
    return { content: trimmedContent }
  }
  const list = normalizeUrls(urls, url)
  if (list.length) return { url: list[0], urls: list }
  throw new Error('url or content is required')
}

// preview/create/refresh 共用的解析管道:优先用直传的 content,否则用 fetchImpl 拉取 url;
// 再走 parseSubscription → renameNodes/previewRename。拉取或校验失败在这里抛出,
// 调用方在 store 写入之前捕获,天然保证"失败不破坏已存状态"。
// name:订阅名称。renameOptions.usePrefix 打开时用它做节点名前缀(「破晓 | 香港-01」)。
// 存的是开关而不是前缀文本本身——存文本的话,用户改了订阅名,前缀还留着旧名字。
// 停用的订阅(enabled === false)的节点不进内核:生成配置 / 旁路计划 / 直连站点名单都用这份而不是 store.getNodes()
// (GitHub #40)。节点池本身不动,重新启用就回来
export const activeNodes = (store) => activeNodesOf(
  typeof store.getNodes === 'function' ? store.getNodes() : [],
  typeof store.getSubscriptions === 'function' ? store.getSubscriptions() : [],
)

// curlFetch:Node fetch 全被拒后的兜底(system/curl-fetch.mjs)。只在真实网络路径上默认开——测试注入的
// fetchImpl 不该悄悄去跑系统 curl;要测兜底就显式传
// 添加 / 刷新订阅时让内核把节点过一遍,它不认的直接丢掉、记进「跳过」(GitHub #518:一个坏节点让整个内核起不来)。
// index.mjs 接上 system/validate.mjs 的 kernelRejectedNodes;没接(测试)就只靠解析时的字段校验(engine/node-model.mjs)
let nodeVetter = null
export const setNodeVetter = (fn) => { nodeVetter = typeof fn === 'function' ? fn : null }

const vetResolved = async (resolved) => {
  if (!nodeVetter || !resolved.renamed.length) return resolved
  let verdict
  try {
    verdict = await nodeVetter(resolved.renamed)
  } catch (err) {
    console.warn(`[subscription] 内核检查节点没做成,先照常保存:${errorMessage(err)}`)
    return resolved
  }
  if (verdict && verdict.unlocated) console.warn(`[subscription] 内核检查节点时报错,认不出是哪个节点:${verdict.unlocated}`)
  const bad = new Map(((verdict && verdict.rejected) || []).map((r) => [r.tag, r.error]))
  if (!bad.size) return resolved
  const dropped = resolved.renamed.filter((n) => bad.has(n.tag))
  const renamed = resolved.renamed.filter((n) => !bad.has(n.tag))
  const skipped = [...resolved.skipped, ...dropped.map((n) => ({ name: n.originalTag || n.tag, type: n.type, reason: 'invalid', detail: bad.get(n.tag) }))]
  console.log(`[subscription] 内核不认,丢掉 ${dropped.length} 个节点:${dropped.map((n) => `${n.tag}(${bad.get(n.tag)})`).join('、')}`)
  if (!renamed.length) throw new Error(describeEmptyResult({ format: resolved.format, skipped }))
  return { ...resolved, renamed, skipped, preview: (resolved.preview || []).filter((p) => !bad.has(p.newTag)) }
}

export const resolveNodes = async ({ url, urls, content, name }, fetchImpl, renameOptions, lookup, { curlFetch } = {}) => {
  const curl = curlFetch !== undefined ? curlFetch : (fetchImpl === subscriptionFetch ? curlFetchText : null)
  // 过滤、改名、多个地址合并(engine/subscription-fetch.mjs,和 App 本地分流同一份);最后让内核挑出它不认的节点
  const finish = (parts) => vetResolved(finishSubscription({ parts, renameOptions, name }))

  if (typeof content === 'string' && content.trim()) {
    const parsed = parseSubscription(content)
    if (!parsed.nodes.length) throw new Error(describeEmptyResult(parsed))
    return finish([parsed])
  }

  const list = normalizeUrls(urls, url)
  if (!list.length) throw new Error('url or content is required')

  // 逐个 UA 试,第一份能解析出节点的就采用。多发的请求只在失败路径上产生:
  // 首选 UA 就拿到节点时(绝大多数情况)只有一次请求。
  // 服务器按状态码拒掉的(403 / 401 / 406…)换下一个 UA 继续;网络不通、地址不合法这类错误和 UA
  // 无关,直接报出去,不白等几轮超时(GitHub #27:以前第一个 UA 被 403 就整次失败,后面的 UA 轮不到)。
  // 每次响应之后怎么办由 evaluateAttempt 判(App 本机刷新订阅用同一个)
  const fetchOne = async (oneUrl) => {
    let state = newAttemptState()
    // curl 那一轮本身没跑完(传输中断、连不上):服务器要是已经回了 2xx,就不是「被拒」,是没下载完整
    let curlFailure = null
    // Node 这边不是被状态码拒、而是传输 / 解析层抛错(典型:机场响应头超长,undici 报
    // HPE_HEADER_OVERFLOW,GitHub #3):换 UA 没意义,但系统 curl 的解析器不受这个限制,拿第一个 UA 试一次。
    // 原样留着这个错误对象,最后照原样抛
    let transportError = null
    for (const userAgent of SUBSCRIPTION_USER_AGENTS) {
      let response
      try {
        const { text, usage } = await fetchSubscriptionPayload(oneUrl, fetchImpl, lookup, userAgent)
        response = { userAgent, status: 200, body: text, usage }
      } catch (err) {
        if (err && err.httpStatus) {
          response = { userAgent, status: err.httpStatus }
        } else {
          transportError = err
          response = { userAgent, error: errorMessage(err) }
        }
      }
      const step = evaluateAttempt(state, response)
      state = step.state
      if (step.action === 'accept') return step.part
      if (step.action === 'stop') break
    }
    // Node fetch 全被按状态码拒了:换系统 curl 再来一轮。有些机场的 WAF 认的是 TLS / HTTP 指纹而不是 UA——
    // 同一台机器、同一个出口、同一个 UA,Node 403、curl 200(GitHub #37)。curl 那边同样逐跳校验地址、钉死解析
    if (curl && state.rejected.length && !state.statuses.includes(429)) {
      const curlFailed = (userAgent, reason) => ({ ...state, rejected: [...state.rejected, `curl ${userAgent} → ${reason}`] })
      for (const userAgent of transportError ? SUBSCRIPTION_USER_AGENTS.slice(0, 1) : SUBSCRIPTION_USER_AGENTS) {
        let r
        try {
          r = await curl(oneUrl, { userAgent, lookup, maxBytes: MAX_SUBSCRIPTION_RESPONSE_BYTES, timeoutMs: SUBSCRIPTION_FETCH_TIMEOUT_MS })
        } catch (err) {
          state = curlFailed(userAgent, errorMessage(err))
          break
        }
        if (!r || r.available === false) break
        if (!r.status) {
          state = curlFailed(userAgent, r.error || 'failed')
          curlFailure = r
          break
        }
        const step = evaluateAttempt(state, { userAgent: `curl ${userAgent}`, status: r.status, body: r.text || '', usage: r.usage || null })
        state = step.state
        if (step.action === 'accept') {
          console.log(`[subscription] Node fetch 全部被拒,改用系统 curl 拿到 ${(r.text || '').length} 字节（UA=${userAgent}）`)
          return step.part
        }
        if (step.action === 'stop') break
      }
    }
    if (state.firstParsed) throw new Error(describeEmptyResult(state.firstParsed))
    // 传输层的错原样抛(SSRF 校验、DNS 不通这些的报错文案上层和测试都认它);curl 那一轮的结果只进日志
    if (transportError) {
      if (state.rejected.length > 1) console.log(`[subscription] Node fetch 出错后系统 curl 也没拿到节点:${state.rejected.slice(1).join(';')}`)
      throw transportError
    }
    console.log(`[subscription] ${hostOf(oneUrl)} 全部被拒:${state.rejected.join(';')}`)
    if (curlFailure && curlFailure.httpStatus >= 200 && curlFailure.httpStatus < 300) {
      throw new Error(`订阅内容没下载完整(${curlFailure.error || '传输中断'}),稍后再试`)
    }
    throw new Error(describeRejection(state.statuses, attemptsTried(state)))
  }

  // 多个地址:逐个拉,任何一个失败整次失败——刷新时不能因为一个地址暂时不通就把它那份
  // 节点静默丢掉,失败了原有的订阅记录和节点原样保留
  const parts = []
  for (const oneUrl of list) {
    try {
      parts.push(await fetchOne(oneUrl))
    } catch (err) {
      throw list.length > 1 ? new Error(`${oneUrl}:${errorMessage(err)}`) : err
    }
  }
  return finish(parts)
}

const nodeSummary = (n) => ({ tag: n.tag, originalTag: n.originalTag, type: n.type, server: n.server, regionCode: n.regionCode || '' })

// 粘贴来源的订阅没有可回源的地址,刷新就是拿已存内容重新解析一遍(不走网络)。
const existingSource = (sub) => {
  const urls = subscriptionUrls(sub)
  return urls.length ? { urls } : { content: sub.content || '' }
}

// 重新拉取一条订阅、只替换它的节点。刷新按钮和定时任务(system/scheduler.mjs)共用。
// 拉取 / 解析失败在 store 写入之前抛出,已存的记录与节点原样不变。
export const refreshSubscriptionById = async (store, id, { fetchImpl = subscriptionFetch, lookup = dns.lookup, renameOptions, curlFetch } = {}) => {
  const existing = store.getSubscriptions().find((s) => s.id === id)
  if (!existing) throw new Error('subscription not found')
  const resolved = await resolveNodes({ ...existingSource(existing), name: existing.name }, fetchImpl, renameOptions || existing.renameOptions || {}, lookup, { curlFetch })
  const { renamed, skipped } = resolved
  // 拉取可能花几十秒,期间用户可能改了这条订阅、删了别的订阅或新建了订阅:一律按此刻的列表办。
  //   · 这条被删了 → 作废;
  //   · 来源(地址 / 内容)、名字(节点名前缀跟着它)或改名规则变了 → 这份结果是按旧设置拉的,
  //     写进去就是新旧混杂,作废,让用户再刷一次;
  //   · 只改了自动更新之类的设置 → 照常写,但只合并这次拉取派生出来的字段(格式、数量、时间),
  //     其余以此刻存的为准。以前是拿拉取前的快照整份覆盖,刷新期间保存的新名字、新开关会被
  //     改回去。
  const nowSubs = store.getSubscriptions()
  const current = nowSubs.find((s) => s.id === id)
  if (!current) throw new Error('subscription was deleted while refreshing')
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const settingsChanged = !same(existingSource(current), existingSource(existing))
    || current.name !== existing.name
    || (!renameOptions && !same(current.renameOptions || {}, existing.renameOptions || {}))
  if (settingsChanged) throw new Error('subscription was modified while refreshing; refresh it again')
  const updated = { ...current, ...refreshedFields(resolved, Date.now()) }
  const newNodesForSub = renamed.map((n) => ({ ...n, subscriptionId: id }))
  const pool = rebuildNodePool(store.getNodes(), nowSubs, id, newNodesForSub)
  // 新节点和节点组 / 站点集 / 内置出口 / 链式代理撞名:这次不存,旧节点照用(PM 2026-10-04:遇到重名不能保存;定时任务只记日志)
  const profile = store.getProfile() || {}
  const nameError = refreshNameError({ nodes: pool, subscriptions: nowSubs, groups: store.getGroups(), routing: profile.routing, chainProxies: profile.chainProxies, subscriptionIds: [id] })
  if (nameError) throw new Error(nameError)
  store.setNodes(pool)
  store.setSubscriptions(nowSubs.map((s) => (s.id === id ? updated : s)))
  return { id, name: updated.name, nodeCount: renamed.length, skipped }
}

// 在线更新的结果交给前端的样子:ok / 换了几个出站 / 没换进去的原因(内核没在跑时 skipped,启动就用上新的)
export const appliedSummary = (r) => (r
  ? { ok: r.ok !== false, changed: Number(r.changed) || 0, ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.ok === false ? { reason: r.reason || '' } : {}) }
  : undefined)

// kernelStale:system/kernel-stale.mjs;列表里给每条订阅带上「内核还在用旧定义的节点有几个」(在线更新没换进去时才会不是 0)
// applyNow:把此刻的节点在线换进内核(api/hot-apply.mjs 的 createHotApplier().runNow),不重启
export const registerSubscriptionRoutes = (app, { store, fetchImpl = subscriptionFetch, lookup = dns.lookup, curlFetch, kernelStale = null, applyNow = null } = {}) => {
  const router = express.Router({ caseSensitive: true })
  router.use(express.json({ limit: '10mb' }))

  // 订阅的任何动作都不重启内核(用户 2026-09-30:更新订阅节点不应该重启内核)。节点池变了(新增 / 刷新 / 换地址 / 删除 /
  // 排序 / 启停)就在线换进内核再回复,前端拿到回复时内核里已经是新节点;上游没动的刷新、只是把规则原样存一遍,
  // 就说"节点没有变化"。每个路由进来先拍一张节点池快照,写完再比一次:tag / 服务器 / 参数任何一处不同都算变。
  const snapshot = () => JSON.stringify(store.getNodes())
  // 新建 / 改订阅后的节点和节点组 / 站点集 / 内置出口 / 链式代理撞名:不存(PM 2026-10-04:遇到重名不能保存)
  const nodeNameError = (pool, subscriptions, id) => {
    const profile = store.getProfile() || {}
    return subscriptionNameError({ nodes: pool, subscriptions, groups: store.getGroups(), routing: profile.routing, chainProxies: profile.chainProxies, subscriptionIds: [id], action: 'save' })
  }
  const changedSince = (before) => snapshot() !== before
  const applyIfChanged = async (changed) => {
    if (!changed || typeof applyNow !== 'function') return undefined
    try {
      return appliedSummary(await applyNow())
    } catch (error) {
      return { ok: false, changed: 0, reason: errorMessage(error) }
    }
  }

  // 预览:纯解析/改名/分组,不落库。
  router.post('/preview', async (req, res) => {
    try {
      const { url, urls, content, renameOptions } = req.body || {}
      const resolved = await resolveNodes({ url, urls, content, name: req.body?.name }, fetchImpl, renameOptions, lookup, { curlFetch })
      const { renamed, skipped, excluded, disabled, format, preview } = resolved
      const { groups } = groupNodesByRegion(renamed, resolved.renameOptions)
      res.json({
        format,
        usage: resolved.usage || null,
        nodes: renamed.map(nodeSummary),
        skipped,
        // 被过滤/被禁用的条目要如实报出来:它们会让节点凭空消失,不列出来的话
        // 用户既看不出规则有没有生效,也无从发现自己写的关键词误伤了真节点。
        excluded,
        disabled,
        preview,
        groups,
      })
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) })
    }
  })

  // 创建:拉取解析后保存订阅记录 + 合并节点(全局去重)。
  router.post('/', async (req, res) => {
    const before = snapshot()
    try {
      const { url, urls, content, name, renameOptions, autoUpdate, nodeDns } = req.body || {}
      const source = normalizeSource({ url, urls, content })
      if (typeof name !== 'string' || !name.trim()) throw new Error('name is required')
      const nodeDnsError = validateNodeDns(nodeDns)
      if (nodeDnsError) throw new Error(nodeDnsError)

      const resolved = await resolveNodes({ ...source, name }, fetchImpl, renameOptions, lookup, { curlFetch })
      const { renamed, skipped, format } = resolved

      const id = randomUUID()
      const now = Date.now()
      const record = {
        id,
        name,
        url: source.url || '',
        // 全部地址存在 urls;url 留着第一条,给老版本面板和只认单个地址的地方用
        ...(source.urls ? { urls: source.urls } : {}),
        // 粘贴来的订阅没有可回源的地址,内容必须存下来:改重命名规则时要拿它重新解析,
        // 否则一改规则节点就全没了。
        ...(source.content ? { content: source.content } : {}),
        format,
        nodeCount: renamed.length,
        renameOptions: resolved.renameOptions || {},
        ...(resolved.usage ? { usage: { ...resolved.usage, at: now } } : {}),
        // 定期更新计划;粘贴来的订阅没有地址可回源,不给计划
        autoUpdate: source.urls ? normalizeAutoUpdate(autoUpdate) : null,
        // 节点服务器域名的专用解析器(GitHub #136,engine/node-dns.mjs);没配就不存这个键
        ...(normalizeNodeDns(nodeDns) ? { nodeDns: normalizeNodeDns(nodeDns) } : {}),
        createdAt: now,
        updatedAt: now,
      }
      const newNodesForSub = renamed.map((n) => ({ ...n, subscriptionId: id }))
      const subsInOrder = [...store.getSubscriptions(), record]
      const pool = rebuildNodePool(store.getNodes(), subsInOrder, id, newNodesForSub)
      const nameError = nodeNameError(pool, subsInOrder, id)
      if (nameError) throw new Error(nameError)

      store.setNodes(pool)
      store.setSubscriptions(subsInOrder)

      const changed = changedSince(before)
      res.json({ id, name, nodeCount: renamed.length, skipped, changed, applied: await applyIfChanged(changed) })
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) })
    }
  })

  // 列表
  router.get('/', async (_req, res) => {
    const subs = store.getSubscriptions()
    let stale = null
    if (kernelStale) {
      // 现算不用缓存:刚刷新完订阅,紧接着拉列表就要看到「重启内核生效」
      try { stale = (await kernelStale.refresh()).bySubscription } catch { /* 算不出来就不提示 */ }
    }
    res.json({ subscriptions: stale ? subs.map((s) => ({ ...s, kernelStale: stale[s.id] || 0 })) : subs })
  })

  // 排序:ids 是全部订阅 id 的新顺序(必须一一对应,不能多也不能少)。节点池也按新顺序
  // 重排——节点组成员选择器、终端分流的出口选择器、内核里的出站顺序都是照节点池来的。
  router.put('/order', async (req, res) => {
    const before = snapshot()
    const ids = req.body && req.body.ids
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
      return res.status(400).json({ error: 'ids must be an array of strings' })
    }
    const subs = store.getSubscriptions()
    const current = new Set(subs.map((s) => s.id))
    if (ids.length !== current.size || new Set(ids).size !== ids.length || !ids.every((id) => current.has(id))) {
      return res.status(400).json({ error: 'ids must list every subscription exactly once' })
    }
    const byId = new Map(subs.map((s) => [s.id, s]))
    const ordered = ids.map((id) => byId.get(id))
    store.setSubscriptions(ordered)
    store.setNodes(orderNodesBySubscriptions(store.getNodes(), ordered))
    const changed = changedSince(before)
    res.json({ ok: true, subscriptions: ordered, changed, applied: await applyIfChanged(changed) })
  })

  // 删除:同时清掉该订阅的节点。幂等——id 不存在也返回 ok:true。
  router.delete('/:id', async (req, res) => {
    const { id } = req.params
    const before = snapshot()
    store.setSubscriptions(store.getSubscriptions().filter((s) => s.id !== id))
    store.setNodes(store.getNodes().filter((n) => n.subscriptionId !== id))
    // 本来就不存在的 id、或者本来就没有节点的订阅:节点池没变,changed 就是 false
    const changed = changedSince(before)
    res.json({ ok: true, changed, applied: await applyIfChanged(changed) })
  })

  // 修改:改名 / 换订阅链接 / 调整重命名规则。
  // 只改名字时不重新拉取——链接和重命名规则都没动,节点必然还是那一批,为了改个名字
  // 去发一次网络请求毫无意义,而且机场抽风时会连改名都做不了。链接或重命名规则一旦
  // 变化才重新解析,失败在 store 写入之前抛出,原记录与节点原样保留。
  router.patch('/:id', async (req, res) => {
    const { id } = req.params
    const before = snapshot()
    const subs = store.getSubscriptions()
    const idx = subs.findIndex((s) => s.id === id)
    if (idx === -1) {
      res.status(404).json({ error: 'subscription not found' })
      return
    }
    try {
      const existing = subs[idx]
      const body = req.body || {}

      const name = body.name === undefined ? existing.name : body.name
      if (typeof name !== 'string' || !name.trim()) throw new Error('name is required')
      // 定期更新计划只是记录,改它不用重拉
      const autoUpdate = body.autoUpdate === undefined ? existing.autoUpdate || null : normalizeAutoUpdate(body.autoUpdate)
      // 启用 / 停用(GitHub #40):只是个开关,不重拉;停用的订阅节点不进内核,所以开关一变就算"节点池变了"
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean')
      const enabled = body.enabled === undefined ? existing.enabled !== false : body.enabled
      const enabledFlipped = enabled !== (existing.enabled !== false)
      // 节点专用解析器(#136):只是记录,改它不用重拉;但内核配置跟着变,算"变了"。传 null / 空地址就是去掉
      if (body.nodeDns !== undefined) {
        const nodeDnsError = validateNodeDns(body.nodeDns)
        if (nodeDnsError) throw new Error(nodeDnsError)
      }
      const nodeDns = body.nodeDns === undefined ? normalizeNodeDns(existing.nodeDns) : normalizeNodeDns(body.nodeDns)
      const nodeDnsChanged = JSON.stringify(nodeDns) !== JSON.stringify(normalizeNodeDns(existing.nodeDns))
      const withNodeDns = (record) => {
        const rest = { ...record }
        delete rest.nodeDns
        return nodeDns ? { ...rest, nodeDns } : rest
      }

      // url(s) / content 两者都没传时沿用已存的来源;创建时就保证了至少有一个非空。
      const urls = body.urls === undefined && body.url === undefined
        ? subscriptionUrls(existing)
        : normalizeUrls(body.urls, body.url)
      const content = body.content === undefined ? existing.content || '' : body.content
      const source = normalizeSource({ urls, content })

      const renameOptions =
        body.renameOptions === undefined ? existing.renameOptions || {} : body.renameOptions

      // 开了「订阅名做前缀」时,改订阅名字就等于改掉全部节点名字,必须重新解析。
      // 不带这个条件的话,改完名字节点上还挂着旧前缀,而界面上看不出任何异常。
      const renamedWithPrefix =
        renameOptions && renameOptions.usePrefix === true && name !== existing.name

      const needsRefetch =
        JSON.stringify(source.urls || []) !== JSON.stringify(subscriptionUrls(existing)) ||
        (source.content || '') !== (existing.content || '') ||
        renamedWithPrefix ||
        JSON.stringify(renameOptions || {}) !== JSON.stringify(existing.renameOptions || {})

      if (!needsRefetch) {
        const updated = withNodeDns({ ...existing, name, autoUpdate, enabled, updatedAt: Date.now() })
        store.setSubscriptions(subs.map((s, i) => (i === idx ? updated : s)))
        const changed = enabledFlipped || nodeDnsChanged
        res.json({ id, name, nodeCount: existing.nodeCount, skipped: [], changed, applied: await applyIfChanged(changed) })
        return
      }

      const resolved = await resolveNodes({ ...source, name }, fetchImpl, renameOptions, lookup, { curlFetch })
      const { renamed, skipped, format } = resolved

      const updated = {
        ...existing,
        name,
        autoUpdate,
        enabled,
        url: source.url || '',
        urls: source.urls || undefined,
        content: source.content || undefined,
        format,
        nodeCount: renamed.length,
        renameOptions: resolved.renameOptions || {},
        ...(resolved.usage ? { usage: { ...resolved.usage, at: Date.now() } } : {}),
        updatedAt: Date.now(),
      }
      const newNodesForSub = renamed.map((n) => ({ ...n, subscriptionId: id }))

      // 拉取可能花几十秒,期间用户可能删了别的订阅或新建了订阅:必须按此刻的列表写回,
      // 否则旧快照会把删掉的复活、把新建的连节点一起丢掉
      const nowSubs = store.getSubscriptions()
      if (!nowSubs.some((s) => s.id === id)) throw new Error('subscription was deleted while refreshing')
      const nextSubs = nowSubs.map((s) => (s.id === id ? withNodeDns({ ...s, ...updated }) : s))
      const pool = rebuildNodePool(store.getNodes(), nextSubs, id, newNodesForSub)
      const nameError = nodeNameError(pool, nextSubs, id)
      if (nameError) throw new Error(nameError)
      store.setNodes(pool)
      store.setSubscriptions(nextSubs)

      const changed = changedSince(before) || enabledFlipped || nodeDnsChanged
      res.json({ id, name, nodeCount: renamed.length, skipped, changed, applied: await applyIfChanged(changed) })
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) })
    }
  })

  // 刷新:重新拉取解析,只替换该订阅的节点(逻辑在 refreshSubscriptionById,定时任务也用它)。
  // 拉取/解析失败时在 store 写入之前就已抛出,已存的订阅记录与节点保持原样不变。
  router.post('/:id/refresh', async (req, res) => {
    const { id } = req.params
    const before = snapshot()
    if (!store.getSubscriptions().some((s) => s.id === id)) {
      res.status(404).json({ error: 'subscription not found' })
      return
    }
    try {
      const r = await refreshSubscriptionById(store, id, { fetchImpl, lookup, renameOptions: req.body && req.body.renameOptions, curlFetch })
      const changed = changedSince(before)
      res.json({ ...r, changed, applied: await applyIfChanged(changed) })
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) })
    }
  })

  app.use('/api/openbox/subscriptions', router)
}
