// 新装面板的默认外观与偏好:随包发布一份「面板设置」快照(server/defaults/storage-defaults.json)
// 和一张背景图(server/defaults/background-image.txt,data URL)。面板第一次启动、app_storage
// 里还没有任何 config/* 时把它们写进去,新装用户打开面板就是这套主题、圆角、透明度和背景。
// 已经在用的安装(有 config/*)一律不动。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BACKGROUND_IMAGE_KEY = '__background_image__'
const DEFAULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults')

export const loadStorageDefaults = (dir = DEFAULTS_DIR) => {
  let entries = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'storage-defaults.json'), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === 'string' && k.startsWith('config/') && !k.startsWith('config/access-') && typeof v === 'string') entries[k] = v
      }
    }
  } catch {
    entries = {}
  }
  let background = ''
  try {
    background = fs.readFileSync(path.join(dir, 'background-image.txt'), 'utf8').trim()
    if (!background.startsWith('data:image/')) background = ''
  } catch {
    background = ''
  }
  return { entries, background }
}

// 随包的默认档案(server/defaults/profile-defaults.json):目前只带 routing——一套现成的
// 目标分流(Speed / AI / Youtube / TikTok / Netflix / Github / Google / Microsoft / Apple /
// Games / 国外 / 国内 + 兜底「其他」),取自正式路由器上长期在用的那份。Speed 排在最前:
// 测速站点要先于别的站点集命中,不然 speedtest.net 这类会被「国外」先接走。兜底走直连、「国外」带
// gfw 被墙域名表:没被站点集挑走的默认不占节点流量。各站点集的出口存的是占位符
// 'proxy'(= 成员表里的第一个节点组)或 'direct',新装机器上没有作者那些节点组也能用。
// 只在全新安装时写入(还没有任何 config/*,也没有 openbox/profile),已经在用的安装一律不动。
export const PROFILE_KEY = 'openbox/profile'

export const loadProfileDefaults = (dir = DEFAULTS_DIR) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'profile-defaults.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!parsed.routing || typeof parsed.routing !== 'object' || !Array.isArray(parsed.routing.policies)) return null
    return parsed
  } catch {
    return null
  }
}

export const seedDefaultStorage = ({ countConfigEntries, insert, hasKey = () => false, log = () => {}, dir = DEFAULTS_DIR }) => {
  if (countConfigEntries() > 0) return { seeded: 0, profile: false }
  const { entries, background } = loadStorageDefaults(dir)
  let seeded = 0
  for (const [k, v] of Object.entries(entries)) {
    insert(k, v)
    seeded += 1
  }
  if (background) {
    insert(BACKGROUND_IMAGE_KEY, background)
    seeded += 1
  }
  let profile = false
  const profileDefaults = loadProfileDefaults(dir)
  if (profileDefaults && !hasKey(PROFILE_KEY)) {
    insert(PROFILE_KEY, JSON.stringify(profileDefaults))
    profile = true
  }
  if (seeded || profile) log(`[defaults] 全新安装:写入 ${seeded} 项默认面板设置${background ? '(含背景图)' : ''}${profile ? `,以及默认目标分流(${profileDefaults.routing.policies.length} 个站点集)` : ''}`)
  return { seeded, profile }
}

// 以前随包发过的默认背景(按 data URL 的 sha256):e2957c28 那张 3000×5333(文件 353 KB,浏览器 / App 一解就是 64 MB)。
// 2026-10-10 换成现在随包的这张(用户选的方形图,压到 540×540 的 JPEG:画面极度模糊,4K 横屏铺满也看不出区别,解开 1.1 MB)
const RETIRED_DEFAULT_BACKGROUNDS = new Set(['ad4b53e9d8bbcfb76fe0f502d2a92f6ff6fc45c77db4e5f613cf4d5af03e15d2'])

// 升级后启动时:存着的背景图还是以前随包的那张(用户没换过)就换成现在随包的。自己上传的图、已经是新图、没有图都不动。
// 面板(浏览器打开时先从路由器取图)和 App(按图片字节的版本号判断要不要重下)都跟着换,不用另外处理
export const upgradeDefaultBackground = ({ get, set, log = () => {}, dir = DEFAULTS_DIR, retired = RETIRED_DEFAULT_BACKGROUNDS }) => {
  const image = String(get(BACKGROUND_IMAGE_KEY) ?? '').trim()
  if (!image || !retired.has(createHash('sha256').update(image).digest('hex'))) return false
  const { background } = loadStorageDefaults(dir)
  if (!background || background === image) return false
  set(BACKGROUND_IMAGE_KEY, background)
  log('[defaults] 默认背景换成新版(用户没换过背景)')
  return true
}

