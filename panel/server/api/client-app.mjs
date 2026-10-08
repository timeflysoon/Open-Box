// Open-Box 客户端(手机 / 电脑 App)用的接口。方案:docs/superpowers/specs/2026-09-27-client-apps-design.md §4、§5.2。
//
// 公开路由(不要登录,和 /sub/:token 一样挂在鉴权守卫之前)。路径里带路由器 ID(随机 32 位十六进制,出现在
// 「App 码」里),知道 ID 的才取得到;内容只有分流规则和公开的规则集,没有任何凭据:
//   GET /client/v1/home/:routerId            到家探测:回 200 就是连着这台路由器的局域网(App 据此自动暂停)
//   GET /client/v1/:routerId/regions         地区分流(没改过就是默认三组)+ 版本 + 共享网络服务器的 ID / 名字(顺序即 App 里的排序)
//                                            + 路由器标识(App 节点卡片的图标、名称、地区,engine/server-info.mjs)。
//                                            每一组最前面自动带「家里局域网网段 → 回路由器」(engine/share-regions.mjs 的 withHomeLanRules)。
//                                            带 rules=2(新 App)才有域名关键词、规则集链接这两种规则,规则集链接带编好的几份 sets;
//                                            老 App 不认这两种(遇到就整组生成失败),不带 rules=2 的删掉再发;
//                                            还带面板背景的元数据 background(system/panel-background.mjs),App 按 version 决定要不要重新下图
//   GET /client/v1/:routerId/geodata/:tag    地区分流用到的规则集(.srs):geosite / geoip 是面板随包的 geodata;list-xxx(-ip)
//                                            是地区组里的规则集链接编出来的(system/share-region-lists.mjs),只放行现在引用到的
//   GET /client/v1/:routerId/background      面板现在的背景图(上传的图回字节,面板填的是网址就 302 跳过去,没设背景 404)
// 面板没对公网开放:在外面的 App 经共享网络节点回到路由器再访问这些接口(路由器局域网地址 → 私网直连)。
//
// 登录后的:
//   GET /api/openbox/client-app/info         出「App 码」要的路由器 ID / 名字 / 局域网地址 / 面板端口,地区分流页要的现值和默认值,
//                                            路由器标识的现值、默认名称和按出口 IP 判出的国家
//   POST /api/openbox/client-app/egress-country  按路由器出口 IP 判一次国家(路由器标识的地区没手动选时用它)
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { iconsFor, normalizeIconCode } from '../engine/icon-index.mjs'
import { ruleListIpTag } from '../engine/rule-list.mjs'
import { serverInfoView, DEFAULT_SERVER_NAME } from '../engine/server-info.mjs'
import { enabledServers } from '../engine/servers.mjs'
import { DEFAULT_SHARE_REGIONS, collectShareRegionRuleUrls, effectiveShareRegions, shareRegionsForClient, shareRegionsVersion, withHomeLanRules } from '../engine/share-regions.mjs'
import { lanSubnetsOf, readLocalAddresses } from '../system/local-subnets.mjs'
import { panelBackground, panelBackgroundMeta, sendPanelBackground } from '../system/panel-background.mjs'
import { panelPort } from '../system/panel-port.mjs'
import { detectEgressCountry, readEgressCountry } from '../system/router-region.mjs'
import { rulesetPath } from '../system/rulesets.mjs'
import { shareRegionListSets } from '../system/share-region-lists.mjs'

// Open-Box App 还没发布(用户 2026-09-28:「先不激活客户端配置」):App 码、地区分流、客户端配置的接口一律不注册
// (index.mjs 按它判),发出去的版本不多一个用不上的对外入口。前端 src/constant 里有同名开关(入口置灰),开放时两边一起改
export const CLIENT_APPS_ENABLED = true

// 必须带 openbox/ 前缀:浏览器同步设置(PUT /api/storage)只保护这个前缀的键,别的会被清掉
export const ROUTER_ID_KEY = 'openbox/router-id'
const ROUTER_ID = /^[0-9a-f]{32}$/
const GEO_TAG = /^(geosite|geoip)-[a-z0-9!@._-]{1,80}$/
const LIST_TAG = /^list-[0-9a-f]{8}(-ip)?$/
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

// App 里显示的路由器标识(共享网络节点、本地分流配置的卡片都用它):名称空的换成「Open-Box」,地区没手动选的用出口 IP
// 判出来的国家;图标 SVG 按代码从随包的图标索引现取(国旗也在内),取不到才用保存时存下的
export const serverInfoFor = (store) => {
  const profile = store.getProfile() || {}
  const detected = readEgressCountry(store)
  return serverInfoView({
    serverInfo: profile.serverInfo,
    detectedRegion: detected ? detected.country : '',
    iconSvgFor: (code) => iconsFor([code])[normalizeIconCode(code)] || '',
  })
}

