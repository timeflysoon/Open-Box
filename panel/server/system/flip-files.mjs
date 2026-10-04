import crypto from 'node:crypto'
import { FLIP_DIR_NAME, FLIP_NEED_ALL, FLIP_NEED_CIDR, FLIP_NEED_FAKEIP, FLIP_PLACEHOLDER_SRS_BASE64, flipBypassCandidates, flipBypassTag, flipFlagContent, flipFlagMap, flipFlagStates, flipNeedTag } from '../engine/flip.mjs'
import { ENTRY_MODE_WHITELIST, normalizeRouting, policyClasses } from '../engine/routing-model.mjs'
import { FAKEIP_V4, FAKEIP_V6 } from '../engine/dns.mjs'
import { compileRuleSetAtomic, rulesetPath } from './rulesets.mjs'

// 热切换的文件那一半(纯函数在 engine/flip.mjs):开关规则集和旁路动态集都放在 data/flip/。
//   - 部署时 writeFlipFiles 按当时的选择把全套文件写好(内核启动时每个本地规则集文件都必须已经在);
//   - 翻面时 api/deploy-runner.mjs 的 applyHotFlip 只重写变了的那几个,内核盯着文件、自己重载。
export const flipDir = (paths) => `${paths.dataDir}/${FLIP_DIR_NAME}`
export const flipFlagPath = (paths, tag) => `${flipDir(paths)}/${tag}.json`
export const flipBypassPath = (paths, geoTag) => `${flipDir(paths)}/${flipBypassTag(geoTag)}.srs`
// need 侧的文件按完整 tag 存(固定的三份 + 每个 geoip 候选一份)
export const flipNeedPath = (paths, tag) => `${flipDir(paths)}/${tag}.srs`
const placeholderPath = (paths) => `${flipDir(paths)}/placeholder.srs`
// 翻面时两份旁路文件之间的间隔
const BYPASS_WRITE_GAP_MS = 200

// 运行中的内核此刻各开关的状态:取自部署元数据的 flip 段(翻面时 applyHotFlip 会更新它)。不是热切换结构就是空表。
// 读规则的各处(规则页推算、DNS 判定)拿它给 engine/flip.mjs 的 flattenFlipRule 用。缓存 1 秒:DNS 重写服务每个查询
// 都会走到这里,翻面后最多晚 1 秒看到新状态
const flipStateCache = new Map()
export const readFlipState = async (ctx, paths, { now = Date.now, ttlMs = 1000 } = {}) => {
  const key = `${paths.etc}`
  const hit = flipStateCache.get(key)
  if (hit && hit.ctx === ctx && now() - hit.at < ttlMs) return hit.value
  let value = {}
  try {
    const meta = JSON.parse(await ctx.readFile(`${paths.etc}/config.meta.json`))
    if (meta && meta.flip && meta.flip.mode === 'hot' && meta.flip.flags && typeof meta.flip.flags === 'object') value = meta.flip.flags
  } catch { /* 没部署过 / 读不到:按老结构处理 */ }
  flipStateCache.set(key, { ctx, at: now(), value })
  return value
}
export const clearFlipStateCache = () => flipStateCache.clear()

// 诊断包用:元数据里记的每个开关 / 旁路动态集,和磁盘上文件的实际内容对不对得上。对不上说明翻面写到一半出过错,
// 或者文件被别的东西动过——那样内核按文件走、面板按元数据推算,两边会说不到一起
export const flipDiagnostics = async (ctx, paths, meta) => {
  const flip = meta && meta.flip
  if (!flip || flip.mode !== 'hot') return null
  const tagToName = Object.fromEntries(Object.entries(flip.names || {}).map(([name, tag]) => [tag, name]))
  const flags = []
  for (const [tag, on] of Object.entries(flip.flags || {})) {
    let file = 'missing'
    try { file = (await ctx.readFile(flipFlagPath(paths, tag))).includes('"network"') ? 'on' : 'off' } catch { /* 文件不在 */ }
    flags.push({ policy: tagToName[tag] || '', tag, meta: on ? 'on' : 'off', file })
  }
  const bypass = []
  for (const [geoTag, full] of Object.entries(flip.bypass || {})) {
    const content = bypassContentOf(flip, geoTag)
    bypass.push({ set: geoTag, meta: !full ? 'placeholder' : content === 'full' ? 'full' : 'trimmed', fileExists: await ctx.exists(flipBypassPath(paths, geoTag)) })
  }
  const need = []
  for (const [tag, content] of Object.entries(flip.need || {})) {
    need.push({ set: tag, meta: content === 'placeholder' ? 'placeholder' : content === 'full' ? 'full' : 'compiled', fileExists: await ctx.exists(flipNeedPath(paths, tag)) })
  }
  return {
    mode: flip.mode, bypassMode: flip.bypassMode || '', entryMode: flip.entryMode || '', flippedAt: flip.flippedAt || '',
    flags, bypass, need,
    mismatched: flags.filter((f) => f.file !== f.meta).map((f) => f.policy || f.tag),
  }
}

