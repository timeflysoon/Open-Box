import { randomBytes } from 'node:crypto'
import dns from 'node:dns/promises'
import express from 'express'
import YAML from 'yaml'
import { decodeBase64, isProbablyBase64 } from '../engine/codec.mjs'
import { emitEndpoint } from '../engine/emit-endpoint.mjs'
import { emitOutbound } from '../engine/emit-outbound.mjs'
import { detectSubscriptionFormat, parseSubscription } from '../engine/subscription.mjs'
import { applySubscriptionShareNames, toClashProxy } from '../engine/subscription-share-names.mjs'
import { fetchSubscriptionText, subscriptionUrls } from './subscriptions.mjs'

const MAX_NAME = 120
const tokenFor = () => randomBytes(24).toString('hex')
// 前端新建分享时先在浏览器生成 token 把链接 / 二维码实时显示出来,保存时一起送上来;只认 40~64 位十六进制、
// 且没被别的分享占用的,不合法就服务端重新生成
const TOKEN_RE = /^[0-9a-f]{40,64}$/i
const acceptToken = (value, existing) => {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!TOKEN_RE.test(token)) return tokenFor()
  return existing.some((s) => s && s.token === token) ? tokenFor() : token
}
const now = () => Date.now()
const cleanName = (value) => typeof value === 'string' ? value.trim().slice(0, MAX_NAME) : ''
const normalizeProtocol = (value) => value === 'http' || value === 'https' ? value : ''

// 订阅成功导入后,节点已经保存在本机节点池。分享优先使用这份快照,避免每次访问分享
// 地址都重新请求机场；机场临时 reset、超时或限流不应让已经导入成功的节点全部失效。
// 用 Open-Box 自己的 sing-box emitter 重建配置,保证协议字段与面板实际使用的配置一致。
const serializeStoredNodes = (nodes) => {
  const outbounds = []
  const endpoints = []
  for (const node of nodes) {
    try {
      if (node.type === 'wireguard') endpoints.push(emitEndpoint(node))
      else outbounds.push(emitOutbound(node))
    } catch {
      // 节点池中可能留有旧版本导入的未知协议；跳过这一条，不能让整份分享失效。
    }
  }
  if (!outbounds.length && !endpoints.length) return ''
  return JSON.stringify({ outbounds, ...(endpoints.length ? { endpoints } : {}) }, null, 2)
}

const normalizeIds = (value, subscriptions) => {
  if (!Array.isArray(value)) return []
  const allowed = new Set(subscriptions.map((s) => s.id))
  return [...new Set(value.filter((id) => typeof id === 'string' && allowed.has(id)))]
}

const normalizeRecord = (raw) => ({
  id: typeof raw?.id === 'string' ? raw.id : tokenFor(),
  name: cleanName(raw?.name) || '订阅分享',
  token: typeof raw?.token === 'string' && raw.token.length >= 32 ? raw.token : tokenFor(),
  subscriptionIds: Array.isArray(raw?.subscriptionIds) ? raw.subscriptionIds.filter((id) => typeof id === 'string') : [],
  host: typeof raw?.host === 'string' ? raw.host.trim() : '',
  protocol: normalizeProtocol(raw?.protocol),
  enabled: raw?.enabled !== false,
  createdAt: Number(raw?.createdAt) || now(),
  updatedAt: Number(raw?.updatedAt) || now(),
})

const sourceText = async (sub, { fetchImpl, lookup, nodes }) => {
  const normalizeContent = (value) => {
    const text = value.trim()
    if (!isProbablyBase64(text) || detectSubscriptionFormat(text) !== 'unknown') return text
    try {
      const decoded = decodeBase64(text)
      return detectSubscriptionFormat(decoded) === 'unknown' ? text : decoded.trim()
    } catch { return text }
  }
  const prepare = (text) => applySubscriptionShareNames(normalizeContent(text), sub, nodes)
  if (typeof sub?.content === 'string' && sub.content.trim()) return prepare(sub.content)
  const stored = nodes.filter((node) => node && node.subscriptionId === sub.id)
  if (stored.length) return serializeStoredNodes(stored)
  const url = subscriptionUrls(sub)[0]
  if (!url) return ''
  return prepare(await fetchSubscriptionText(url, fetchImpl, lookup, 'Open-Box/1.0'))
}

