// 链式代理(GitHub #96 / #98 / #127):一个节点不直接拨号,而是经另一个节点 / 节点组去连——内核里就是出站的
// detour 字段。典型用法是住宅 IP 的 socks5 / 自建节点本身被墙,得先过一条代理线路才够得着;服务器地址是域名
// (动态 IP 常见)也没关系:带 detour 的出站把域名原样交给上游那条线路,由上游那头解析,本地不解析。
//
// 数据在档案的 chainProxies 里:[{ id, enabled, name, link, upstream, node }]
//   name      节点名,也是内核里的出站 tag(和节点 / 节点组 / 站点集 / 内置直连拒绝同一个命名空间,不能重名)
//   link      节点本体:一条分享链接(ss:// vless:// trojan:// socks5:// …),或一小段 Clash / sing-box 节点配置
//   upstream  上游:某个节点或节点组的名字
//   node      从 link 解析出来的摘要 { type, server, port }——保存时由服务端算,界面列表显示用,不信客户端传来的
// 链式节点不参加「动态」节点组(按关键词 / 全部节点现挑成员的那种):住宅线路不该悄悄混进自动择优池;
// 要用就把它显式加进某个节点组的成员,或在前置自定义分流 / 终端分流里直接选它当出口。
import { parseSubscription } from './subscription.mjs'
import { parseHttpProxyLink } from './sharelink.mjs'
import { emitUserGroups, builtinTags } from './user-groups.mjs'

export const CHAIN_SUBSCRIPTION_ID = 'chain-proxy'
export const CHAIN_SOURCE_LABEL = '链式代理'
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// link → 恰好一个节点。wireguard 在内核里是 endpoint 不是出站,这里不收
// 住宅代理商给的账号常是纯文本(Thordata / IPRoyal / Smartproxy 这类):主机:端口:用户名:密码,或 用户名:密码@主机:端口,
// 或只有 主机:端口。它们的测试命令是 curl -x,也就是 HTTP 代理,这里改写成 http:// 再按 HTTP 代理接;
// 密码里带 ':' 也行(第四段起全算密码)。带 :// 的、多行的、带空格的都不是这种,原样交给分享链接 / 配置解析
const HOST_RE = /^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/
const PORT_RE = /^\d{1,5}$/
export const residentialToShareLink = (text) => {
  if (/\s|:\/\//.test(text)) return ''
  const enc = encodeURIComponent
  const at = text.lastIndexOf('@')
  if (at > 0) {
    const creds = text.slice(0, at), hostport = text.slice(at + 1)
    const colon = hostport.lastIndexOf(':')
    if (colon <= 0) return ''
    const host = hostport.slice(0, colon), port = hostport.slice(colon + 1)
    const sep = creds.indexOf(':')
    if (!HOST_RE.test(host) || !PORT_RE.test(port) || sep <= 0) return ''
    return `http://${enc(creds.slice(0, sep))}:${enc(creds.slice(sep + 1))}@${host}:${port}`
  }
  const parts = text.split(':')
  if (parts.length === 2 && HOST_RE.test(parts[0]) && PORT_RE.test(parts[1])) return `http://${parts[0]}:${parts[1]}`
  if (parts.length >= 4 && HOST_RE.test(parts[0]) && PORT_RE.test(parts[1]) && parts[2]) {
    return `http://${enc(parts[2])}:${enc(parts.slice(3).join(':'))}@${parts[0]}:${parts[1]}`
  }
  return ''
}

export const parseChainNode = (link) => {
  const text = String(link || '').trim()
  if (!text) return { error: '节点内容不能为空' }
  // http:// https:// 是 HTTP 代理账号(住宅代理商的 HTTP / HTTPS 格式),单独解析:订阅解析里 http(s):// 是网址不是节点
  const httpText = residentialToShareLink(text) || text
  if (/^https?:\/\//i.test(httpText) && !/\s/.test(httpText)) {
    let node = null
    try { node = parseHttpProxyLink(httpText) } catch (err) { return { error: `节点内容解析失败:${err instanceof Error ? err.message : String(err)}` } }
    return node ? { node } : { error: 'HTTP 代理账号格式不对,应为 http://用户名:密码@主机:端口 或 https://…' }
  }
  let parsed
  try {
    parsed = parseSubscription(text)
  } catch (err) {
    return { error: `节点内容解析失败:${err instanceof Error ? err.message : String(err)}` }
  }
  const nodes = (parsed.nodes || []).filter((n) => n && n.type !== 'wireguard')
  if (!nodes.length) {
    const skipped = (parsed.skipped || [])[0]
    return { error: `没有解析出可用的节点${skipped && skipped.reason ? `(${skipped.reason})` : ''};支持分享链接(ss / vmess / vless / trojan / hysteria2 / tuic / anytls / socks5)、HTTP 代理(http:// https:// 或住宅代理的 主机:端口:用户名:密码),或一段 Clash / sing-box 节点配置` }
  }
  if (nodes.length > 1) return { error: `一条链式代理只能填一个节点,这里解析出了 ${nodes.length} 个` }
  return { node: nodes[0] }
}

// 形状校验(api/profile.mjs 的 validateProfilePatch 和备份导入共用)。出错返回一句话,没错返回 ''
export const validateChainProxies = (list) => {
  if (!Array.isArray(list)) return 'chainProxies must be an array'
  if (list.length > 64) return 'chainProxies: at most 64 entries'
  const ids = new Set()
  const names = new Set()
  for (const e of list) {
    if (!isPlainObject(e)) return 'chainProxies entries must be objects'
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return 'chainProxies[].id must match /^[A-Za-z0-9_-]{1,40}$/'
    if (ids.has(e.id)) return `chainProxies[].id duplicated: ${e.id}`
    ids.add(e.id)
    if ('enabled' in e && typeof e.enabled !== 'boolean') return 'chainProxies[].enabled must be a boolean'
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 64) return '链式代理的名称不能为空(最多 64 个字符)'
    const name = e.name.trim()
    if (names.has(name)) return `链式代理名称重复:「${name}」`
    names.add(name)
    if (typeof e.upstream !== 'string' || !e.upstream.trim()) return `链式代理「${name}」还没有选上游`
    if (e.upstream.trim() === name) return `链式代理「${name}」的上游不能是它自己`
    if (typeof e.link !== 'string' || e.link.length > 16384) return `链式代理「${name}」的节点内容无效`
    const parsed = parseChainNode(e.link)
    if (parsed.error) return `链式代理「${name}」:${parsed.error}`
  }
  return ''
}

