// 本地分流(客户端)(Open-Box App 的「本地分流」,原「客户端配置」):设置 · 客户端页最下面那张卡片。
// 方案 docs/superpowers/specs/2026-09-27-client-apps-design.md §5。**统一的一套码**(用户 2026-10-04:「去掉为多个设备配置的模式,
// 直接改成统一的配置,后面的图标:二维码、复制链接、导出」):不再按设备发码,所有手机扫同一个码。手机三种拿法都是这一个码:
//   扫码 / 复制链接:码里带 token + 32 字节密钥;App 拿 token 到下面的公开接口取配置,内容用密钥 AES-256-GCM 加密(面板是 http,
//        配置里有全部节点密码,不能只靠 token)。之后 App 还能再同步。码固定:token 和密钥存在库里,面板随时显示同一个码。
//        路由器认不出码(换了路由器)时 App 拿到 404 { error: 'unpaired' },提示「配对失效,请重新配对」
//   文件:/client-config/file 给配置和路由器编出来的规则集(base64),面板界面再把这个码原样放进 importCode(ClientConfigCard.vue):
//        手机导入文件就等于扫了码,之后照样同步;老 App / 没带 importCode 的文件当快照导入。
//        geosite / geoip 随 App 安装包带(PM 2026-10-04:内核和规则库只随 App 安装 / 升级更新),文件里只列摘要不带内容
//   库里沿用原来的设备列表(openbox/client-devices),但只留一条;以前按设备发过码的,留最近同步过、库里还存着原码的那个
//   (那台手机照样能同步),其余的码作废(unifiedCredential)。
//
// 公开路由(挂在鉴权守卫之前,和 /client/v1 的 A 模式接口同一个前缀):
//   GET /client/v1/:routerId/config/:token                 加密的 bundle
//   GET /client/v1/:routerId/config/:token/rule-set/:tag   bundle 里列的 .srs(不加密,App 按 sha256 校验)
// 登录后的:
//   GET /api/openbox/client-config(这个码 + 最后同步时间)、GET /api/openbox/client-config/file
import { createCipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import express from 'express'
import { clientProfilePatch } from '../engine/client-config.mjs'
import { iconsFor } from '../engine/icon-index.mjs'
import { normalizeRouting } from '../engine/routing-model.mjs'
import { panelPort } from '../system/panel-port.mjs'
import { readRuleListShapes } from '../system/rule-lists.mjs'
import { isSafeRulesetTag, rulesetKind, rulesetPath } from '../system/rulesets.mjs'
import { readKernelVersion } from '../system/updater.mjs'
import { DEFAULT_GEO_DIR, lanAddresses, routerId, serverInfoFor } from './client-app.mjs'
import { fetchSelections } from './deploy-runner.mjs'
import { routeProxyDnsUpstreams } from './dns-upstream-route.mjs'
import { policyDrillPlan } from './rulesets.mjs'
import { ENGINE_VERSION, buildClientConfig, viewGroups, viewSubscriptions } from '../engine/client-build.mjs'

// 必须带 openbox/ 前缀(浏览器同步设置只保护这个前缀)。不进导出 / 导入:码和这台路由器绑定。名字沿用以前按设备发码的时候,现在只留一条
export const CLIENT_DEVICES_KEY = 'openbox/client-devices'
const TOKEN_RE = /^[0-9a-f]{48}$/

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export const readDevices = (store) => {
  try {
    const list = JSON.parse(store.getRaw(CLIENT_DEVICES_KEY) || '[]')
    return Array.isArray(list) ? list.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string') : []
  } catch {
    return []
  }
}
const writeDevices = (store, list) => store.setRaw(CLIENT_DEVICES_KEY, JSON.stringify(list))
// 给界面看的:不带 token 和密钥
const publicDevice = (d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSyncAt: d.lastSyncAt || 0, lastSyncFrom: d.lastSyncFrom || '' })