const mergeContents = (parts) => {
  const nonempty = parts.map((p) => p.trim()).filter(Boolean)
  if (!nonempty.length) return { body: '', type: 'text/plain; charset=utf-8' }
  if (nonempty.length === 1) return { body: nonempty[0], type: 'text/plain; charset=utf-8' }

  const parsed = nonempty.map((text) => {
    try {
      const value = YAML.parse(text)
      if (value && Array.isArray(value.proxies)) return { kind: 'clash', value }
    } catch {}
    try {
      const value = JSON.parse(text)
      if (value && Array.isArray(value.outbounds)) return { kind: 'singbox', value }
    } catch {}
    return { kind: 'sharelink', value: text }
  })

  if (parsed.every((p) => p.kind === 'clash')) {
    const proxies = parsed.flatMap((p) => p.value.proxies || [])
    return { body: YAML.stringify({ proxies }), type: 'text/yaml; charset=utf-8' }
  }
  if (parsed.every((p) => p.kind === 'singbox')) {
    const outbounds = parsed.flatMap((p) => p.value.outbounds || [])
    const endpoints = parsed.flatMap((p) => p.value.endpoints || [])
    return { body: JSON.stringify({ outbounds, ...(endpoints.length ? { endpoints } : {}) }, null, 2), type: 'application/json; charset=utf-8' }
  }
  if (parsed.every((p) => p.kind === 'sharelink')) {
    return { body: parsed.map((p) => p.value).join('\n'), type: 'text/plain; charset=utf-8' }
  }
  // URL 订阅、粘贴内容和本机快照可能是不同格式，直接拼接会生成客户端无法解析的
  // 半份 YAML/JSON。统一转成 sing-box JSON；Clash 客户端在下方按 User-Agent 转成
  // Clash YAML，Karing / sing-box 客户端可直接读取这份标准 JSON。
  const nodes = parsed.flatMap((part) => {
    try { return parseSubscription(part.kind === 'sharelink' ? part.value : nonempty[parsed.indexOf(part)]).nodes } catch { return [] }
  })
  const body = serializeStoredNodes(nodes)
  return body ? { body, type: 'application/json; charset=utf-8' } : { body: nonempty.join('\n'), type: 'text/plain; charset=utf-8' }
}

export const registerPublicSubscriptionShareRoutes = (app, { store, fetchImpl = globalThis.fetch, lookup = dns.lookup } = {}) => {
  app.get('/sub/:token', async (req, res) => {
    try {
      const share = store.getSubscriptionShares().map(normalizeRecord).find((item) => item.token === req.params.token)
      if (!share) return res.status(404).type('text/plain').send('subscription share not found')
      if (!share.enabled) return res.status(404).type('text/plain').send('subscription share disabled')
      const subscriptions = store.getSubscriptions()
      const selected = share.subscriptionIds.map((id) => subscriptions.find((s) => s.id === id)).filter(Boolean)
      // 并行回源缩短下载时间。保持选中顺序，任一来源失败仍整体失败，避免生成
      // 不完整的配置。
      const nodes = store.getNodes()
      const parts = await Promise.all(selected.map((sub) => sourceText(sub, { fetchImpl, lookup, nodes })))
      const wantsClash = /clash/i.test(String(req.headers['user-agent'] || '')) || /clash/i.test(String(req.query?.format || ''))
      if (wantsClash) {
        const proxies = parts.flatMap((part) => parseSubscription(part).nodes).map(toClashProxy)
        if (!proxies.length) return res.status(404).type('text/plain').send('subscription share has no Clash-compatible nodes')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', 'text/yaml; charset=utf-8')
        return res.send(YAML.stringify({ proxies }))
      }
      const merged = mergeContents(parts)
      if (!merged.body) return res.status(404).type('text/plain').send('subscription share has no content')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', merged.type)
      return res.send(merged.body)
    } catch (error) {
      return res.status(502).type('text/plain').send(error instanceof Error ? error.message : String(error))
    }
  })
}