// 存库前整理:去空白、补 enabled、按 link 重算摘要(store 的 setProfile 调用;已经过 validateChainProxies 的才会到这)
export const normalizeChainProxies = (list) => (Array.isArray(list) ? list : []).filter(isPlainObject).map((e) => {
  const parsed = parseChainNode(e.link)
  const out = { id: String(e.id || ''), enabled: e.enabled !== false, name: String(e.name || '').trim(), link: String(e.link || '').trim(), upstream: String(e.upstream || '').trim() }
  if (parsed.node) out.node = { type: parsed.node.type, server: parsed.node.server, port: parsed.node.server_port }
  return out
})

// 启用着、解析得出来的链式节点(还没核对上游和环)。tag 用用户起的名字
export const chainNodes = (profile) => {
  const out = []
  for (const e of (profile && Array.isArray(profile.chainProxies) ? profile.chainProxies : [])) {
    if (!isPlainObject(e) || e.enabled === false) continue
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    const upstream = typeof e.upstream === 'string' ? e.upstream.trim() : ''
    if (!name || !upstream) continue
    const parsed = parseChainNode(e.link)
    if (!parsed.node) continue
    out.push({ ...parsed.node, tag: name, originalTag: name, chain: true, chainId: e.id, detour: upstream, subscriptionId: CHAIN_SUBSCRIPTION_ID })
  }
  return out
}

// 进内核前的核对。链式节点经 detour 引用上游,节点组又可以把链式节点收作成员——两边一凑就可能成环
// (内核启动时 FATAL)。这里把有问题的链式节点挑出来不进配置,原因记下来:
//   duplicate  名字和订阅节点 / 节点组 / 内置直连拒绝重了
//   upstream   上游不存在(被删了 / 停用了),或者指向内置直连 / 拒绝
//   cycle      顺着 上游 → 组成员 → 上游 … 能绕回自己
// 去掉一个之后别的节点的上游可能跟着失效,所以循环到稳定为止
export const resolveChainNodes = ({ chainProxies, nodes = [], userGroups = [], reservedTags = [] } = {}) => {
  let candidates = chainNodes({ chainProxies })
  const skipped = []
  const drop = (node, reason) => { skipped.push({ id: node.chainId, name: node.tag, reason, upstream: node.detour }) }
  const builtin = builtinTags(userGroups || [])
  const baseTags = new Set([...(nodes || []).map((n) => n && n.tag), ...(userGroups || []).map((g) => g && g.name), builtin.direct, builtin.block, ...reservedTags].filter(Boolean))
  candidates = candidates.filter((c) => { if (baseTags.has(c.tag)) { drop(c, 'duplicate'); return false } return true })
  // 每轮剔掉一个坏的,上界必须在开始前定死:以前写成 round <= candidates.length + 1,candidates 每轮变短,
  // 上界跟着缩,4 个以上链式代理的上游同时没了(比如节点组恢复默认)时,最后一个没来得及剔就出了循环,
  // 原样进了配置——detour 到不存在的组,内核启动即 FATAL(2026-09-22 开发路由器凌晨定时部署后内核停掉)
  const maxRounds = candidates.length + 1
  for (let round = 0; round <= maxRounds; round++) {
    const all = [...(nodes || []), ...candidates]
    const { outbounds: groupOutbounds, publicTags } = emitUserGroups(userGroups || [], all, {})
    const edges = new Map()
    for (const o of groupOutbounds) if (Array.isArray(o.outbounds)) edges.set(o.tag, o.outbounds)
    for (const c of candidates) edges.set(c.tag, [c.detour])
    const nodeTags = new Set(all.filter((n) => n && n.type !== 'wireguard').map((n) => n.tag))
    const groupTags = new Set(publicTags)
    const reaches = (from, target, seen = new Set()) => {
      for (const next of edges.get(from) || []) {
        if (next === target) return true
        if (seen.has(next)) continue
        seen.add(next)
        if (reaches(next, target, seen)) return true
      }
      return false
    }
    const bad = candidates.find((c) => {
      const okUpstream = c.detour !== c.tag && c.detour !== builtin.direct && c.detour !== builtin.block && (nodeTags.has(c.detour) || groupTags.has(c.detour))
      if (!okUpstream) { drop(c, 'upstream'); return true }
      if (reaches(c.tag, c.tag)) { drop(c, 'cycle'); return true }
      return false
    })
    if (!bad) break
    candidates = candidates.filter((c) => c !== bad)
  }
  return { nodes: candidates, skipped }
}
