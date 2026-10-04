// 客户端配置(Open-Box App 的「导入全部配置」):后端设置 · 导出与导入那张卡片里的「客户端配置」。
// 方案 docs/superpowers/specs/2026-09-27-client-apps-design.md §5。手机两种拿法:
//   扫码:面板给每台设备发 token + 32 字节密钥,码里带着;App 拿 token 到下面的公开接口取配置,内容用设备密钥
//        AES-256-GCM 加密(面板是 http,配置里有全部节点密码,不能只靠 token)。之后 App 还能再同步。删设备就撤销
//   文件:登录后导出一个 JSON,配置和用到的规则集(base64)都在里面,手机直接导入;是快照,不带同步凭据
//
// 公开路由(挂在鉴权守卫之前,和 /client/v1 的 A 模式接口同一个前缀):
//   GET /client/v1/:routerId/config/:token                 加密的 bundle
//   GET /client/v1/:routerId/config/:token/rule-set/:tag   bundle 里列的 .srs(不加密,App 按 sha256 校验)
// 登录后的:
//   GET/POST /api/openbox/client-config/devices、DELETE /api/openbox/client-config/devices/:id、GET /api/openbox/client-config/file
import { createCipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import express from 'express'
import { CLIENT_CACHE_FILE, CLIENT_RULESET_DIR, clientProfilePatch, toClientTemplate } from '../engine/client-config.mjs'
import { applyProxyUpstreamRoutes } from '../engine/dns.mjs'
import { flipFlagMap } from '../engine/flip.mjs'
import { normalizeRouting, policyOutboundOptions } from '../engine/routing-model.mjs'
import { builtinTags, emitUserGroups } from '../engine/user-groups.mjs'
import { flipTargetState } from '../system/flip-files.mjs'
import { panelPort } from '../system/panel-port.mjs'
import { readRuleListShapes } from '../system/rule-lists.mjs'
import { isSafeRulesetTag, rulesetKind, rulesetPath } from '../system/rulesets.mjs'
import { readKernelVersion } from '../system/updater.mjs'
import { DEFAULT_GEO_DIR, lanAddresses, routerId } from './client-app.mjs'
import { buildCurrentConfig, fetchSelections } from './deploy-runner.mjs'
import { routeProxyDnsUpstreams } from './dns-upstream-route.mjs'
import { activeNodes } from './subscriptions.mjs'

// 必须带 openbox/ 前缀(浏览器同步设置只保护这个前缀)。不进导出 / 导入:设备和这台路由器绑定
export const CLIENT_DEVICES_KEY = 'openbox/client-devices'
const MAX_DEVICES = 20
const MAX_NAME = 40
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
// 给界面看的:不带 token 摘要和密钥
const publicDevice = (d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSyncAt: d.lastSyncAt || 0, lastSyncFrom: d.lastSyncFrom || '' })

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