// 统一的那一条:见文件头。库里存着原码的才能接着用(更早的版本只存了摘要,原码拿不回来)
const usableToken = (d) => TOKEN_RE.test(String(d.token || '')) && sha256(d.token) === d.tokenHash
export const unifiedCredential = (store) => {
  const list = readDevices(store)
  const keep = list.filter(usableToken).sort((a, b) => (b.lastSyncAt || 0) - (a.lastSyncAt || 0))[0]
  if (keep && list.length === 1) return keep
  const token = randomBytes(24).toString('hex')
  const device = keep || {
    id: `d${randomBytes(6).toString('hex')}`, name: 'app', token, tokenHash: sha256(token), key: randomBytes(32).toString('base64url'),
    createdAt: Date.now(), lastSyncAt: 0, lastSyncFrom: '',
  }
  writeDevices(store, [device])
  return device
}

const findDevice = (store, token) => {
  if (!TOKEN_RE.test(String(token || ''))) return null
  const hash = Buffer.from(sha256(token), 'hex')
  return readDevices(store).find((d) => {
    const stored = Buffer.from(d.tokenHash, 'hex')
    return stored.length === hash.length && timingSafeEqual(stored, hash)
  }) || null
}

// bundle 用设备密钥加密:{ v, iv, data },data = 密文 + 16 字节认证标签(Java 的 AES/GCM/NoPadding 同一种排法)
export const encryptBundle = (bundle, key) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { v: 1, iv: iv.toString('base64'), data: data.toString('base64') }
}

// App「策略 / 节点 / 订阅」页签要的展示信息(用户 2026-10-03:本地分流和面板代理页样式一致),只给 App 看、不进内核:
//   policies       代理页「策略」页签的卡片,顺序同面板(routing.displayOrder 里排过的在前,其余按命中顺序,兜底在其中);
//                  前置自定义分流不是 selector,代理页没它的卡片,这里也没有。
//                  每项带 drill:「域名穿透」在 App 本地展开用(PM 2026-10-04:本地分流配对后完全脱离路由器),判断和面板
//                  /policies/entries 同一份(api/rulesets.mjs 的 policyDrillPlan):兜底是 { fallback: true };其余是
//                  { fallback: false, custom: [{ type, content }], rulesets: [{ tag, source, parts }] },parts 里的 .srs 都随配置下发
//   groups         「节点」页签的节点组(故障转移的内部子组 __fo: 不列);故障转移组多带 lanes:页签按定义顺序(0 = 主用),
//                  每个 { id, name(没起是空串), icon(没挑是空串,继承组的), mode, ref, members, valid },和 config.meta.json 的
//                  failover[].lanes 同一份:mode = empty / single / urltest / selector(手动选择),ref = 页签在内核里的出站
//                  (单节点是节点本身、多节点是 __fo: 子组、空页签 null),members = 定义里的全部成员,valid = 其中真有的节点
//                  (面板「失效」列的是 members 减 valid)
//   builtins       内置直连 / 拒绝各自挑的图标,成员列表里要用
//   subscriptions  订阅和它进了配置的节点(停用订阅的节点不在配置里,列表就空着);链式代理单列一份(和面板节点管理一样)。
//                  流量是字节,到期 / 更新时间是毫秒,0 = 没有;开了定期更新的带 autoUpdate(形状同面板订阅的 autoUpdate:
//                  { enabled: true, mode: 'hours', hours } 或 { enabled: true, days, hour },按路由器本地时间在路由器上跑),没开不带
//   icons          上面用到的图标原文(代码 → SVG),App 自己不带图标
// 只认这份配置里真有的出站,和手机实际跑的对得上
export const clientView = async ({ store, profile, outboundTags, failover = [], hasRuleset = async () => false }) => {
  const has = (tag) => outboundTags.has(tag)
  const routing = normalizeRouting(profile.routing)
  const iconOf = new Map([...routing.activePolicies.map((p) => [p.name, p.icon]), [routing.fallback.name, routing.fallback.icon]])
  const known = [...routing.activePolicies.map((p) => p.name), routing.fallback.name].filter(has)
  const picked = (Array.isArray(profile.routing?.displayOrder) ? profile.routing.displayOrder : []).filter((name, i, all) => known.includes(name) && all.indexOf(name) === i)
  const drillOf = async (name) => {
    if (name === routing.fallback.name) return { fallback: true }
    const { custom, rulesets } = await policyDrillPlan(routing.activePolicies.find((p) => p.name === name), hasRuleset)
    return { fallback: false, custom, rulesets: rulesets.map(({ tag, source, parts }) => ({ tag, source, parts })) }
  }
  const policies = []
  for (const name of [...picked, ...known.filter((n) => !picked.includes(n))]) {
    policies.push({ tag: name, name, icon: iconOf.get(name) || '', drill: await drillOf(name) })
  }

  // 节点组、订阅这两样随节点变,App 本机刷新后用同一个函数重算(engine/client-build.mjs)
  const allGroups = store.getGroups()
  const groups = viewGroups({ groups: allGroups, outboundTags, failover })
  const builtins = Object.fromEntries(allGroups.filter((g) => g.kind && has(g.name)).map((g) => [g.name, g.icon || '']))

  const subscriptions = viewSubscriptions({ subscriptions: store.getSubscriptions(), nodes: store.getNodes(), profile, outboundTags })

  const icons = iconsFor([
    ...policies.map((p) => p.icon), ...groups.map((g) => g.icon), ...groups.flatMap((g) => (g.lanes || []).map((l) => l.icon)), ...Object.values(builtins),
  ])
  return { policies, groups, builtins, subscriptions, icons }
}

