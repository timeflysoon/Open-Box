// 换节点不重启内核:运行中的配置 → 新算的配置,出站 / endpoint 怎么在线换(内核 tcp13 的 PUT /openbox/outbounds),
// 别的哪几段变了(只能重启)。路由器(api/hot-apply.mjs)和 App 本机刷新订阅(client-engine 的 swapPlan)用的是同一份判断——
// PM 2026-10-04 定做手机热切换,两边口径一样。纯计算,不碰文件和内核
const GROUP_TYPES = new Set(['selector', 'urltest'])
const isGroup = (o) => Boolean(o && GROUP_TYPES.has(o.type) && Array.isArray(o.outbounds))

// 键排好序的 JSON:两份配置可能来自不同版本的生成器,字段顺序不一定一样
export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

// selector 的 default 只在缓存文件里没有这个组的选择时才用得上(内核重建组时从缓存恢复),生成时又跟着此刻的选择走
// (FakeIP 开着时写成当前选择):不能因为它不一样就重建组
const outboundKey = (o) => {
  if (o && o.type === 'selector') return canonical({ ...o, default: undefined })
  return canonical(o)
}

const entriesOf = (config) => {
  const map = new Map()
  for (const o of (config && config.outbounds) || []) if (o && typeof o.tag === 'string') map.set(o.tag, { kind: 'outbound', value: o })
  for (const e of (config && config.endpoints) || []) if (e && typeof e.tag === 'string') map.set(e.tag, { kind: 'endpoint', value: e })
  return map
}
const dependenciesOf = (o) => [...(isGroup(o) ? o.outbounds : []), ...(o && typeof o.detour === 'string' && o.detour ? [o.detour] : [])]

// 运行中的配置 → 新配置,出站 / endpoint 要怎么换。返回 { endpoints, outbounds, remove, created, replaced }(endpoints / outbounds
// 是完整定义,按内核要的顺序:被依赖的在前;remove 是 tag,依赖别人的先删),或 { error } 表示没法在线换(同名的从 endpoint
// 变成出站、依赖成环……),交给重启
export const planOutboundUpdate = (deployed, fresh) => {
  const before = entriesOf(deployed)
  const after = entriesOf(fresh)
  const kindChanged = [...after].filter(([tag, a]) => before.has(tag) && before.get(tag).kind !== a.kind).map(([tag]) => tag)
  if (kindChanged.length) return { error: `出站类型在 endpoint 和普通出站之间变了:${kindChanged.join('、')}` }
  const changed = new Set([...after].filter(([tag, a]) => !before.has(tag) || outboundKey(before.get(tag).value) !== outboundKey(a.value)).map(([tag]) => tag))
  const removed = [...before.keys()].filter((tag) => !after.has(tag))
  // 组手里拿着成员对象:成员换了 / 删了,组(以及拿着这个组的组)一起重建
  const touched = new Set([...changed, ...removed])
  for (let grew = true; grew;) {
    grew = false
    for (const [tag, a] of after) {
      if (touched.has(tag) || !isGroup(a.value)) continue
      if (a.value.outbounds.some((m) => touched.has(m))) {
        touched.add(tag)
        changed.add(tag)
        grew = true
      }
    }
  }
  // 建的顺序:依赖(组的成员、detour)在这次也要建的,排在它前面
  const order = []
  const state = new Map()
  const visit = (tag, path) => {
    if (state.get(tag) === 'done') return null
    if (state.get(tag) === 'visiting') return `${[...path, tag].join(' → ')}`
    state.set(tag, 'visiting')
    for (const dep of dependenciesOf(after.get(tag).value)) {
      if (!changed.has(dep)) continue
      const cycle = visit(dep, [...path, tag])
      if (cycle) return cycle
    }
    state.set(tag, 'done')
    order.push(tag)
    return null
  }
  for (const tag of changed) {
    const cycle = visit(tag, [])
    if (cycle) return { error: `出站依赖成环:${cycle}` }
  }
  // 内核先建全部 endpoint 再建出站:endpoint 依赖这次要建的出站就排不出来
  for (const tag of order) {
    if (after.get(tag).kind !== 'endpoint') continue
    const dep = dependenciesOf(after.get(tag).value).find((d) => changed.has(d) && after.get(d).kind === 'outbound')
    if (dep) return { error: `endpoint「${tag}」依赖这次也要替换的出站「${dep}」` }
  }
  // 删的顺序:删掉的组里还有别的要删的成员,组先删
  const removeOrder = []
  const removedSet = new Set(removed)
  const seen = new Set()
  const visitRemove = (tag) => {
    if (seen.has(tag)) return
    seen.add(tag)
    for (const [other, b] of before) {
      if (removedSet.has(other) && other !== tag && dependenciesOf(b.value).includes(tag)) visitRemove(other)
    }
    removeOrder.push(tag)
  }
  for (const tag of removed) visitRemove(tag)
  return {
    endpoints: order.filter((tag) => after.get(tag).kind === 'endpoint').map((tag) => after.get(tag).value),
    outbounds: order.filter((tag) => after.get(tag).kind === 'outbound').map((tag) => after.get(tag).value),
    remove: removeOrder,
    created: order.filter((tag) => !before.has(tag)),
    replaced: order.filter((tag) => before.has(tag)),
  }
}