export const registerSubscriptionShareRoutes = (app, { store } = {}) => {
  const router = express.Router()
  router.use(express.json({ limit: '256kb' }))

  router.get('/', (_req, res) => {
    const subscriptions = store.getSubscriptions()
    const valid = new Set(subscriptions.map((s) => s.id))
    const shares = store.getSubscriptionShares().map((raw) => {
      const share = normalizeRecord(raw)
      return { ...share, subscriptionIds: share.subscriptionIds.filter((id) => valid.has(id)) }
    })
    res.json({ shares })
  })

  router.post('/', (req, res) => {
    const name = cleanName(req.body?.name)
    if (!name) return res.status(400).json({ error: 'name is required' })
    const subscriptionIds = normalizeIds(req.body?.subscriptionIds, store.getSubscriptions())
    if (!subscriptionIds.length) return res.status(400).json({ error: 'select at least one subscription' })
    const host = typeof req.body?.host === 'string' ? req.body.host.trim() : ''
    if (!host) return res.status(400).json({ error: 'host is required' })
    const protocol = normalizeProtocol(req.body?.protocol) || 'https'
    const timestamp = now()
    const existing = store.getSubscriptionShares()
    const share = { id: tokenFor(), name, host, protocol, enabled: true, token: acceptToken(req.body?.token, existing), subscriptionIds, createdAt: timestamp, updatedAt: timestamp }
    store.setSubscriptionShares([...existing, share])
    return res.status(201).json({ share })
  })

  router.patch('/:id', (req, res) => {
    const list = store.getSubscriptionShares().map(normalizeRecord)
    const index = list.findIndex((item) => item.id === req.params.id)
    if (index < 0) return res.status(404).json({ error: 'subscription share not found' })
    const current = list[index]
    const name = req.body?.name === undefined ? current.name : cleanName(req.body.name)
    if (!name) return res.status(400).json({ error: 'name is required' })
    const subscriptionIds = req.body?.subscriptionIds === undefined
      ? current.subscriptionIds
      : normalizeIds(req.body.subscriptionIds, store.getSubscriptions())
    if (!subscriptionIds.length) return res.status(400).json({ error: 'select at least one subscription' })
    const host = req.body?.host === undefined ? current.host : (typeof req.body.host === 'string' ? req.body.host.trim() : '')
    if (!host) return res.status(400).json({ error: 'host is required' })
    const protocol = req.body?.protocol === undefined ? current.protocol : normalizeProtocol(req.body.protocol)
    const enabled = req.body?.enabled === undefined ? current.enabled : req.body.enabled !== false
    const updated = { ...current, name, host, protocol, enabled, subscriptionIds, token: req.body?.regenerate ? tokenFor() : current.token, updatedAt: now() }
    list[index] = updated
    store.setSubscriptionShares(list)
    return res.json({ share: updated })
  })

  router.post('/:id/regenerate', (req, res) => {
    const list = store.getSubscriptionShares().map(normalizeRecord)
    const index = list.findIndex((item) => item.id === req.params.id)
    if (index < 0) return res.status(404).json({ error: 'subscription share not found' })
    list[index] = { ...list[index], token: tokenFor(), updatedAt: now() }
    store.setSubscriptionShares(list)
    return res.json({ share: list[index] })
  })

  router.delete('/:id', (req, res) => {
    const list = store.getSubscriptionShares().map(normalizeRecord)
    const next = list.filter((item) => item.id !== req.params.id)
    if (next.length === list.length) return res.status(404).json({ error: 'subscription share not found' })
    store.setSubscriptionShares(next)
    return res.json({ ok: true })
  })

  app.use('/api/openbox/subscription-shares', router)
}
