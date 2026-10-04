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
