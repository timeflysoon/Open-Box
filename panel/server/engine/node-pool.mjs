// 节点池:多条订阅的节点合在一起、按订阅顺序排、重名加 -2。路由器(api/subscriptions.mjs)和 App 本地分流
// (client-engine 的 pool,PM 2026-10-04:手机本机刷新订阅,用和路由器同一套代码)共用。

// 合并多订阅节点时,同名 tag 会让 sing-box 启动 FATAL(重复 outbound tag)。
// 按输入顺序保证全局唯一:首次出现原样保留(同引用返回,不拷贝);重复的追加 -2/-3/...,
// 且候选后缀若也已被占用(例如输入里本就含 "xxx-2")则继续递增,避免二次撞车。
export const dedupeNodeTags = (nodes) => {
  const used = new Set()
  return nodes.map((node) => {
    const tag = node.tag
    if (!used.has(tag)) {
      used.add(tag)
      return node
    }
    let seq = 2
    let candidate = `${tag}-${seq}`
    while (used.has(candidate)) {
      seq += 1
      candidate = `${tag}-${seq}`
    }
    used.add(candidate)
    return { ...node, tag: candidate }
  })
}


// 停用的订阅(enabled === false)的节点不进内核:生成配置 / 旁路计划 / 直连站点名单都用这份而不是整个节点池(GitHub #40)。
// 节点池本身不动,重新启用就回来
export const activeNodesOf = (nodes, subscriptions) => {
  const disabled = new Set((subscriptions || []).filter((s) => s && s.enabled === false).map((s) => s.id))
  if (!disabled.size) return nodes || []
  return (nodes || []).filter((n) => !n || !disabled.has(n.subscriptionId))
}

// 把某订阅的新节点并入全局节点池:其它订阅的节点原样保留,按 subscriptions 记录的顺序
// 排列(新建订阅排在最后,刷新订阅保持原有位置),目标订阅位置换成新节点,整体再去重一次。
// 节点池按订阅顺序重排:同一订阅内的相对顺序不变,不属于任何已知订阅的排最后
export const orderNodesBySubscriptions = (nodes, subscriptionsInOrder) => {
  const bySub = new Map()
  const orphans = []
  const known = new Set(subscriptionsInOrder.map((s) => s.id))
  for (const node of nodes) {
    if (!known.has(node.subscriptionId)) { orphans.push(node); continue }
    if (!bySub.has(node.subscriptionId)) bySub.set(node.subscriptionId, [])
    bySub.get(node.subscriptionId).push(node)
  }
  return [...subscriptionsInOrder.flatMap((s) => bySub.get(s.id) || []), ...orphans]
}

export const rebuildNodePool = (existingNodes, subscriptionsInOrder, subscriptionId, newNodesForSub) => {
  const bySub = new Map()
  for (const node of existingNodes) {
    if (node.subscriptionId === subscriptionId) continue
    if (!bySub.has(node.subscriptionId)) bySub.set(node.subscriptionId, [])
    bySub.get(node.subscriptionId).push(node)
  }
  const merged = []
  for (const sub of subscriptionsInOrder) {
    if (sub.id === subscriptionId) {
      merged.push(...newNodesForSub)
    } else {
      merged.push(...(bySub.get(sub.id) || []))
    }
  }
  return dedupeNodeTags(merged)
}


// 几条订阅的节点一起换(App 本机刷新过的那几条换成手机的):按给的顺序一条一条换,和路由器上逐条刷新的结果一样
export const replaceSubscriptionNodes = (nodes, subscriptionsInOrder, replacements) =>
  replacements.reduce((pool, { id, nodes: fresh }) => rebuildNodePool(pool, subscriptionsInOrder, id, fresh.map((n) => ({ ...n, subscriptionId: id }))), nodes)
