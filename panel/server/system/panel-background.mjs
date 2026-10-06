// 面板背景给 Open-Box App 用(用户 2026-10-05:「把路由器版的背景加到 android app 中」「背景也要同步 android app 中,不要写死」)。
// 面板把这几样存在 app_storage(浏览器改了设置会整份 PUT /api/storage 同步上来):
//   config/custom-background-image  空 = 不用背景;含 local-image = 上传的图(图本身是 BACKGROUND_IMAGE_KEY 那条 data URL,
//                                   首次启动写进去的默认图也是它);别的当网址(面板每天给它加 ?v=日期)
//   config/dashboard-transparent    卡片底色不透明度 %(面板卡片 = bg-base-100 / N%)
//   config/blur-intensity           卡片背后模糊半径 px(backdrop-filter: blur(Npx);0 = 不模糊)
// App 拿元数据 { version, transparent, blur } 判断要不要重新下图,图从 sendPanelBackground 那个接口下:
// 节点分流 /client/v1/:routerId/background(api/client-app.mjs),本地分流 /client/v1/:routerId/config/:token/background
// (api/client-config.mjs)。面板填的是网址时接口 302 跳过去,App 自己去下——和浏览器一样,路由器不替它取
import { createHash } from 'node:crypto'
import { BACKGROUND_IMAGE_KEY } from './seed-defaults.mjs'

// 面板 src/helper/indexeddb.ts 的 LOCAL_IMAGE;设置值里含它就是上传的图
const LOCAL_IMAGE = 'local-image'
// 面板 src/store/settings.ts 里的默认值:没存过这两个键时面板就用它们
const DEFAULT_TRANSPARENT = 90
const DEFAULT_BLUR = 10
// 面板 main.css 只生成了 blur-intensity-0 ~ 39
const MAX_BLUR = 39
const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i

const sha16 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16)

const percent = (raw, fallback, max) => {
  const n = Number.parseFloat(String(raw ?? ''))
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : fallback
}

// 路由器本地日期:面板用浏览器当天的 YYYY-MM-DD 给网址加 ?v=,每天换一张;App 跟着路由器的日期走
const localDate = (now) => {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const uploadedImage = (store) => {
  const raw = store.getRaw(BACKGROUND_IMAGE_KEY)
  const m = typeof raw === 'string' ? DATA_URL.exec(raw.trim()) : null
  if (!m) return null
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
  return bytes.length ? { type: m[1].toLowerCase(), bytes } : null
}

// 面板现在的背景;没设(或设的是上传的图但图没了 / 坏了)是 null。
// version:上传的图按图片字节算,网址按「网址 + 当天日期」算(和面板一样每天换一次)
export const panelBackground = (store, now = new Date()) => {
  const setting = String(store.getRaw('config/custom-background-image') ?? '').trim()
  if (!setting) return null
  const transparent = percent(store.getRaw('config/dashboard-transparent'), DEFAULT_TRANSPARENT, 100)
  const blur = percent(store.getRaw('config/blur-intensity'), DEFAULT_BLUR, MAX_BLUR)
  if (setting.includes(LOCAL_IMAGE)) {
    const image = uploadedImage(store)
    return image ? { version: sha16(image.bytes), transparent, blur, image } : null
  }
  if (!/^https?:\/\//i.test(setting)) return null
  // 拼法照抄面板(url('…?v=日期')),网址本来就带参数也一样拼
  const url = `${setting}?v=${localDate(now)}`
  return { version: sha16(url), transparent, blur, url }
}

// 发给 App 的元数据;withData(导出文件)时把上传的图也带上,导入不用再连路由器
export const panelBackgroundMeta = (background, { withData = false } = {}) => {
  if (!background) return null
  const { version, transparent, blur } = background
  return { version, transparent, blur, ...(withData && background.image ? { data: background.image.bytes.toString('base64') } : {}) }
}

// 图片接口:上传的图回字节,网址 302 跳过去,没有背景 404
export const sendPanelBackground = (res, background) => {
  if (!background) return res.status(404).json({ error: 'not found' })
  res.setHeader('X-Openbox-Background-Version', background.version)
  if (background.url) return res.redirect(302, background.url)
  res.type(background.image.type)
  return res.send(background.image.bytes)
}