// 每份旁路动态集此刻的内容标识:'placeholder'(空)/ 'full'(原集合的拷贝)/ 'sha:…'(裁剪过的,按 CIDR 名单算的哈希)。
// 翻面时按它比:同样是「满」,扣掉的段变了(前面哪个站点集走代理变了)也要重写
const trimmedHash = (cidrs) => `sha:${crypto.createHash('sha1').update(cidrs.join('\n')).digest('hex').slice(0, 16)}`
export const bypassContentOf = (state, tag) => {
  if (!state || !state.bypass || !state.bypass[tag]) return 'placeholder'
  const c = state.bypassContent && state.bypassContent[tag]
  return typeof c === 'string' && c ? c : 'full'
}

// 此刻的目标状态:每个开关 ON / OFF,每个候选 geoip 是「满」(原集合的拷贝 / 裁剪过的一份)还是「空」(占位地址)。
// nativeBypass 是做过重叠核对的旁路结论(system/native-bypass.mjs),只有它点头的集合才放满;它说要扣掉几段的
// (trimmed),就按剩下的 CIDR 另编一份(GitHub #224)
// entryMode:entryModePlan 的结论(engine/routing-model.mjs)。need 侧每份文件的内容:'placeholder' / 'full'(原 geoip
// 集合的拷贝)/ 'cidr:<hash>'(按名单编的);needCidrs 是编的内容。黑名单模式时 obflip-need-all 是"全部",其余
// 照样跟着类别走(那时它们不起作用,但切到白名单时就只用换 all 这一份)
export const flipTargetState = ({ routing, members, builtin, selections, nativeBypass, entryMode = null }) => {
  const conf = normalizeRouting(routing)
  const classes = policyClasses(routing, members, builtin, selections || {})
  const full = new Set(nativeBypass && nativeBypass.enabled && Array.isArray(nativeBypass.sets) ? nativeBypass.sets : [])
  const trimmed = (nativeBypass && nativeBypass.enabled && nativeBypass.trimmed && typeof nativeBypass.trimmed === 'object') ? nativeBypass.trimmed : {}
  const candidates = flipBypassCandidates(conf)
  const bypassTrimmed = {}
  const bypassContent = {}
  for (const tag of candidates) {
    if (!full.has(tag)) { bypassContent[tag] = 'placeholder'; continue }
    const t = trimmed[tag]
    if (t && Array.isArray(t.cidrs) && t.cidrs.length) { bypassTrimmed[tag] = t.cidrs; bypassContent[tag] = trimmedHash(t.cidrs) } else bypassContent[tag] = 'full'
  }
  const whitelist = Boolean(entryMode && entryMode.mode === ENTRY_MODE_WHITELIST)
  const needSets = new Set(entryMode && Array.isArray(entryMode.needSets) ? entryMode.needSets : [])
  const need = {}
  const needCidrs = {}
  const compiled = (tag, cidrs) => { needCidrs[tag] = cidrs; need[tag] = `cidr:${trimmedHash(cidrs).slice(4)}` }
  // v6 这一版一律进内核:白名单模式下 all 只剩 ::/0;黑名单模式下是全部
  compiled(FLIP_NEED_ALL, whitelist ? ['::/0'] : ['0.0.0.0/0', '::/0'])
  if (entryMode && entryMode.fakeIp) compiled(FLIP_NEED_FAKEIP, [FAKEIP_V4, FAKEIP_V6]); else need[FLIP_NEED_FAKEIP] = 'placeholder'
  const cidrs = entryMode && Array.isArray(entryMode.needCidrs) ? entryMode.needCidrs : []
  if (cidrs.length) compiled(FLIP_NEED_CIDR, cidrs); else need[FLIP_NEED_CIDR] = 'placeholder'
  // 每个 geoip 候选:站点集此刻走代理 / 拒绝 → 满(必须进内核),走直连 → 空。entryMode 只在白名单时给 needSets;
  // 黑名单时按类别自己算,这样切到白名单只需换 all 那一份
  const proxied = new Set()
  for (const p of conf.activePolicies) if (classes[p.name] && classes[p.name] !== 'direct') for (const tag of p.rulesets) if (/^geoip-/.test(tag)) proxied.add(tag)
  for (const tag of candidates) need[flipNeedTag(tag)] = needSets.has(tag) || proxied.has(tag) ? 'full' : 'placeholder'
  return {
    classes,
    flags: flipFlagStates(conf, classes),
    names: Object.fromEntries(flipFlagMap(conf)),
    bypass: Object.fromEntries(candidates.map((tag) => [tag, full.has(tag)])),
    bypassContent,
    bypassTrimmed,
    entryMode: whitelist ? ENTRY_MODE_WHITELIST : 'blacklist',
    need,
    needCidrs,
  }
}

