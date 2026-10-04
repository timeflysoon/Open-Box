import express from 'express'
import { assertPublicUrl } from './net-guard.mjs'
import { loadRuleList, refreshRuleList, srsDecompiler } from '../system/rule-lists.mjs'
import { isRuleListTag, listTagForUrl, ruleListIpTag } from '../engine/rule-list.mjs'
import { dropRuleSetIndex } from '../system/ruleset-index.mjs'
import { normalizeRouting } from '../engine/routing-model.mjs'
import { rulesetPath, isSafeRulesetTag } from '../system/rulesets.mjs'
import { isNodeDirectTag, nodeDirectFile } from '../engine/direct-hosts.mjs'

// 「详情」:一个 geosite/geoip 分类里到底有哪些域名/IP。
//
// .srs 是编译过的二进制,面板自己解不开——但内核自带解码器(sing-box rule-set
// decompile),而内核就在旁边。所以这里直接取包内 .srs，交给内核转成
// JSON,再按页返回。这样"看到的"和"内核真正会匹配的"是同一份数据,不存在第二套解析
// 逻辑跑偏的可能。
//
// 最大的分类(geosite-cn)解出来 9000 多条、230KB,解码 20ms —— 不值得为它设计什么
// 增量方案;只把最近看的那一个缓存下来,免得每敲一个字母就重解一次。
const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_LIMIT = 100
// 最近看过的几个分类(tag → {entries, at});「域名穿透」一个站点集会同时展开三四个规则集,
// 只缓存一个的话每翻一页都要重解其余几个
const CACHE_MAX = 8
const cache = new Map()

// 只有一个值时内核输出的是裸字符串而不是数组("domain_suffix": "adx.36kr.com",
// sing-box 的 Listable 就是这么序列化的),两种都得认——只认数组的话,单条目的分类
// 会显示成空的,而它明明有内容。
const flatten = (json) => {
  const out = []
  for (const rule of (json && json.rules) || []) {
    if (!rule || typeof rule !== 'object') continue
    for (const [type, values] of Object.entries(rule)) {
      for (const value of Array.isArray(values) ? values : [values]) {
        if (typeof value === 'string') out.push({ type, value })
      }
    }
  }
  return out
}

export const loadEntries = async (ctx, paths, tag) => {
  const hit = cache.get(tag)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries
  // 订阅和节点站点直连的两份规则集是 source 格式的 JSON(engine/direct-hosts.mjs),内容随订阅变,不缓存
  if (isNodeDirectTag(tag)) return flatten(JSON.parse(await ctx.readFile(nodeDirectFile(paths.rulesetDir, tag))))

  const srsPath = rulesetPath(paths, tag)
  if (!(await ctx.exists(srsPath))) throw new Error(`安装包缺少规则集 ${tag}，请更新或重新安装 Open-Box`)

  const jsonPath = `${paths.dataDir}/tmp/${tag}.json`
  await ctx.mkdirp(`${paths.dataDir}/tmp`)
  const result = await ctx.exec(paths.singbox, ['rule-set', 'decompile', '--output', jsonPath, srsPath])
  if (result.code !== 0) {
    throw new Error(`解码规则集失败:${(result.stderr || '').trim() || `exit ${result.code}`}`)
  }
  let entries
  try {
    entries = flatten(JSON.parse(await ctx.readFile(jsonPath)))
  } finally {
    await ctx.remove(jsonPath)
  }

  cache.set(tag, { entries, at: Date.now() })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return entries
}

