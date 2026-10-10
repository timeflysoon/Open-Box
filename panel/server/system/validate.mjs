import { emitEndpoint } from '../engine/emit-endpoint.mjs'
import { emitOutbound } from '../engine/emit-outbound.mjs'

const NON_NODE_TYPES = new Set(['direct', 'block', 'dns', 'selector', 'urltest'])

const cleanMessage = (text) => String(text || '').replace(/\x1b\[[0-9;]*m/g, '')
const firstLine = (text) => {
  const lines = cleanMessage(text).split('\n').filter((l) => l.trim())
  return lines.find((l) => /\bFATAL\b/.test(l)) || lines[0] || ''
}

// 内核编号是生成配置的零基索引，不是订阅里的节点序号。先按完整配置定位，避免
// 把带 detour / DNS 依赖的正常节点拆出来单独校验后误报成坏节点。
export const describeConfigError = (message, config, { nodes = [], subscriptions = [], badTags = [] } = {}) => {
  const text = cleanMessage(message)
  const indexed = /\b(outbound|endpoint)s?\s*(?:\[\s*(\d+)\s*\]|\.(\d+)(?=[.:\s]))/i.exec(text)
  const tagged = /\b(outbound|endpoint)\/[^\s\[]+\[([^\]]+)\]/i.exec(text)
  let matched
  if (indexed) matched = (config[`${indexed[1].toLowerCase()}s`] || [])[Number(indexed[2] ?? indexed[3])]
  else if (tagged) matched = (config[`${tagged[1].toLowerCase()}s`] || []).find((o) => o.tag === tagged[2])
  const tags = [...new Set(matched?.tag ? [matched.tag] : badTags)].filter(Boolean)
  const details = tags.map((tag) => {
    const node = nodes.find((n) => n.tag === tag)
    const sub = node && subscriptions.find((s) => s.id === node.subscriptionId)
    const kind = node ? '节点' : '出站'
    return `${kind}「${tag}」${sub ? `，订阅「${sub.name}」` : ''}${node?.originalTag && node.originalTag !== tag ? `，原名「${node.originalTag}」` : ''}`
  })
  return { message: details.length ? `${details.join('；')}：${text}` : text,
    badTags: tags.filter((tag) => nodes.some((n) => n.tag === tag) || !NON_NODE_TYPES.has(matched?.type)),
    located: Boolean(matched) }
}

export const checkConfig = async (ctx, paths, configJsonPath) => {
  const { code, stdout, stderr } = await ctx.exec(paths.singbox, ['check', '-c', configJsonPath])
  return { ok: code === 0, code, message: firstLine(stderr) || firstLine(stdout) }
}

export const validateConfigObject = async (ctx, paths, config, tmpPath) => {
  await ctx.writeFile(tmpPath, JSON.stringify(config))
  const r = await checkConfig(ctx, paths, tmpPath)
  return { ok: r.ok, message: r.message }
}

export const attributeBadNodes = async (ctx, paths, config, tmpPath) => {
  const badTags = []
  let checked = 0
  const outbounds = Array.isArray(config.outbounds) ? config.outbounds : []
  const endpoints = Array.isArray(config.endpoints) ? config.endpoints : []

  for (const o of outbounds) {
    if (!o || NON_NODE_TYPES.has(o.type)) continue
    checked += 1
    const probe = { log: { level: 'warn' }, outbounds: [{ type: 'direct', tag: 'direct' }, o] }
    const r = await validateConfigObject(ctx, paths, probe, tmpPath)
    if (!r.ok) badTags.push(o.tag)
  }
  for (const e of endpoints) {
    checked += 1
    const probe = { log: { level: 'warn' }, endpoints: [e], outbounds: [{ type: 'direct', tag: 'direct' }] }
    const r = await validateConfigObject(ctx, paths, probe, tmpPath)
    if (!r.ok) badTags.push(e.tag)
  }
  return { badTags, checked }
}

// 内核认不认这些节点(GitHub #518:一个坏节点让整个内核起不来)。添加 / 刷新订阅时(api/subscriptions.mjs)把内核不认的
// 直接丢掉,启动时(api/deploy-runner.mjs)跳过还查出来的。做法:只放这些节点自己的出站 / endpoint 起一次 sing-box check,
// 内核报哪个初始化失败就剔掉它再查,直到通过。detour、domain_resolver 这类指向别的出站 / DNS 的字段先去掉——单独检查时
// 它们找不到依赖、会误报成坏节点,而它们本身对不对要等完整配置才看得出(那时由启动时的完整校验兜)。
// 返回 { rejected: [{ tag, error }], unlocated }:unlocated 是认不出是哪个节点的报错(这时停下,剩下的不再判)。
// 临时配置里有节点凭据,用完就删
const DETACHED_FIELDS = ['detour', 'domain_resolver']
const VET_DIRECT_TAG = '__openbox_vet_direct'
const withoutDependencies = (o) => {
  const out = { ...o }
  for (const key of DETACHED_FIELDS) delete out[key]
  return out
}
// 内核报错去掉「FATAL[0000] initialize outbound[3]:」这类前缀,只留原因(给用户看的提示里用)
export const kernelErrorText = (line) => cleanMessage(line).replace(/^.*?\b(?:initialize|parse)\s+(?:outbound|endpoint)s?\s*\[\s*\d+\s*\]\s*:\s*/i, '').replace(/^.*?FATAL\[\d+\]\s*/, '').trim()

export const kernelRejectedNodes = async (ctx, paths, nodes, tmpPath, { maxRounds = 200 } = {}) => {
  const rejected = []
  const outbounds = []
  const endpoints = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || !node.tag) continue
    try {
      if (node.type === 'wireguard') endpoints.push(withoutDependencies(emitEndpoint(node)))
      else outbounds.push(withoutDependencies(emitOutbound(node)))
    } catch (err) {
      rejected.push({ tag: node.tag, error: String((err && err.message) || err) })
    }
  }
  if (!outbounds.length && !endpoints.length) return { rejected, unlocated: '' }
  let unlocated = ''
  try {
    for (let round = 0; round < maxRounds; round++) {
      const probe = {
        log: { level: 'error' },
        outbounds: [{ type: 'direct', tag: VET_DIRECT_TAG }, ...outbounds],
        ...(endpoints.length ? { endpoints } : {}),
      }
      const r = await validateConfigObject(ctx, paths, probe, tmpPath)
      if (r.ok) break
      const text = cleanMessage(r.message)
      // 报错里认是哪一个:按编号(initialize outbound[3])或按名字(outbound/vless[名字]),和 describeConfigError 同一套写法
      const m = /\b(outbound|endpoint)s?\s*(?:\[\s*(\d+)\s*\]|\.(\d+)(?=[.:\s]))/i.exec(text)
      const named = m ? null : /\b(outbound|endpoint)\/[^\s[]+\[([^\]]+)\]/i.exec(text)
      const kind = (m || named) ? (m || named)[1].toLowerCase() : ''
      const list = kind === 'outbound' ? outbounds : kind === 'endpoint' ? endpoints : null
      // 出站的第 0 个是检查用的直连,节点从第 1 个起
      const at = !list ? -1 : m ? (kind === 'outbound' ? Number(m[2] ?? m[3]) - 1 : Number(m[2] ?? m[3])) : list.findIndex((o) => o.tag === named[2])
      if (!list || at < 0 || at >= list.length) {
        unlocated = text
        break
      }
      const [removed] = list.splice(at, 1)
      rejected.push({ tag: removed.tag, error: kernelErrorText(text) || text })
      if (!outbounds.length && !endpoints.length) break
    }
  } finally {
    await ctx.remove(tmpPath).catch(() => {})
  }
  return { rejected, unlocated }
}

