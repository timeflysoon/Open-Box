// Open-Box 客户端(手机 / 电脑 App)用的接口。方案:docs/superpowers/specs/2026-09-27-client-apps-design.md §4、§5.2。
//
// 公开路由(不要登录,和 /sub/:token 一样挂在鉴权守卫之前)。路径里带路由器 ID(随机 32 位十六进制,出现在
// 「App 码」里),知道 ID 的才取得到;内容只有分流规则和公开的规则集,没有任何凭据:
//   GET /client/v1/home/:routerId            到家探测:回 200 就是连着这台路由器的局域网(App 据此自动暂停)
//   GET /client/v1/:routerId/regions         地区分流(没改过就是默认三组)+ 版本
//   GET /client/v1/:routerId/geodata/:tag    地区分流用到的规则集(.srs,面板随包的 geodata)
// 面板没对公网开放:在外面的 App 经共享网络节点回到路由器再访问这些接口(路由器局域网地址 → 私网直连)。
//
// 登录后的:
//   GET /api/openbox/client-app/info         出「App 码」要的路由器 ID / 名字 / 局域网地址 / 面板端口,地区分流页要的现值和默认值
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { DEFAULT_SHARE_REGIONS, effectiveShareRegions, shareRegionsVersion } from '../engine/share-regions.mjs'
import { readLocalAddresses } from '../system/local-subnets.mjs'
import { panelPort } from '../system/panel-port.mjs'

// Open-Box App 还没发布(用户 2026-09-28:「先不激活客户端配置」):App 码、地区分流、客户端配置的接口一律不注册
// (index.mjs 按它判),发出去的版本不多一个用不上的对外入口。前端 src/constant 里有同名开关(入口置灰),开放时两边一起改
export const CLIENT_APPS_ENABLED = false

// 必须带 openbox/ 前缀:浏览器同步设置(PUT /api/storage)只保护这个前缀的键,别的会被清掉
export const ROUTER_ID_KEY = 'openbox/router-id'
const ROUTER_ID = /^[0-9a-f]{32}$/
const GEO_TAG = /^(geosite|geoip)-[a-z0-9!@._-]{1,80}$/
// 面板随包的规则集,和面板代码在同一个包里
export const DEFAULT_GEO_DIR = fileURLToPath(new URL('../resources/geodata', import.meta.url))

// 这台路由器的 ID:第一次用到时生成、存库;不进导出(换一台路由器导入配置不该冒充成同一台)
export const routerId = (store) => {
  const current = store.getRaw(ROUTER_ID_KEY)
  if (typeof current === 'string' && ROUTER_ID.test(current)) return current
  const id = randomBytes(16).toString('hex')
  store.setRaw(ROUTER_ID_KEY, id)
  return id
}

export const registerPublicClientRoutes = (app, { store, geoDir = DEFAULT_GEO_DIR } = {}) => {
  const known = (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.params.routerId === routerId(store)) return true
    res.status(404).json({ error: 'not found' })
    return false
  }
  app.get('/client/v1/home/:routerId', (req, res) => {
    if (known(req, res)) res.json({ ok: true })
  })
  app.get('/client/v1/:routerId/regions', (req, res) => {
    if (!known(req, res)) return
    const groups = effectiveShareRegions(store.getProfile())
    res.json({ version: shareRegionsVersion(groups), groups })
  })
  app.get('/client/v1/:routerId/geodata/:tag', (req, res) => {
    if (!known(req, res)) return
    const tag = String(req.params.tag).replace(/\.srs$/, '')
    const file = path.join(geoDir, `${tag}.srs`)
    if (!GEO_TAG.test(tag) || !fs.existsSync(file)) return res.status(404).json({ error: 'not found' })
    res.type('application/octet-stream')
    res.sendFile(file)
  })
}

// 路由器的局域网地址(IPv4 在前):进 App 码,App 在家时直接访问它判断「到家了」,在外面经共享网络节点回来访问它。
// 内核的 tun、容器 / 虚拟机网桥这些虚拟口由 readLocalAddresses 认成 other(system/local-subnets.mjs 的 isVirtualIface),不会混进来
export const lanAddresses = async (ctx, platform) => {
  if (!ctx) return []
  const list = (await readLocalAddresses(ctx, { platform }).catch(() => [])).filter((a) => a.kind === 'lan').map((a) => a.address)
  return [...new Set([...list.filter((a) => !a.includes(':')), ...list.filter((a) => a.includes(':'))])]
}

export const registerClientAppRoutes = (app, { store, ctx = null, platform = 'openwrt' } = {}) => {
  const router = express.Router()
  router.get('/client-app/info', async (_req, res) => {
    const profile = store.getProfile()
    res.json({
      routerId: routerId(store),
      routerName: os.hostname(),
      lanAddresses: await lanAddresses(ctx, platform),
      panelPort: panelPort(),
      shareRegions: effectiveShareRegions(profile),
      shareRegionsCustomized: Array.isArray(profile.shareRegions) && profile.shareRegions.length > 0,
      defaultShareRegions: DEFAULT_SHARE_REGIONS,
    })
  })
  app.use('/api/openbox', router)
}