// 生成 bundle:路由器此刻的选择(内核没跑就用快照)+ 部署同一个入口 + 客户端补丁 → 客户端模板;规则集附上摘要,
// withData 时连路由器编出来的那几份的内容一起(导出文件用;geosite / geoip 只列 tag / 摘要 / 大小,App 用安装包里的)
export const buildClientBundle = async ({ store, ctx, paths, fetchImpl = globalThis.fetch, readVersion = async () => '', geoDir = DEFAULT_GEO_DIR, withData = false }) => {
  const profile = store.getProfile() || {}
  const live = await fetchSelections(fetchImpl, store.getClashSecret())
  const selections = Object.keys(live).length ? live : (store.getSelectionsSnapshot?.() || {})
  const patch = clientProfilePatch(profile)
  const clientProfile = { ...profile, ...patch }
  // 代理侧 DNS 上游走哪条线路:和部署一样按目标分流判(api/dns-upstream-route.mjs),算好放进 source,生成时写进解析器的 detour。
  // profilePatch 一起交过去:判线路的规则表应当是手机这份(不带终端分流这些),推算那边认它时就按手机的判
  const upstreamRoutes = clientProfile.dns && clientProfile.dns.split
    ? await routeProxyDnsUpstreams({ store, ctx, paths, fetchImpl, profilePatch: patch }, clientProfile).catch(() => [])
    : []
  // source:算客户端配置要的全部输入,原样带给 App(PM 2026-10-04:手机本机刷新订阅后,用手机的节点、同一套代码重算——
  // engine/client-build.mjs 的 buildClientConfig)。路由器自己也是拿这一份算的,所以 App 用 source.nodes 算出来和下面的
  // config / flags 一字不差(App 每次同步都核一次)
  const source = {
    engineVersion: ENGINE_VERSION,
    profile: clientProfile,
    subscriptions: store.getSubscriptions(),
    nodes: store.getNodes(),
    groups: store.getGroups(),
    ruleLists: await readRuleListShapes(ctx, paths).catch(() => ({})),
    selections,
    upstreamRoutes,
  }
  const built = buildClientConfig({ source, nodes: source.nodes })

  const fileOf = (tag) => (rulesetKind(tag) ? `${geoDir}/${tag}.srs` : rulesetPath(paths, tag))
  // view 也算进指纹:换了图标 / 改了名字 App 要拿到;它不进内核配置,App 那边不会因此重载内核
  const outboundTags = new Set((built.config.outbounds || []).map((o) => o.tag))
  const hasRuleset = (tag) => fs.promises.access(fileOf(tag)).then(() => true, () => false)
  // 路由器标识(设置 · 客户端,用户 2026-10-04):App 里本地分流配置卡片的图标、名称、地区
  const view = { ...(await clientView({ store, profile, outboundTags, failover: built.failover, hasRuleset })), server: await serverInfoFor(store, readVersion) }

  // 规则集:内核配置引用的,加上域名穿透要在手机上解的(只在站点集里、没进分流规则的也要有);模板引用的在前
  const drillParts = view.policies.flatMap((p) => (p.drill.rulesets || []).flatMap((r) => r.parts))
  const ruleSets = []
  for (const tag of new Set([...built.ruleSets, ...drillParts])) {
    const bytes = await fs.promises.readFile(fileOf(tag)).catch(() => null)
    if (!bytes) throw new Error(`规则集 ${tag} 还没准备好,先在路由器上启动一次内核再试`)
    ruleSets.push({ tag, sha256: sha256(bytes), size: bytes.length, ...(withData && !rulesetKind(tag) ? { data: bytes.toString('base64') } : {}) })
  }
  // ruleFiles:订阅和节点站点直连那两份规则集文件的内容(路由器用 source.nodes 算的);App 不在手机上重算时就用它起内核
  const body = { config: built.config, flags: built.flags, ruleFiles: built.ruleFiles, directTag: built.directTag, view, source }
  const addresses = await lanAddresses(ctx, paths.platform)
  return {
    format: 'open-box-client',
    // 2:订阅和节点站点直连改成引用 rulesets/obnode-direct*.json(带 ruleFiles);旧 App 不认,App 那边按这个版本号拦
    version: 2,
    generatedAt: new Date().toISOString(),
    // 内容一变就变:App 比它决定要不要重载
    fingerprint: sha256(JSON.stringify({ ...body, ruleSets: ruleSets.map(({ tag, sha256: hash }) => [tag, hash]) })).slice(0, 16),
    router: {
      id: routerId(store),
      name: os.hostname(),
      lan: addresses.find((a) => !a.includes(':')) || addresses[0] || '',
      panelPort: panelPort(),
      openboxVersion: await readVersion(),
    },
    kernel: await readKernelVersion(ctx, paths),
    ...body,
    ruleSets,
  }
}