// 占位 .srs:旁路动态集的「空」状态(不能真空,见 engine/flip.mjs)。内容固定,字节内嵌在代码里,写出来就行,不起内核进程
const ensurePlaceholder = async (ctx, paths) => {
  await ctx.writeFileBinary(placeholderPath(paths), Buffer.from(FLIP_PLACEHOLDER_SRS_BASE64, 'base64'))
}

// 动态集文件三种内容:占位(空)/ 原 geoip 集合的拷贝 / 按 CIDR 名单编一份新 .srs(sing-box rule-set compile,和域名过滤
// 那边一样)。编不出来就退回占位,把错误抛给调用方记日志——不能让一份编坏的集合把内核卡在启动。
// 退回占位对两侧都是安全方向:旁路侧 = 不旁路;need 侧 = 这份不进内核名单(白名单模式下这份的目标会被放走——
// 所以 need 侧编坏时调用方要把整个入口退回黑名单,见 deploy-runner)
const writeDynamicSet = async (ctx, paths, target, { geoTag = '', cidrs = null, label = target } = {}) => {
  if (Array.isArray(cidrs) && cidrs.length) {
    const jsonPath = `${target}.json`
    await ctx.writeFile(jsonPath, JSON.stringify({ version: 3, rules: [{ ip_cidr: cidrs }] }))
    try {
      const r = await compileRuleSetAtomic(ctx, paths.singbox, jsonPath, target)
      if (r.code !== 0) {
        await ctx.copyFile(placeholderPath(paths), target)
        throw new Error(`动态集合「${label}」编不出来,先按占位处理:${String(r.stderr || '').trim() || `exit ${r.code}`}`)
      }
    } finally {
      await ctx.remove(jsonPath).catch(() => {})
    }
    return
  }
  await ctx.copyFile(geoTag ? rulesetPath(paths, geoTag) : placeholderPath(paths), target)
}
const writeBypass = (ctx, paths, geoTag, full, trimmedCidrs = null) =>
  writeDynamicSet(ctx, paths, flipBypassPath(paths, geoTag), full ? { geoTag: Array.isArray(trimmedCidrs) && trimmedCidrs.length ? '' : geoTag, cidrs: trimmedCidrs, label: `旁路 ${geoTag}` } : {})
// need 侧:tag 是完整的 obflip-need-*;'full' 时源文件是去掉前缀的 geoip 集合
const writeNeed = (ctx, paths, tag, content, cidrs = null) =>
  writeDynamicSet(ctx, paths, flipNeedPath(paths, tag), content === 'placeholder' ? {} : { geoTag: content === 'full' ? tag.slice(FLIP_NEED_PREFIX_LEN) : '', cidrs: content === 'full' ? null : cidrs, label: `进内核 ${tag}` })
const FLIP_NEED_PREFIX_LEN = flipNeedTag('').length