// 「域名穿透」:一个站点集到底会命中哪些域名/IP。规则集展开成条目,手写的条件原样列出;
// 每条带来源(哪个规则集 / 自定义 / 规则集链接的网址),按 全部/域名/IP 分档,可搜索、可排序、分页。
const FAMILY_OF = (type) => (type.startsWith('domain') ? 'domain' : type.startsWith('ip') ? 'ip' : 'other')
const CUSTOM_SOURCE = 'custom'
// 规则集链接(list-xxxxxxxx):部署时编成域名一份 list-xxx.srs、IP 一份 list-xxx-ip.srs(system/rule-lists.mjs),
// 哪份有就解哪份;一份都没有(还没部署过)就按网址现拉一次解析(.srs 交给内核解)
const loadRuleListEntries = async (ctx, paths, tag, url, fetchImpl) => {
  const out = []
  let found = false
  for (const part of [tag, ruleListIpTag(tag)]) {
    if (!(await ctx.exists(rulesetPath(paths, part)))) continue
    found = true
    out.push(...await loadEntries(ctx, paths, part))
  }
  if (found) return out
  if (!url) throw new Error(`规则集链接 ${tag} 还没有编译,也不知道网址`)
  const parsed = await loadRuleList(fetchImpl, url, { decompile: srsDecompiler(ctx, paths, `penetration-${tag}`) })
  for (const [type, values] of Object.entries(parsed)) for (const value of values) out.push({ type, value })
  return out
}
const buildPolicyEntries = async (ctx, paths, policy, fetchImpl) => {
  const out = []
  const missing = []
  for (const [type, list] of [['domain', policy.domain], ['domain_suffix', policy.domainSuffix], ['domain_keyword', policy.domainKeyword], ['ip_cidr', policy.ipCidr]]) {
    for (const value of list || []) out.push({ type, family: FAMILY_OF(type), content: value, source: CUSTOM_SOURCE })
  }
  const urlOfTag = new Map((policy.ruleUrls || []).map((u) => [listTagForUrl(u), u]))
  for (const tag of policy.rulesets || []) {
    if (!isSafeRulesetTag(tag)) { missing.push(tag); continue }
    try {
      if (isRuleListTag(tag)) {
        const url = urlOfTag.get(tag) || ''
        for (const e of await loadRuleListEntries(ctx, paths, tag, url, fetchImpl)) {
          out.push({ type: e.type, family: FAMILY_OF(e.type), content: e.value, source: url || tag })
        }
        continue
      }
      if (!/^(geosite|geoip)-/.test(tag)) { missing.push(tag); continue }
      for (const e of await loadEntries(ctx, paths, tag)) {
        out.push({ type: e.type, family: FAMILY_OF(e.type), content: e.value, source: tag })
      }
    } catch {
      // 某个规则集缺失/解不开:其余的照样列,把它记在 missing 里让界面提示
      missing.push(tag)
    }
  }
  return { entries: out, missing }
}

const intParam = (raw, fallback, max) => {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 0) return fallback
  return max ? Math.min(n, max) : n
}

