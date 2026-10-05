// 「路由器标识」(设置 · 客户端,用户 2026-10-04,原名「服务器信息」,简短说明已按用户要求去掉):Open-Box App 里共享网络的
// 节点卡片、本地分流的配置卡片都整张显示它——图标 + 名称、地区(国旗 + 名字)。存在档案 serverInfo:{ name, icon, iconSvg, region },都可以空:
//   name        空 = 「Open-Box v版本号」(和激活顶栏的默认值一样写法)
//   icon        图标代码,和节点组图标同一套(国家代码 / globe:* / brand:* / misc:*);空 = App 画 Open-Box 的标志
//   iconSvg     保存时存下的那个图标的 SVG 原文(随包图标索引里没有时才用它)
//   region      两位国家代码(大写);空 = 按路由器出口 IP 自动判的(system/router-region.mjs 的 detectEgressCountry)
const KEYS = ['name', 'icon', 'iconSvg', 'region']
export const SERVER_INFO_NAME_MAX = 40
// 图标 SVG 原文上限:最大的公司标识(带渐变的那几个)几 KB,留足余量;再大就不是图标了
const MAX_ICON_SVG = 64 * 1024

const isString = (v) => typeof v === 'string'
const text = (v) => (isString(v) ? v.trim() : '')

export const validateServerInfo = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'serverInfo must be an object'
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) return `serverInfo.${key} is not allowed`
  if ('name' in value && !(isString(value.name) && value.name.trim().length <= SERVER_INFO_NAME_MAX)) {
    return `serverInfo.name must be a string (<= ${SERVER_INFO_NAME_MAX} chars)`
  }
  if ('icon' in value && !(isString(value.icon) && /^[A-Za-z0-9:._-]{0,80}$/.test(value.icon))) return 'serverInfo.icon must be an icon code'
  if ('iconSvg' in value && !(isString(value.iconSvg) && value.iconSvg.length <= MAX_ICON_SVG && (!value.iconSvg || value.iconSvg.trimStart().startsWith('<svg')))) {
    return `serverInfo.iconSvg must be SVG markup (<= ${MAX_ICON_SVG} chars)`
  }
  if ('region' in value && !(isString(value.region) && /^([A-Z]{2})?$/.test(value.region))) return 'serverInfo.region must be a two-letter country code or empty'
  return null
}

// 存之前去掉首尾空白;没给的字段不带
export const normalizeServerInfo = (value) => Object.fromEntries(KEYS.filter((key) => key in value).map((key) => [key, key === 'iconSvg' ? value[key] : text(value[key])]))

// 默认名称:「Open-Box v0.1.280」;读不到版本就只写 Open-Box
export const defaultServerName = (version) => {
  const v = text(version)
  return v ? `Open-Box ${v.startsWith('v') ? v : `v${v}`}` : 'Open-Box'
}

// 发给 App 的那份:名称空的换成默认名称;地区是这一刻用的国家(自己选的,否则自动判出来的),regionSvg 是它的国旗
// (App 不自带国旗);图标 SVG 先按代码从随包的图标索引取(iconSvgFor),取不到才用保存时存下的
export const serverInfoView = ({ serverInfo, version, detectedRegion = '', iconSvgFor = () => '' }) => {
  const s = serverInfo && typeof serverInfo === 'object' ? serverInfo : {}
  const icon = text(s.icon)
  const region = text(s.region) || text(detectedRegion).toUpperCase()
  return {
    name: text(s.name) || defaultServerName(version),
    icon,
    iconSvg: icon ? (iconSvgFor(icon) || (isString(s.iconSvg) ? s.iconSvg : '')) : '',
    region,
    regionSvg: region ? iconSvgFor(region) : '',
    regionAuto: !text(s.region),
  }
}
