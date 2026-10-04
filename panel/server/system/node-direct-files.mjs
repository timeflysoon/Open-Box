// 「订阅和节点站点直连」的两份规则集文件(engine/direct-hosts.mjs 的 NODE_DIRECT_*):部署时在内核启动之前写好(内核启动时
// 每个本地规则集文件都得在),在线更新节点时(api/hot-apply.mjs)内容变了再写。source 格式、免编译;ctx.writeFile 是先写临时
// 文件再改名的原子替换,内核盯着规则集目录,看到新文件自己重新加载,不重启。内容和上次一样就不动文件
import { nodeDirectFile, nodeDirectSources } from '../engine/direct-hosts.mjs'
import { dropRuleSetIndex } from './ruleset-index.mjs'

export const writeNodeDirectSets = async (ctx, paths, directHosts) => {
  const changed = []
  await ctx.mkdirp(paths.rulesetDir)
  for (const [tag, source] of Object.entries(nodeDirectSources(directHosts))) {
    const file = nodeDirectFile(paths.rulesetDir, tag)
    const text = JSON.stringify(source)
    let previous = null
    try { previous = await ctx.readFile(file) } catch { /* 第一次写 */ }
    if (previous === text) continue
    await ctx.writeFile(file, text)
    changed.push(tag)
  }
  // 规则页推算用的进程内索引按 tag 缓存着内容,换了就作废
  if (changed.length) dropRuleSetIndex(changed)
  return { changed }
}