export const registerRulesetRoutes = (app, { ctx, paths, store, fetchImpl = globalThis.fetch } = {}) => {
  const router = express.Router({ caseSensitive: true })

  // GET /api/openbox/policies/entries?name=AI&tab=all|domain|ip&q=&sort=type|content|source&dir=asc|desc&offset=0&limit=100
  router.get('/policies/entries', async (req, res) => {
    const name = String(req.query.name || '').trim()
    if (!name) return res.status(400).json({ message: 'name is required' })
    const conf = normalizeRouting(store?.getProfile?.()?.routing)
    const tab = ['domain', 'ip'].includes(String(req.query.tab)) ? String(req.query.tab) : 'all'
    const q = String(req.query.q || '').trim().toLowerCase()
    const sort = ['type', 'content', 'source'].includes(String(req.query.sort)) ? String(req.query.sort) : ''
    const dir = String(req.query.dir) === 'desc' ? -1 : 1
    const offset = intParam(req.query.offset, 0)
    const limit = intParam(req.query.limit, 100, MAX_LIMIT) || 100

    if (name === conf.fallback.name) {
      // 兜底没有自己的规则:上面都没命中的流量走它
      return res.json({ name, fallback: true, counts: { all: 0, domain: 0, ip: 0 }, total: 0, matched: 0, offset, limit, hasMore: false, entries: [], missing: [] })
    }
    const policy = conf.policies.find((p) => p.name === name)
    if (!policy) return res.status(404).json({ message: `站点集不存在:${name}` })

    try {
      const { entries, missing } = await buildPolicyEntries(ctx, paths, policy, fetchImpl)
      const counts = { all: entries.length, domain: 0, ip: 0 }
      for (const e of entries) if (e.family === 'domain') counts.domain++; else if (e.family === 'ip') counts.ip++
      let list = tab === 'all' ? entries : entries.filter((e) => e.family === tab)
      if (q) list = list.filter((e) => e.content.toLowerCase().includes(q) || e.source.toLowerCase().includes(q) || e.type.includes(q))
      if (sort) list = [...list].sort((a, b) => dir * String(a[sort]).localeCompare(String(b[sort])))
      res.json({
        name, fallback: false, counts, total: entries.length, matched: list.length, offset, limit,
        hasMore: offset + limit < list.length,
        entries: list.slice(offset, offset + limit),
        missing,
      })
    } catch (error) {
      res.status(503).json({ message: error instanceof Error ? error.message : String(error) })
    }
  })

  // GET /api/openbox/rulesets/preview?url=https://…/Check.list&q=&offset=0&limit=50
  // 「规则集链接」还没保存、没部署时就要能看:直接把网址拉回来解析,不经过编译那一步。
  // 形状和 /rulesets/entries 一样,前端同一个弹窗两边都能用。
  router.get('/rulesets/preview', async (req, res) => {
    const url = String(req.query.url || '').trim()
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) {
      return res.status(400).json({ message: '规则集链接必须是 http 或 https 网址' })
    }
    const q = String(req.query.q || '').trim().toLowerCase()
    const offset = intParam(req.query.offset, 0)
    const limit = intParam(req.query.limit, 50, MAX_LIMIT) || 50
    try {
      const key = `url:${url}`
      const hit = cache.get(key)
      let entries
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        entries = hit.entries
      } else {
        const parsed = await loadRuleList(fetchImpl, url, { decompile: srsDecompiler(ctx, paths, `preview-${listTagForUrl(url)}`) })
        entries = []
        for (const [type, values] of Object.entries(parsed)) for (const value of values) entries.push({ type, value })
        cache.set(key, { entries, at: Date.now() })
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
      }
      const matched = q ? entries.filter((e) => e.value.toLowerCase().includes(q)) : entries
      res.json({ url, total: entries.length, matched: matched.length, offset, limit, entries: matched.slice(offset, offset + limit) })
    } catch (error) {
      res.status(503).json({ message: error instanceof Error ? error.message : String(error) })
    }
  })

  // POST /api/openbox/rulesets/refresh { url }:规则集链接「立即更新」(#155)。
  // 名单平时 24 小时才随部署重拉一次;自己维护名单的人改完点这个,立刻重拉重编。内核盯着本地 .srs,变了自己
  // 重新加载;只有名单的构成变了(多出 / 少了 IP 或域名那一份)才要重启内核(needsRestart)。
  // 几个人同时点同一条链接只拉一次。
  const refreshing = new Map()
  router.post('/rulesets/refresh', express.json({ limit: '8kb' }), async (req, res) => {
    const url = String((req.body && req.body.url) || '').trim()
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) {
      return res.status(400).json({ message: '规则集链接必须是 http 或 https 网址' })
    }
    try {
      if (!refreshing.has(url)) {
        refreshing.set(url, refreshRuleList(ctx, paths, url, { fetchImpl, log: (m) => console.log(m) }).finally(() => refreshing.delete(url)))
      }
      const r = await refreshing.get(url)
      // 预览缓存和规则页推算用的索引都是旧内容,一起作废
      cache.delete(`url:${url}`)
      for (const tag of r.tags) cache.delete(tag)
      dropRuleSetIndex(r.tags)
      res.json({ url, tag: r.tag, total: r.total, counts: r.counts, needsRestart: r.shapeChanged })
    } catch (error) {
      res.status(503).json({ message: error instanceof Error ? error.message : String(error) })
    }
  })

  // 导入规则:把远程名单一次解析成明细,交给站点集编辑器转成本地规则。
  // 这里只负责下载和解析,不写档案、不编译 .srs;用户点编辑器的「保存」时才会随站点集
  // 一起落库,这样导入完成后启动不再依赖这个 URL。
  router.get('/rulesets/import', async (req, res) => {
    const url = String(req.query.url || '').trim()
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) {
      return res.status(400).json({ message: '规则集链接必须是 http 或 https 网址' })
    }
    try {
      await assertPublicUrl(url, { allowPrivate: true })
      const parsed = await loadRuleList(fetchImpl, url, { decompile: srsDecompiler(ctx, paths, `import-${listTagForUrl(url)}`) })
      const entries = []
      for (const [type, values] of Object.entries(parsed)) {
        for (const value of values) entries.push({ type, value })
      }
      res.json({ url, total: entries.length, matched: entries.length, offset: 0, limit: entries.length, entries })
    } catch (error) {
      res.status(503).json({ message: error instanceof Error ? error.message : String(error) })
    }
  })

  // GET /api/openbox/rulesets/entries?tag=geosite-cn&q=&offset=0&limit=50
  router.get('/rulesets/entries', async (req, res) => {
    const tag = String(req.query.tag || '')
    // 只认官方那两个前缀:tag 会被拼成下载地址和本地文件名,这里是它进系统的入口
    if (!isSafeRulesetTag(tag) || !/^(geosite|geoip)-/.test(tag)) {
      return res.status(400).json({ message: `不合法的规则集名:${tag}` })
    }
    const q = String(req.query.q || '').trim().toLowerCase()
    const offset = intParam(req.query.offset, 0)
    const limit = intParam(req.query.limit, 50, MAX_LIMIT) || 50

    try {
      const entries = await loadEntries(ctx, paths, tag, fetchImpl)
      const matched = q ? entries.filter((e) => e.value.toLowerCase().includes(q)) : entries
      res.json({
        tag,
        total: entries.length,
        matched: matched.length,
        offset,
        limit,
        entries: matched.slice(offset, offset + limit),
      })
    } catch (error) {
      // 拉不到/解不开都是外部依赖不可用(GitHub 连不上、内核二进制缺失),不是请求本身有问题
      res.status(503).json({ message: error instanceof Error ? error.message : String(error) })
    }
  })

  app.use('/api/openbox', router)
}

// 测试用:清掉那一个分类的缓存
export const clearRulesetEntriesCache = () => { cache.clear() }