export const registerPublicClientRoutes = (app, { store, ctx = null, paths = null, platform = 'openwrt', geoDir = DEFAULT_GEO_DIR } = {}) => {
  const known = (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.params.routerId === routerId(store)) return true
    res.status(404).json({ error: 'not found' })
    return false
  }
  app.get('/client/v1/home/:routerId', (req, res) => {
    if (known(req, res)) res.json({ ok: true })
  })
  app.get('/client/v1/:routerId/regions', async (req, res) => {
    if (!known(req, res)) return
    const profile = store.getProfile()
    const all = withHomeLanRules(effectiveShareRegions(profile), await lanSubnets(ctx, platform))
    // 新 App(rules=2):规则集链接带上编好的几份(没编好是空的,App 当这条不生效);老 App:删掉它不认得的类型。
    // version 按发出去的这份算:sha256 也在里面,名单内容一变 App 就重新拉
    const rulesVersion = req.query.rules === '2' ? 2 : 1
    const setsByUrl = rulesVersion >= 2 && ctx && paths ? await shareRegionListSets(ctx, paths, collectShareRegionRuleUrls(all)) : {}
    const groups = shareRegionsForClient(all, { rulesVersion, setsFor: (url) => setsByUrl[url] || [] })
    // 顺带回共享网络的服务器(在用的,按共享网络页的顺序):App 按 ID 对上扫码时记下的 sid(老 App 码没有 sid 的按名字对),
    // 排顺序(第一个是「推荐」),面板上改了不用重新扫码。只有 ID 和名字,没有凭据。节点卡片上的图标、名称、说明、地区
    // 都用路由器标识(server,用户 2026-10-04)。version 只算地区分流——节点信息变了 App 不用重载分流
    const text = (v) => (typeof v === 'string' ? v : '')
    const nodes = enabledServers(profile.servers).map((s) => ({ id: s.id, name: text(s.name) }))
    // 面板背景(用户 2026-10-05「背景也要同步 android app 中」):和 server 一样不算进 version,App 按它自己的 version 换图
    res.json({ version: shareRegionsVersion(groups), groups, nodes, server: serverInfoFor(store), background: panelBackgroundMeta(panelBackground(store)) })
  })
  app.get('/client/v1/:routerId/background', (req, res) => {
    if (known(req, res)) sendPanelBackground(res, panelBackground(store))
  })
  app.get('/client/v1/:routerId/geodata/:tag', (req, res) => {
    if (!known(req, res)) return
    const tag = String(req.params.tag).replace(/\.srs$/, '')
    if (LIST_TAG.test(tag)) {
      // 地区组里的规则集链接编出来的:只放行现在引用到的,别的(站点集的、删掉的)一概不给
      const listed = paths && collectShareRegionRuleUrls(effectiveShareRegions(store.getProfile())).some((u) => tag === u.tag || tag === ruleListIpTag(u.tag))
      const listFile = listed ? rulesetPath(paths, tag) : ''
      if (!listFile || !fs.existsSync(listFile)) return res.status(404).json({ error: 'not found' })
      res.type('application/octet-stream')
      return res.sendFile(listFile)
    }
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

// 局域网口所在的 IPv4 网段(192.168.5.0/24 这样):地区分流发给 App 时每组最前面自动带「这些网段 → 回路由器」
export const lanSubnets = async (ctx, platform) => (ctx ? lanSubnetsOf(await readLocalAddresses(ctx, { platform }).catch(() => [])) : [])

export const registerClientAppRoutes = (app, { store, ctx = null, paths = null, platform = 'openwrt', detectCountry = detectEgressCountry } = {}) => {
  const router = express.Router()
  router.get('/client-app/info', async (_req, res) => {
    const profile = store.getProfile()
    res.json({
      routerId: routerId(store),
      routerName: os.hostname(),
      lanAddresses: await lanAddresses(ctx, platform),
      // 地区分流页每组规则最上面显示的「家里局域网 → 回路由器」(自动加的,只读)
      lanSubnets: await lanSubnets(ctx, platform),
      panelPort: panelPort(),
      shareRegions: effectiveShareRegions(profile),
      shareRegionsCustomized: Array.isArray(profile.shareRegions) && profile.shareRegions.length > 0,
      defaultShareRegions: DEFAULT_SHARE_REGIONS,
      // 路由器标识:存着的原样(空的就是用默认值)、默认名称、按出口 IP 判出的国家({ ip, country, at },没判过是 null)
      serverInfo: profile.serverInfo && typeof profile.serverInfo === 'object' ? profile.serverInfo : {},
      serverInfoDefaults: { name: DEFAULT_SERVER_NAME },
      egressCountry: readEgressCountry(store),
    })
  })
  // 按出口 IP 判一次国家(打开「客户端」页签时没判过 / 判得太久,或者地区切回「自动」):出口 IP 没变就直接用上次的
  router.post('/client-app/egress-country', async (_req, res) => {
    if (!ctx || !paths) return res.status(503).json({ error: 'not available' })
    try {
      // platform 不传:fetchEgressIp 要的是 Node 的 process.platform(linux 才打探测标记、不经正在跑的内核),不是 openwrt / debian
      res.json(await detectCountry({ store, ctx, paths }))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.use('/api/openbox', router)
}
