// Geo 数据属于安装包。启动、详情、DNS 转发统一读取同一份只读快照，不在线补文件。
// 用户名单和 DNS 过滤是本机编译的产物，仍保留各自的数据路径。
import { isRuleListTag } from '../engine/rule-list.mjs'
import { isDnsFilterRulesetTag } from '../engine/dns-filter.mjs'
import { isFlipTag } from '../engine/flip.mjs'
import { isNodeDirectTag } from '../engine/direct-hosts.mjs'
import { isSafeRulesetTag, rulesetKind } from '../engine/ruleset-tags.mjs'
import { createPaths } from './paths.mjs'

export { isSafeRulesetTag, rulesetKind }

export const rulesetPath = (paths, tag) => {
  if (!isSafeRulesetTag(tag)) throw new Error(`不合法的规则集名 ${tag}`)
  return `${rulesetKind(tag) ? paths.geoDir : paths.rulesetDir}/${tag}.srs`
}

// 源格式 → .srs,并原子换上。内核对本地规则集文件边监视边重载,直接 `compile --output` 到正在用的那份,内核可能读到
// 写了一半的文件(#382 旁路由日志「reload rule-set obflip-byp-geoip-cn: read rule[0]: unexpected EOF」)。所以先编到
// 同目录的临时文件,再用 copyFile(先写临时文件再 rename,system/context-real.mjs)换上;编不过目标文件原样不动。
// 返回 sing-box 的执行结果(code / stderr),调用方照旧按 code 判断
export const compileRuleSetAtomic = async (ctx, singbox, srcPath, outPath) => {
  const tmp = `${outPath}.new`
  try {
    const r = await ctx.exec(singbox, ['rule-set', 'compile', '--output', tmp, srcPath])
    if (r.code === 0) await ctx.copyFile(tmp, outPath)
    return r
  } finally {
    await ctx.remove(tmp).catch(() => {})
  }
}

export const ensureRulesets = async (ctx, config, { paths = createPaths() } = {}) => {
  for (const entry of config?.route?.rule_set || []) {
    if (!entry || entry.type !== 'local' || !entry.tag || !entry.path) continue
    // 热切换的开关 / 旁路动态集(engine/flip.mjs)、订阅和节点站点直连(engine/direct-hosts.mjs)自带路径,文件由部署流程现写,
    // 不是要下载的规则集
    if (isRuleListTag(entry.tag) || isDnsFilterRulesetTag(entry.tag) || isFlipTag(entry.tag) || isNodeDirectTag(entry.tag)) continue
    if (!rulesetKind(entry.tag)) {
      return { ok: false, message: `未知或不合法的规则集名 ${entry.tag}:只认得 geoip-/geosite- 开头的规则集` }
    }
    const path = rulesetPath(paths, entry.tag)
    if (!(await ctx.exists(path))) {
      return { ok: false, message: `安装包缺少规则集 ${entry.tag}，请更新或重新安装 Open-Box` }
    }
    // 迁移旧配置的 data/rulesets 路径；旧下载缓存不再遮住随包的新数据。
    entry.path = path
  }
  return { ok: true, downloaded: [] }
}
