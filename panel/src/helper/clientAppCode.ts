// Open-Box App(手机 / 电脑)的「码」:面板拼出来,App 扫码 / 点链接 / 导入文件后解析。
// 这是和 App 之间的约定,格式不能随意改(App 认不出就配不上对)。参数顺序和字段名对照上游面板 v0.1.351 的构建产物。
//
// 两种码,都是 openbox:// 开头、各字段 encodeURIComponent 后用 & 连接(v=2:码里不再带凭据,
// App 导入时要再输入「配对码」才能解开):
//   import  本地分流(客户端配置):openbox://import?v=2&r=路由器ID&n=路由器名&lan=…&port=…[&pub=…]&p=nonce
//   share   共享网络服务器:       openbox://share?v=2&r=…&n=…&lan=…&port=…[&pub=…]&s=密文&g=代数&sid=服务器ID&nm=服务器名
// s 是服务端用配对码派生的密钥封住的节点分享链接(POST /api/openbox/client-app/share-codes 返回)。

import * as ipaddr from 'ipaddr.js'

export interface AppCodeRouter {
  routerId: string
  routerName: string
  // 路由器的局域网地址:App 在家时直接访问它判断「到家了」。没有可用的就是空串(码里照样带 lan=)
  lan: string
  panelPort: number
  // 面板从外网能访问的地址(带协议),没有就不写 pub
  publicBase?: string
}

const query = (entries: [string, string | number][]) =>
  entries.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')

// 两种码共用的「怎么找到这台路由器」那几项
const where = (router: AppCodeRouter): [string, string][] => [
  ['lan', router.lan],
  ['port', String(router.panelPort)],
  ...(router.publicBase ? ([['pub', router.publicBase]] as [string, string][]) : []),
]

const head = (router: AppCodeRouter): [string, string | number][] => [
  ['v', '2'],
  ['r', router.routerId],
  ['n', router.routerName],
  ...where(router),
]

// 本地分流的码。nonce 不是凭据(没有配对码解不开配置),但也别随手发出去
export const buildClientImportCode = (router: AppCodeRouter & { nonce: string }) =>
  `openbox://import?${query([...head(router), ['p', router.nonce]])}`

// 共享网络服务器的码。seal 是服务端封好的节点分享链接和代数;还没拿到密文或没有路由器 ID 时回空串
export const buildShareAppCode = (
  router: AppCodeRouter,
  server: { id: string; name?: string },
  seal: { sealed: string; gen: number | string },
) =>
  !seal.sealed || !router.routerId
    ? ''
    : `openbox://share?${query([...head(router), ['s', seal.sealed], ['g', seal.gen], ['sid', server.id], ['nm', server.name || server.id]])}`

// ---- 码里的 lan / pub:跟着浏览器当前打开面板的地址走 ----

const bare = (host: string) => host.trim().toLowerCase().replace(/^\[|\]$/g, '')
const isIp = (host: string) => ipaddr.IPv4.isValidFourPartDecimal(host) || ipaddr.IPv6.isValid(host)
const LOCAL_RANGES = new Set(['private', 'loopback', 'linkLocal', 'uniqueLocal', 'carrierGradeNat', 'unspecified'])

// 只在局域网 / 本机里能用的地址:私网等保留段的 IP、.lan / .local 之类的域名、不带点的主机名
export const isLanOnlyHost = (raw: string) => {
  const host = bare(raw)
  if (!host) return false
  if (isIp(host)) return LOCAL_RANGES.has(ipaddr.process(host).range())
  return !host.includes('.') || /\.(lan|local|home|internal|localdomain|home\.arpa)$/.test(host)
}

const isPanelPortOnPrivateIp = (host: string, locationPort: string, panelPort: number) =>
  panelPort > 0 &&
  Number(locationPort || 80) === panelPort &&
  ipaddr.IPv4.isValidFourPartDecimal(host) &&
  ipaddr.process(host).range() === 'private'

// 码里的 lan:路由器的局域网地址里,优先用浏览器正在用的那个;没有就取第一个 IPv4;都没有再看浏览器地址本身
export const pickLanAddress = (
  lanAddresses: string[],
  panelPort = 0,
  hostname: string = location.hostname,
  port: string = location.port,
) => {
  const host = bare(hostname)
  const v4 = lanAddresses.filter((address) => !address.includes(':'))
  if (v4.includes(host) || isPanelPortOnPrivateIp(host, port, panelPort)) return host
  if (v4.length) return v4[0]
  if (lanAddresses.includes(host)) return host
  if (lanAddresses.length) return lanAddresses[0]
  return isIp(host) && isLanOnlyHost(host) ? host : ''
}

// 码里的 pub:面板在外网能访问的地址(带协议和路径)。当前是用局域网地址打开的就没有
export const panelPublicBase = (loc: Location = location) =>
  (loc.protocol !== 'http:' && loc.protocol !== 'https:') || !loc.hostname || isLanOnlyHost(loc.hostname)
    ? ''
    : `${loc.protocol}//${loc.host}${loc.pathname.replace(/[^/]*$/, '')}`

// ---- 导出文件 ----

// 文件名里不能出现的字符(含空白)换成 -;全被换光 / 为空时用 fallback
const safeName = (name: string, fallback: string) => name.trim().replace(/[\\/:*?"<>|\s]+/g, '-') || fallback

const pad = (n: number) => String(n).padStart(2, '0')

// open-box-client-<路由器名>-YYYYMMDD-HHmm.json(本地时间)
export const clientConfigExportFileName = (routerName: string, now: Date = new Date()) =>
  `open-box-client-${safeName(routerName, 'router')}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`
