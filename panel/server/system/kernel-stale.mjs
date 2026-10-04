// 内核在用的节点是不是面板此刻存的那份。
//
// 刷新订阅 / 修改订阅保存之后按设计不自动重启内核(重启会断一次所有连接,什么时候重启由用户定),
// 于是内核里跑的还是旧定义。机场换了密码时,内核那份是旧密码,节点全挂,而面板存的是新的
// (2026-09-22 正式路由器「多宝」20 个节点:部署配置和库里的密码哈希全部对不上)。
// 这里把部署配置(etc/config.json)里的节点出站,和按面板此刻的节点重新生成的逐个比——生成方式和部署
// 完全一样(engine/config.mjs:withNodeResolver(emitOutbound(n), 订阅的专用解析器);WireGuard 是 endpoint):
//   · 订阅卡片挂一条常驻提示「内核还在用旧节点,重启内核生效」,重启完自然消失;
//   · 延迟历史不记内核对这些节点的测速结果——内核测的是旧定义,和面板测的不是同一个节点。
import { activeNodes } from '../api/subscriptions.mjs'
import { emitEndpoint } from '../engine/emit-endpoint.mjs'
import { emitOutbound } from '../engine/emit-outbound.mjs'
import { planNodeDns, withNodeResolver } from '../engine/node-dns.mjs'

const emitted = (node, resolver) => {
  try {
    return JSON.stringify(node.type === 'wireguard' ? emitEndpoint(node) : withNodeResolver(emitOutbound(node), resolver))
  } catch {
    return null // 生成不出来的节点部署时也进不去,不算「旧」
  }
}

// config:部署配置(解析好的 JSON);nodes:面板此刻启用的订阅节点;subscriptions:订阅列表(取专用解析器)。
// 返回内核里定义和此刻不一样(或内核里压根没有)的节点 tag,以及每条订阅各有几个
export const diffKernelNodes = ({ config, nodes, subscriptions }) => {
  const deployed = new Map()
  for (const o of [...(config?.outbounds || []), ...(config?.endpoints || [])]) {
    if (o && typeof o.tag === 'string') deployed.set(o.tag, JSON.stringify(o))
  }
  const nodeDns = planNodeDns(subscriptions || [])
  const staleTags = new Set()
  const bySubscription = {}
  for (const n of nodes || []) {
    if (!n || typeof n.tag !== 'string') continue
    const now = emitted(n, nodeDns.bySubscription.get(n.subscriptionId))
    if (now === null || deployed.get(n.tag) === now) continue
    staleTags.add(n.tag)
    if (n.subscriptionId) bySubscription[n.subscriptionId] = (bySubscription[n.subscriptionId] || 0) + 1
  }
  return { staleTags, bySubscription }
}

// 结果缓存 ttlMs:订阅卡片列表、延迟历史每记一笔都要问,不能每次都读一遍几 MB 的 config.json
export const createKernelStaleNodes = ({ ctx, paths, store, ttlMs = 10_000, now = () => Date.now() } = {}) => {
  let cache = { at: 0, staleTags: new Set(), bySubscription: {} }
  let inflight = null

  const refresh = () => {
    if (inflight) return inflight
    inflight = (async () => {
      let config = null
      try { config = JSON.parse(await ctx.readFile(paths.configPath)) } catch { /* 还没部署过:没有「旧」可言 */ }
      const next = config
        ? diffKernelNodes({ config, nodes: activeNodes(store), subscriptions: store.getSubscriptions ? store.getSubscriptions() : [] })
        : { staleTags: new Set(), bySubscription: {} }
      cache = { at: now(), ...next }
      return cache
    })().finally(() => { inflight = null })
    return inflight
  }

  const get = async () => (now() - cache.at > ttlMs ? refresh() : cache)

  // 同步版(延迟历史记样本时用):先用手头那份,过期了在后台刷新
  const isStale = (tag) => {
    if (now() - cache.at > ttlMs) void refresh().catch(() => {})
    return cache.staleTags.has(tag)
  }

  return { get, refresh, isStale }
}
