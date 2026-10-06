// 地区分流里的「规则集链接」(用户 2026-10-05:地区分流的规则和目标分流对齐):路由器下载、编译,和站点集的规则集链接
// 同一套(system/rule-lists.mjs,域名一份 list-xxx.srs、IP 一份 list-xxx-ip.srs);App 请求地区分流带 rules=2 时,
// 每条规则集链接带上编好的几份 { tag, kind, sha256 },再从 GET /client/v1/:routerId/geodata/<tag> 取 .srs(api/client-app.mjs)。
// 地区分流只给手机用:拉不到不影响路由器自己的部署,也不打扰站点集那些链接的状态
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { ruleListIpTag } from '../engine/rule-list.mjs'
import { collectShareRegionRuleUrls, effectiveShareRegions } from '../engine/share-regions.mjs'
import { rulesetPath } from './rulesets.mjs'
import { ensureRuleLists, readRuleListShapes } from './rule-lists.mjs'

export const shareRegionRuleUrls = (profile) => collectShareRegionRuleUrls(effectiveShareRegions(profile || {}))

// 只补地区分流引用的那几条(没到 24 小时的不重拉),状态文件里站点集的那些原样留着
export const ensureShareRegionLists = async ({ store, ctx, paths, fetchImpl = globalThis.fetch, log = () => {} }) => {
  const extra = shareRegionRuleUrls(store.getProfile())
  if (!extra.length) return { ok: true, updated: [], failed: [] }
  return ensureRuleLists(ctx, paths, null, { extra, keepOthers: true, fetchImpl, log })
}

const fileSha256 = async (file) => {
  try {
    return createHash('sha256').update(await fs.promises.readFile(file)).digest('hex')
  } catch {
    return ''
  }
}

// 每个链接编好了哪几份:{ [url]: [{ tag, kind: domain | ip, sha256 }] }。按上次编译留下的形状认,文件不在的不算;
// sha256 是 .srs 文件字节的小写十六进制(App 核对规则集用的同一种)
export const shareRegionListSets = async (ctx, paths, urls) => {
  const shapes = await readRuleListShapes(ctx, paths).catch(() => ({}))
  const out = {}
  for (const { url, tag } of urls) {
    const shape = shapes[tag]
    const sets = []
    if (shape) {
      for (const [kind, setTag] of [['domain', tag], ['ip', ruleListIpTag(tag)]]) {
        if (!shape[kind]) continue
        const sha256 = await fileSha256(rulesetPath(paths, setTag))
        if (sha256) sets.push({ tag: setTag, kind, sha256 })
      }
    }
    out[url] = sets
  }
  return out
}
