// 出站名防重名。内核里节点(订阅节点 + 链式代理)、节点组(含内置直连 / 拒绝)、站点集(含兜底)是同一个命名空间,
// 同名内核就 FATAL(engine/config.mjs 的 findDuplicateTag 是最后一道闸)。PM 2026-10-04:「路由器端 / 客户端,都要有
// 防止重名的机制,遇到重名不能保存」——能产生名字的地方保存时都查这一份,撞了就不存、说清是谁和谁撞了。
// 节点和节点之间重名不算:照旧自动加 -2(engine/node-pool.mjs 的 dedupeNodeTags)。
// 路由器(保存节点组 / 站点集 / 改名规则 / 链式代理、刷新订阅)和 App 本机刷新订阅(client-engine 的 pool)用的是同一份
import { chainNodes } from './chain-proxy.mjs'
import { normalizeRouting } from './routing-model.mjs'
import { normalizeGroups } from './user-groups.mjs'

// 每个名字是谁在用:{ name, kind, label }。kind:node / chain / group / builtin / policy。
// 停用的节点组、站点集、订阅也算:它们一启用就会进内核
export const outboundNameOwners = ({ nodes = [], subscriptions = [], groups = [], routing, chainProxies = [] }) => {
  const subName = new Map((subscriptions || []).map((s) => [s && s.id, (s && s.name) || '']))
  const owners = []
  for (const n of nodes || []) {
    if (!n || !n.tag) continue
    const sub = subName.get(n.subscriptionId)
    owners.push({ name: n.tag, kind: 'node', label: sub ? `订阅「${sub}」的节点` : '节点' })
  }
  for (const n of chainNodes({ chainProxies })) owners.push({ name: n.tag, kind: 'chain', label: '链式代理' })
  for (const g of normalizeGroups(groups)) owners.push({ name: g.name, kind: g.kind ? 'builtin' : 'group', label: g.kind ? '内置出口' : '节点组' })
  const conf = normalizeRouting(routing)
  for (const p of conf.policies) owners.push({ name: p.name, kind: 'policy', label: '站点集' })
  owners.push({ name: conf.fallback.name, kind: 'policy', label: '站点集' })
  return owners
}

// 撞名:同一个名字被两处用了,而且不是「节点和节点」(那个自动加 -2)。回 [{ name, owners }],按名字第一次出现的顺序
export const findNameConflicts = (owners) => {
  const byName = new Map()
  for (const o of owners) {
    if (!byName.has(o.name)) byName.set(o.name, [])
    byName.get(o.name).push(o)
  }
  const out = []
  for (const [name, list] of byName) {
    if (list.length < 2) continue
    if (list.every((o) => o.kind === 'node')) continue
    out.push({ name, owners: list })
  }
  return out
}

// 「名称「香港-自动」重复:节点组和订阅「机场」的节点同名」;同一类出现两次只说一次
export const describeNameConflict = ({ name, owners }) => {
  const labels = [...new Set(owners.map((o) => o.label))]
  return labels.length > 1 ? `名称「${name}」重复:${labels.join('和')}同名` : `名称「${name}」重复:两个${labels[0]}同名`
}

// 订阅的节点能不能存:只看这几条订阅的节点有没有和节点组 / 站点集 / 内置出口 / 链式代理撞名(别的历史状态不归它管)。
// action:refresh(刷新,撞了这次不存、旧节点照用)/ save(新建、改地址、改改名规则,撞了就不存)。
// 能存回 null;不能存回一句话(哪条订阅、哪个名字、和谁撞了、怎么改)
export const subscriptionNameError = ({ nodes, subscriptions, groups, routing, chainProxies, subscriptionIds, action = 'refresh' }) => {
  const ids = new Set(subscriptionIds)
  const conflicts = findNameConflicts(outboundNameOwners({ nodes, subscriptions, groups, routing, chainProxies }))
  for (const c of conflicts) {
    const mine = (nodes || []).find((n) => n && n.tag === c.name && ids.has(n.subscriptionId))
    if (!mine) continue
    const others = [...new Set(c.owners.filter((o) => o.kind !== 'node').map((o) => o.label))]
    if (!others.length) continue
    const sub = (subscriptions || []).find((s) => s && s.id === mine.subscriptionId)
    const subLabel = sub && sub.name ? `订阅「${sub.name}」` : '订阅'
    const what = others.join('、')
    return action === 'save'
      ? `${subLabel}的节点「${c.name}」和${what}同名,没有保存。请在这条订阅的改名规则里改掉这个名字,或者给${what}换个名字`
      : `${subLabel}更新后的节点「${c.name}」和${what}同名,这次更新没有保存(旧节点照用)。请在这条订阅的改名规则里改掉这个名字,或者给${what}换个名字`
  }
  return null
}

// 刷新订阅(手动 / 定时,App 本机刷新)的那一种
export const refreshNameError = (input) => subscriptionNameError({ ...input, action: 'refresh' })

// 保存节点组 / 站点集 / 链式代理之前查:kinds 是这次保存的那几类(group、builtin、policy、chain),
// 它们的名字和别的撞了就不能存。input 里的那一类用要保存的新值。回 null 或一句话
export const saveNameError = (input, kinds) => {
  const conflict = findNameConflicts(outboundNameOwners(input)).find((c) => c.owners.some((o) => kinds.includes(o.kind)))
  return conflict ? `${describeNameConflict(conflict)},不能保存。请换一个名字` : null
}