// 2026-10-02(45d9ee11)起到 53cd459e 之前,面板设置同步有个 bug:设密码页 / 登录页上拉不到路由器上的设置,前端把出厂
// 默认值写进浏览器并记成待同步的改动,设完密码 / 登录后整份 PATCH 回来——路由器上的面板设置同一秒被冲成前端出厂值
// (背景地址空、透明度 90、模糊 10、排序 / 延迟阈值 / 隐藏设置项…),全新安装随包预置的背景就这么没了。
// 升级后第一次启动修一次(标记键,只做一次):
// - 认:背景图还在(面板里清空背景地址会连图一起删,图在、地址空只能是这个 bug)、背景地址是空串,并且和至少 30 个
//   config/* 键是同一秒写的(那次整份 PATCH)、时间在 2026-10-02 之后;那一秒写的透明度 / 模糊是前端出厂值 90 / 10
//   (导入设置也会同一秒整份写,值一般对不上这套)
// - 图就是随包那张(全新安装预置的):那一秒写的键里和随包默认值不同的都改回随包默认值;圆角、代理组列数照前端第一次读
//   时的换算(store/settings.ts:老键 global-radius 不是出厂的 15 / 16 就用它;two-columns 开着 2 列、关着 1 列)
// - 自己上传的图:只把背景地址改回来,透明度 / 模糊原来是多少不知道,不动
// 那一秒之后用户自己改过的键时间不同,不动
export const LOGIN_DEFAULTS_REPAIR_KEY = 'openbox/repair/login-defaults-20261007'
const LOGIN_DEFAULTS_BUG_SINCE = '2026-10-02 00:00:00'
const LOGIN_DEFAULTS_BURST_MIN = 30
const BACKGROUND_URL_KEY = 'config/custom-background-image'
// 那次 PATCH 写的前端出厂值(store/settings.ts)
const LOGIN_BURST_FRONTEND_DEFAULTS = { 'config/dashboard-transparent': '90', 'config/blur-intensity': '10' }
const LEGACY_GLOBAL_RADIUS_DEFAULTS = [15, 16]

export const repairLoginDefaultsBurst = ({ rows, get, set, log = () => {}, now = () => Date.now(), dir = DEFAULTS_DIR }) => {
  if (get(LOGIN_DEFAULTS_REPAIR_KEY) != null) return { repaired: [] }
  const done = (repaired) => {
    set(LOGIN_DEFAULTS_REPAIR_KEY, new Date(now()).toISOString())
    return { repaired }
  }
  const image = get(BACKGROUND_IMAGE_KEY) || ''
  const all = rows()
  const url = all.find((row) => row.key === BACKGROUND_URL_KEY)
  if (!image || !url || url.value !== '' || !(String(url.updated_at) >= LOGIN_DEFAULTS_BUG_SINCE)) return done([])
  const burst = all.filter((row) => row.updated_at === url.updated_at)
  if (burst.length < LOGIN_DEFAULTS_BURST_MIN) return done([])
  if (burst.some((row) => row.key in LOGIN_BURST_FRONTEND_DEFAULTS && row.value !== LOGIN_BURST_FRONTEND_DEFAULTS[row.key])) return done([])

  const current = Object.fromEntries(all.map((row) => [row.key, row]))
  const inBurst = (key) => current[key]?.updated_at === url.updated_at
  const plan = {}
  const { entries, background } = loadStorageDefaults(dir)
  if (background && image === background) {
    for (const row of burst) {
      if (row.key in entries && entries[row.key] !== row.value) plan[row.key] = entries[row.key]
    }
    const legacyRadius = current['config/global-radius']?.value
    if (inBurst('config/corner-radius') && legacyRadius != null && !LEGACY_GLOBAL_RADIUS_DEFAULTS.includes(Number(legacyRadius))) {
      const radius = Number(legacyRadius)
      if (Number.isFinite(radius)) plan['config/corner-radius'] = String(Math.min(50, Math.max(0, Math.round(radius))))
    }
    if (inBurst('config/proxy-group-columns')) {
      const twoColumns = plan['config/two-columns'] ?? current['config/two-columns']?.value
      if (twoColumns === 'true' || twoColumns === 'false') plan['config/proxy-group-columns'] = twoColumns === 'true' ? '2' : '1'
    }
  }
  if (!plan[BACKGROUND_URL_KEY]) plan[BACKGROUND_URL_KEY] = `local-image-${now()}`
  for (const key of Object.keys(plan)) if (current[key]?.value === plan[key]) delete plan[key]
  // 别的键先写、背景地址最后写:中途出错时下次启动还认得出来
  for (const [key, value] of Object.entries(plan)) if (key !== BACKGROUND_URL_KEY) set(key, value)
  set(BACKGROUND_URL_KEY, plan[BACKGROUND_URL_KEY])
  const repaired = Object.keys(plan)
  log(`[defaults] 修复 ${url.updated_at} 被冲成出厂值的面板设置(登录同步 bug):${repaired.map((key) => key.slice('config/'.length)).join('、')}`)
  return done(repaired)
}
