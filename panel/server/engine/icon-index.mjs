// 图标代码 → SVG 原文(国旗 HK、地球 globe:asia、通用 misc:pin、公司 brand:google),给 App 用:
// 本地分流配置里带上用到的图标、共享网络地区同步顺带的节点图标(用户 2026-10-03:配对 / 同步时只带用到的那几个)。
// 索引由 scripts/gen-icon-index.mjs 从前端源文件生成,随包放在 resources/icons.json.gz(压缩后约 270 KB)。
// 不常驻内存:只有 App 同步时才用,读一次、取完就丢(解开约 1.4 MB)
import fs from 'node:fs'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

export const ICON_INDEX_FILE = fileURLToPath(new URL('../resources/icons.json.gz', import.meta.url))

// 写法和前端 helper/iconUrl.ts 认的一样:国家代码大写;globe: / misc: / brand: 前缀和后面的 id 小写
export const normalizeIconCode = (code) => {
  const value = String(code || '').trim()
  if (!value) return ''
  const prefixed = /^(globe|misc|brand):(.+)$/i.exec(value)
  return prefixed ? `${prefixed[1].toLowerCase()}:${prefixed[2].toLowerCase()}` : value.toUpperCase()
}

// 读不到(开发时没生成过、包里缺)就当没有图标,不让同步因此失败
export const loadIconIndex = (file = ICON_INDEX_FILE) => {
  try {
    const index = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
    return index && typeof index === 'object' ? index : {}
  } catch {
    return {}
  }
}

// 这些代码用到的图标:{ 规范化后的代码: svg };没有的代码不出现
export const iconsFor = (codes, index = loadIconIndex()) => {
  const out = {}
  for (const code of codes) {
    const key = normalizeIconCode(code)
    if (key && typeof index[key] === 'string') out[key] = index[key]
  }
  return out
}