export const registerPublicClientConfigRoutes = (app, { store, ctx, paths, fetchImpl, readVersion, geoDir = DEFAULT_GEO_DIR } = {}) => {
  // 认不出这台设备(删掉了,或者路由器换了):404 { error: 'unpaired' },App 据此提示「配对失效,请重新配对」
  const device = (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const d = req.params.routerId === routerId(store) ? findDevice(store, req.params.token) : null
    if (!d) res.status(404).json({ error: 'unpaired' })
    return d
  }
  app.get('/client/v1/:routerId/config/:token', async (req, res) => {
    const d = device(req, res)
    if (!d) return
    try {
      const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, readVersion, geoDir })
      writeDevices(store, readDevices(store).map((x) => (x.id === d.id ? { ...x, lastSyncAt: Date.now(), lastSyncFrom: req.ip || '' } : x)))
      res.json(encryptBundle(bundle, d.key))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/client/v1/:routerId/config/:token/rule-set/:tag', (req, res) => {
    if (!device(req, res)) return
    const tag = String(req.params.tag).replace(/\.srs$/, '')
    if (!isSafeRulesetTag(tag)) return res.status(404).json({ error: 'not found' })
    const file = rulesetKind(tag) ? `${geoDir}/${tag}.srs` : rulesetPath(paths, tag)
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' })
    res.type('application/octet-stream')
    res.sendFile(file)
  })
}

export const registerClientConfigRoutes = (app, { store, ctx, paths, fetchImpl, readVersion, geoDir = DEFAULT_GEO_DIR } = {}) => {
  const router = express.Router()
  // 出码要的东西,界面拿去拼码(二维码、复制链接、导出文件里的 importCode 都是这一个)
  const issued = async (device) => ({
    device: publicDevice(device),
    token: device.token,
    key: device.key,
    routerId: routerId(store),
    routerName: os.hostname(),
    lanAddresses: await lanAddresses(ctx, paths.platform),
    panelPort: panelPort(),
  })
  // 统一的那一个码(没有就发一套,以前按设备发过的按 unifiedCredential 收成一条)
  router.get('/client-config', async (_req, res) => {
    res.json(await issued(unifiedCredential(store)))
  })
  router.get('/client-config/file', async (_req, res) => {
    try {
      res.json(await buildClientBundle({ store, ctx, paths, fetchImpl, readVersion, geoDir, withData: true }))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.use('/api/openbox', router)
}