// 生成 bundle:路由器此刻的选择(内核没跑就用快照)+ 部署同一个入口 + 客户端补丁 → 客户端模板;规则集附上摘要,
// withData 时连内容一起(导出文件用)
export const buildClientBundle = async ({ store, ctx, paths, fetchImpl = globalThis.fetch, readVersion = async () => '', geoDir = DEFAULT_GEO_DIR, withData = false }) => {
  const profile = store.getProfile() || {}
  const live = await fetchSelections(fetchImpl, store.getClashSecret())
  const selections = Object.keys(live).length ? live : (store.getSelectionsSnapshot?.() || {})
  const ruleLists = await readRuleListShapes(ctx, paths).catch(() => ({}))
  const patch = clientProfilePatch(profile)
  const { config } = buildCurrentConfig(store, [], {
    geoDir: CLIENT_RULESET_DIR,
    rulesetDir: CLIENT_RULESET_DIR,
    cacheFilePath: CLIENT_CACHE_FILE,
    selections,
    ruleLists,
    profilePatch: patch,
    nativeBypass: { enabled: false, sets: [] },
    // 手机上没有路由器那两份规则集文件:订阅和节点站点直连的地址直接写进规则
    inlineDirectHosts: true,
  })
  const groups = store.getGroups()
  const builtin = builtinTags(groups)
  // 代理侧 DNS 上游走哪条线路:和部署一样按目标分流判,再写进解析器的 detour(api/dns-upstream-route.mjs、
  // engine/dns.mjs 的 applyProxyUpstreamRoutes)。不做这一步,解析器停在生成时的占位(兜底)上。
  // profilePatch 一起交过去:判线路的规则表应当是手机这份(不带终端分流这些),推算那边认它时就按手机的判
  const clientProfile = { ...profile, ...patch }
  const upstreamRoutes = clientProfile.dns && clientProfile.dns.split
    ? await routeProxyDnsUpstreams({ store, ctx, paths, fetchImpl, profilePatch: patch }, clientProfile).catch(() => [])
    : []
  applyProxyUpstreamRoutes(config, upstreamRoutes, builtin)
  const { publicTags } = emitUserGroups(groups, activeNodes(store), {})
  const members = policyOutboundOptions(publicTags, builtin)
  const flagState = flipTargetState({ routing: profile.routing, members, builtin, selections, nativeBypass: { enabled: false }, entryMode: null }).flags
  const flagSelectors = Object.fromEntries([...flipFlagMap(normalizeRouting(profile.routing))].map(([name, tag]) => [tag, name]))
  const template = toClientTemplate(config, { selections, flagState, flagSelectors })

  const ruleSets = []
  for (const tag of template.ruleSets) {
    const file = rulesetKind(tag) ? `${geoDir}/${tag}.srs` : rulesetPath(paths, tag)
    const bytes = await fs.promises.readFile(file).catch(() => null)
    if (!bytes) throw new Error(`规则集 ${tag} 还没准备好,先在路由器上启动一次内核再试`)
    ruleSets.push({ tag, sha256: sha256(bytes), size: bytes.length, ...(withData ? { data: bytes.toString('base64') } : {}) })
  }
  const body = { config: template.config, flags: template.flags, directTag: builtin.direct }
  const addresses = await lanAddresses(ctx, paths.platform)
  return {
    format: 'open-box-client',
    version: 1,
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
  const device = (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const d = req.params.routerId === routerId(store) ? findDevice(store, req.params.token) : null
    if (!d) res.status(404).json({ error: 'not found' })
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
  router.get('/client-config/devices', (_req, res) => {
    res.json({ devices: readDevices(store).map(publicDevice) })
  })
  // 添加设备:token 和密钥只在这一次返回(库里只存 token 的摘要),界面拿去拼码
  router.post('/client-config/devices', async (req, res) => {
    const list = readDevices(store)
    if (list.length >= MAX_DEVICES) return res.status(400).json({ error: `at most ${MAX_DEVICES} devices` })
    const name = (typeof req.body?.name === 'string' ? req.body.name.trim() : '').slice(0, MAX_NAME)
    if (!name) return res.status(400).json({ error: 'name is required' })
    const token = randomBytes(24).toString('hex')
    const key = randomBytes(32).toString('base64url')
    const device = { id: `d${randomBytes(6).toString('hex')}`, name, tokenHash: sha256(token), key, createdAt: Date.now(), lastSyncAt: 0, lastSyncFrom: '' }
    writeDevices(store, [...list, device])
    res.json({
      device: publicDevice(device),
      token,
      key,
      routerId: routerId(store),
      routerName: os.hostname(),
      lanAddresses: await lanAddresses(ctx, paths.platform),
      panelPort: panelPort(),
    })
  })
  router.delete('/client-config/devices/:id', (req, res) => {
    const list = readDevices(store)
    const next = list.filter((d) => d.id !== req.params.id)
    if (next.length === list.length) return res.status(404).json({ error: 'not found' })
    writeDevices(store, next)
    res.json({ ok: true })
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
