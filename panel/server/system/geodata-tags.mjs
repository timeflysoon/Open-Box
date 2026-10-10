// 按随包规则库清单(manifest.json 的 files)登记有哪些 geosite / geoip(engine/routing-model.mjs 的 setAvailableGeoTags):
// 换了新规则库、上游删掉了站点集里引用着的分类时,部署跳过那几项并提示,而不是卡在「安装包缺少规则集」、内核起不来。
// 面板和 cli/deploy.mjs 启动时各登记一次;读不到清单就不登记(不筛,和以前一样)
import { setAvailableGeoTags } from '../engine/routing-model.mjs'

export const geoTagsFromManifest = (manifest) => {
  const files = manifest && typeof manifest === 'object' && manifest.files && typeof manifest.files === 'object' ? Object.keys(manifest.files) : []
  return files.filter((name) => /^(geoip|geosite)-.+\.srs$/.test(name)).map((name) => name.slice(0, -'.srs'.length))
}

export const registerBundledGeoTags = async (ctx, paths, { log = () => {} } = {}) => {
  try {
    const tags = geoTagsFromManifest(JSON.parse(await ctx.readFile(`${paths.geoDir}/manifest.json`)))
    setAvailableGeoTags(tags.length ? tags : null)
    return tags.length
  } catch (err) {
    setAvailableGeoTags(null)
    log(`[geodata] 读不到规则库清单,站点集里的规则集不按它筛:${err instanceof Error ? err.message : err}`)
    return 0
  }
}