// 部署时:全套重写。dynamicBypass = 这份配置的入口旁路是不是动态集(有 nft 重定向才是)。
// 纯 tun 是静态写法:配置只引用此刻旁路、且裁剪过的那几份 obflip-byp-*(engine/config.mjs),就只写它们;
// need 侧(白名单)纯 tun 没有,不写
export const writeFlipFiles = async (ctx, paths, state, { dynamicBypass = true } = {}) => {
  await ctx.mkdirp(flipDir(paths))
  for (const [tag, on] of Object.entries(state.flags)) await ctx.writeFile(flipFlagPath(paths, tag), flipFlagContent(on))
  const tags = Object.keys(state.bypass).filter((tag) => dynamicBypass || (state.bypass[tag] && state.bypassTrimmed && state.bypassTrimmed[tag]))
  if (!tags.length) return
  await ensurePlaceholder(ctx, paths)
  for (const tag of tags) await writeBypass(ctx, paths, tag, state.bypass[tag], state.bypassTrimmed && state.bypassTrimmed[tag])
  if (!dynamicBypass) return
  for (const [tag, content] of Object.entries(state.need || {})) await writeNeed(ctx, paths, tag, content, state.needCidrs && state.needCidrs[tag])
}

// 翻面时:只写变了的,顺序有讲究——
//   直连 → 代理:先把它的 IP 从入口旁路里收回来(流量先进内核,此刻内核仍按直连连,没有错),再开开关;
//   代理 → 直连:先关开关(内核改按直连连),再放进旁路。
// 反过来会有一瞬间「DNS / 拒绝规则已经按代理走、IP 却还在入口被旁路」。返回写了哪些
export const applyFlipDiff = async (ctx, paths, prev, next, { dynamicBypass = true } = {}) => {
  const pace = async () => { if (typeof ctx.sleep === 'function') await ctx.sleep(BYPASS_WRITE_GAP_MS) }
  const changedFlags = Object.keys(next.flags).filter((tag) => Boolean(prev.flags && prev.flags[tag]) !== next.flags[tag])
  // 按内容比:空 ↔ 满、满 ↔ 裁剪过的、裁剪过的两份不一样,都要重写。need 侧同样按内容比
  const changedBypass = dynamicBypass ? Object.keys(next.bypass).filter((tag) => bypassContentOf(prev, tag) !== bypassContentOf(next, tag)) : []
  const changedNeed = dynamicBypass ? Object.keys(next.need || {}).filter((tag) => ((prev.need && prev.need[tag]) || 'placeholder') !== next.need[tag]) : []
  if (!changedFlags.length && !changedBypass.length && !changedNeed.length) return { flags: [], bypass: [], need: [] }
  await ctx.mkdirp(flipDir(paths))
  if ((changedBypass.length || changedNeed.length) && !(await ctx.exists(placeholderPath(paths)))) await ensurePlaceholder(ctx, paths)
  // need 侧先写"要进内核的"再写"放走的":直连 → 代理时先把它的 IP 收进内核、再撤旁路;代理 → 直连时先撤内核名单
  // 里的、再放旁路——和下面开关的顺序同一个道理,过渡瞬间宁可多进内核
  for (const tag of changedNeed.filter((t) => next.need[t] !== 'placeholder')) { await writeNeed(ctx, paths, tag, next.need[tag], next.needCidrs && next.needCidrs[tag]); await pace() }
  // 旁路文件逐份写、之间留一小段:内核对每份文件各起一个重载,几份同时变时整个 nft 集合会被并发重建、互相交错
  // (报 file exists、集合残缺;内核 tcp9 起已加锁串行,这里再错开是给老内核留的余地,也少几次白重建)
  for (const tag of changedBypass.filter((t) => !next.bypass[t])) { await writeBypass(ctx, paths, tag, false); await pace() }
  for (const tag of changedFlags.filter((t) => next.flags[t])) await ctx.writeFile(flipFlagPath(paths, tag), flipFlagContent(true))
  for (const tag of changedFlags.filter((t) => !next.flags[t])) await ctx.writeFile(flipFlagPath(paths, tag), flipFlagContent(false))
  for (const tag of changedBypass.filter((t) => next.bypass[t])) { await writeBypass(ctx, paths, tag, true, next.bypassTrimmed && next.bypassTrimmed[tag]); await pace() }
  for (const tag of changedNeed.filter((t) => next.need[t] === 'placeholder')) { await writeNeed(ctx, paths, tag, 'placeholder'); await pace() }
  return { flags: changedFlags, bypass: changedBypass, need: changedNeed }
}