// 运行中的配置换上新的出站 / endpoint,其余原样(键的先后照旧)
export const withOutbounds = (deployed, fresh) => {
  const out = {}
  for (const key of Object.keys(deployed)) {
    if (key === 'endpoints') continue
    out[key] = key === 'outbounds' ? fresh.outbounds || [] : deployed[key]
  }
  if (!('outbounds' in out)) out.outbounds = fresh.outbounds || []
  if (Array.isArray(fresh.endpoints) && fresh.endpoints.length) out.endpoints = fresh.endpoints
  return out
}

// 除出站 / endpoint 之外,两份配置哪几段(顶层键)不一样——这些只能重启内核才生效
export const configRestartKeys = (deployed, fresh) => {
  const keys = new Set([...Object.keys(deployed || {}), ...Object.keys(fresh || {})])
  return [...keys].filter((key) => key !== 'outbounds' && key !== 'endpoints' && canonical((deployed || {})[key]) !== canonical((fresh || {})[key]))
}

// App 本机刷新订阅后能不能不重启内核。running / next 各是一份客户端模板 { config, ruleFiles }(engine/client-build.mjs 的
// buildClientConfig 出的那种,没补平台部分):running 是内核此刻在跑的,next 是新算的。回:
//   { ok: true, endpoints, outbounds, remove, created, replaced, writeFiles }
//     endpoints / outbounds:要新建或替换的 tag,按内核要的顺序(被依赖的在前)——PUT /openbox/outbounds 时按这个顺序从配置里
//     取完整定义;remove:建完之后按顺序删的 tag;created / replaced:给日志看;writeFiles:内容变了的规则集文件 tag
//     (订阅和节点站点直连那两份),内核回成功之后再写。全空 = 什么都不用做
//   { ok: false, reason }:只能重启内核(出站以外的配置变了、出站类型在 endpoint 和普通出站之间变了、依赖成环……)
// 和路由器一样:组手里拿着成员对象,成员换了 / 删了,拿着它的组(一层层往上)都在 replaced 里一起重建
export const swapPlan = ({ running, next } = {}) => {
  const before = (running && running.config) || {}
  const after = (next && next.config) || {}
  const keys = configRestartKeys(before, after)
  if (keys.length) return { ok: false, reason: `出站以外的配置变了:${keys.join('、')}` }
  const plan = planOutboundUpdate(before, after)
  if (plan.error) return { ok: false, reason: plan.error }
  const filesBefore = (running && running.ruleFiles) || {}
  const filesAfter = (next && next.ruleFiles) || {}
  // 文件多了 / 少了(开关开关)的话,上面 route 已经不一样、走重启了;这里只看内容
  const writeFiles = Object.keys(filesAfter).filter((tag) => canonical(filesBefore[tag]) !== canonical(filesAfter[tag]))
  return {
    ok: true,
    endpoints: plan.endpoints.map((e) => e.tag),
    outbounds: plan.outbounds.map((o) => o.tag),
    remove: plan.remove,
    created: plan.created,
    replaced: plan.replaced,
    writeFiles,
  }
}
