// Open-Box App(手机 / 电脑)的「码」:面板拼出来,App 扫码 / 点链接 / 导入文件后解析。
// 这是和 App 之间的约定,格式不能随意改(App 认不出就配不上对)。参数顺序和字段名对照上游面板 v0.1.304 的构建产物。
//
// 两种码,都是 openbox:// 开头、各字段 encodeURIComponent 后用 & 连接:
//   import  本地分流(客户端配置):openbox://import?v=1&r=路由器ID&n=路由器名&lan=…&port=…[&pub=…]&t=token&k=密钥
//   share   共享网络服务器:       openbox://share?v=1&r=…&n=…&lan=…&port=…[&pub=…]&link=节点分享链接&sid=服务器ID
// 二维码、复制链接、导出文件里的 importCode 用的是同一个 import 码。

export interface AppCodeRouter {
  routerId: string
  routerName: string
  // 路由器的局域网地址:App 在家时直接访问它判断「到家了」。没有可用的就是空串(码里照样带 lan=)
  lan: string
  panelPort: number
  // 面板从外网能访问的地址(带协议),没有就不写 pub
  publicBase?: string
}

const query = (entries: [string, string][]) =>
  entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')

// 两种码共用的「怎么找到这台路由器」那几项
const where = (router: AppCodeRouter): [string, string][] => [
  ['lan', router.lan],
  ['port', String(router.panelPort)],
  ...(router.publicBase ? ([['pub', router.publicBase]] as [string, string][]) : []),
]

const head = (router: AppCodeRouter): [string, string][] => [
  ['v', '1'],
  ['r', router.routerId],
  ['n', router.routerName],
  ...where(router),
]

// 本地分流的码。token 和 key 是凭据:拿到码就能同步整份配置(含全部节点密码),别写日志
export const buildClientImportCode = (router: AppCodeRouter & { token: string; key: string }) =>
  `openbox://import?${query([...head(router), ['t', router.token], ['k', router.key]])}`

// 共享网络服务器的码。link 是该服务器的节点分享链接(ss:// vless:// …);没有链接或没有路由器 ID 时回空串
export const buildShareAppCode = (router: AppCodeRouter, server: { id: string; link: string }) =>
  !server.link || !router.routerId
    ? ''
    : `openbox://share?${query([...head(router), ['link', server.link], ['sid', server.id]])}`

// ---- 导出文件 ----

// 文件名里不能出现的字符(含空白)换成 -;全被换光 / 为空时用 fallback
const safeName = (name: string, fallback: string) => name.trim().replace(/[\\/:*?"<>|\s]+/g, '-') || fallback

const pad = (n: number) => String(n).padStart(2, '0')

// open-box-client-<路由器名>-YYYYMMDD-HHmm.json(本地时间)
export const clientConfigExportFileName = (routerName: string, now: Date = new Date()) =>
  `open-box-client-${safeName(routerName, 'router')}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`

// 导出文件 = 配置 + 同一个 import 码:手机导入文件就等于扫了码,之后照样能同步;老 App / 没有 importCode 的文件当快照导入
export const withImportCode = <T extends Record<string, unknown>>(bundle: T, importCode: string) => ({
  ...bundle,
  importCode,
})
