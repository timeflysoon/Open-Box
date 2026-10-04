// 规则集链接:把站点集里引用的那些网址下回来,编成内核能用的 .srs。
//
// 和 system/rulesets.mjs 的分工:那边是 geosite / geoip,名字固定、上游固定、已经是编好的
// .srs,只管缺了就下;这边是用户自己填的任意网址,要先解析成条件、写成源格式、再调
// `sing-box rule-set compile` 编成二进制。两种来源都收:
//   · 文本名单 —— Clash 的 DOMAIN-SUFFIX,xxx 那种,或者一行一个域名(engine/rule-list.mjs)
//   · mihomo 的 .mrs —— 整份 zstd,里面是二进制的域名树 / IP 区间(engine/mrs.mjs)。
//     内核自己不认这个格式(`sing-box rule-set convert` 只会转 adguard),所以在这里解开。
//   · sing-box 的 .srs —— 内核自己编的二进制(比如 one-geoip 的 one-china.srs,GitHub #217),
//     交给内核 `rule-set decompile` 解回源格式,再按同一套拆成域名 / IP 两份重编。
// 三条路解析出来的形状一样,后面编译、引用、部署完全共用。
//
// 失败的处理分两种:
//   · 本地已经有编好的那份 —— 拉不动就用旧的,记一条日志。名单在别人服务器上,不该
//     因为对方今天抽风就让整次部署失败(用户可能只是改了个节点)。
//   · 本地没有 —— 那这个站点集的规则在内核里就是空的,必须让部署停下来说清楚,
//     否则内核会在校验阶段报 "open .../list-xxxxxxxx.srs: no such file or directory"。
import { zstdDecompressSync } from 'node:zlib'
import { collectRuleListUrls } from '../engine/routing-model.mjs'
import { decodeMrs, looksLikeZstd } from '../engine/mrs.mjs'
import { listTagForUrl, looksLikeSrs, parseRuleList, parseRuleSource, ruleListIsEmpty, ruleListShape, ruleListToSource, ruleListIpTag, splitRuleList } from '../engine/rule-list.mjs'
import { compileRuleSetAtomic } from './rulesets.mjs'

const FETCH_TIMEOUT_MS = 30000
// 一份名单撑死几百 KB;给 8MB 挡住"拿到一个几百 MB 的东西把路由器内存吃光"
const MAX_BYTES = 8 * 1024 * 1024
// .mrs 是压缩的,解压后还要再挡一道:8MB 的 zstd 能炸出几个 G,路由器只有 1GB 内存。
// geosite 里最大的 cn 也就解出 900KB,32MB 已经很宽松了。
const MAX_DECOMPRESSED = 32 * 1024 * 1024
// 多久重下一次。名单是别人维护的,会变;但也不该每次部署都去拉一遍——
// 部署是个本来纯本地的操作,不该动不动依赖外网。
const REFRESH_MS = 24 * 60 * 60 * 1000
// 编译产物的版式。2 = 域名 / IP 拆成两份 .srs(见 engine/rule-list.mjs 的 splitRuleList)。
// 状态里记的版式不是这个数,说明本地那份是老版式(域名 IP 混在一个文件里),要重编——
// 老版式的文件被 DNS 规则引用时,就是那个"每个域名先查一遍再扔掉"的毛病。
const SPLIT_VERSION = 2

export const listStatePath = (paths) => `${paths.dataDir}/rule-lists.json`

const readState = async (ctx, paths) => {
  try {
    const raw = JSON.parse(await ctx.readFile(listStatePath(paths)))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

// 超时和大小上限都要管到响应体读完为止:以前拿到响应头就清掉计时器、再 arrayBuffer() 一次性
// 读完整个响应才比大小——几百 MB 的东西照样先进内存,一直慢慢吐内容的对端也不受 30 秒约束,
// 还会一直占着部署队列。现在流式累计,越限立即断开;计时器到读完才清。
const tooLarge = (bytes) => new Error(`名单太大（超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB${bytes ? `,已到 ${Math.round(bytes / 1024)}KB` : ''})`)
export const fetchRuleList = async (fetchImpl, url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 计时器到点时不管 fetch 实现有没有把 signal 接到响应体上,这边都要能停下来
  const timedOut = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）`)), { once: true })
  })
  timedOut.catch(() => {})
  try {
    let res
    try {
      res = await Promise.race([fetchImpl(url, { signal: controller.signal, redirect: 'follow' }), timedOut])
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）`)
      throw err
    }
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '无响应'}`)
    const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN)
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      controller.abort()
      throw tooLarge(declared)
    }
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      const chunks = []
      let total = 0
      // 每块不再 Promise.race 一次:race 会在永不结束的 timedOut 上各留一条 reaction,经代理的连接一块只有几十字节时,
      // 一份 2 MB 名单能攒几万条,活堆冲过几十 MB(1 GB 路由器上就是一次 OOM;本机 50 字节一块、32 MB 堆上限复现)。
      // 改成只有当前这一次 read 能被超时打断,读完就丢
      let interrupt = null
      const timeout = () => new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）`)
      const onAbort = () => interrupt?.(timeout())
      controller.signal.addEventListener('abort', onAbort, { once: true })
      try {
        for (;;) {
          if (controller.signal.aborted) throw timeout()
          const { done, value } = await new Promise((resolve, reject) => { interrupt = reject; reader.read().then(resolve, reject) })
          interrupt = null
          if (done) break
          total += value.byteLength
          if (total > MAX_BYTES) throw tooLarge(total)
          chunks.push(Buffer.from(value))
        }
      } catch (err) {
        // 越限 / 超时:把连接断掉,别让对端继续往这边灌
        await reader.cancel().catch(() => {})
        controller.abort()
        throw err
      } finally {
        controller.signal.removeEventListener('abort', onAbort)
      }
      return Buffer.concat(chunks, total)
    }
    // 没有流的响应(测试桩、老运行时):退回一次性读,再比大小
    const buf = Buffer.from(await Promise.race([res.arrayBuffer(), timedOut]))
    if (buf.length > MAX_BYTES) throw tooLarge(buf.length)
    return buf
  } finally {
    clearTimeout(timer)
  }
}

// 下回来的东西 → 结构化条件。三种:
//   · 文本名单(Clash 规则行 / 一行一个域名),交给 engine/rule-list.mjs
//   · mihomo 的 .mrs(整份 zstd,里面是二进制),先解压再交给 engine/mrs.mjs
//   · sing-box 的 .srs(魔数 SRS),交给 decompile(内核 rule-set decompile,见 srsDecompiler)
// 认的是内容开头的魔数不是网址后缀:网址可能带一堆查询参数,也可能经过代理改名。
export const parseRuleListBody = async (buf, { decompile } = {}) => {
  if (looksLikeSrs(buf)) {
    if (typeof decompile !== 'function') throw new Error('这是 sing-box 编好的 .srs 规则集,要由内核解开')
    return parseRuleSource(await decompile(buf))
  }
  if (!looksLikeZstd(buf)) return parseRuleList(buf.toString('utf8'))
  if (typeof zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd,解不开 .mrs 规则集')
  }
  const payload = zstdDecompressSync(buf, { maxOutputLength: MAX_DECOMPRESSED })
  return decodeMrs(payload).parsed
}

const removeIfExists = async (ctx, path) => {
  if (await ctx.exists(path)) await ctx.remove(path)
}

// .srs → 源格式:写到临时文件,让内核 decompile 出 JSON,读回来、两份临时文件都删。tag 只是给临时文件起名
export const srsDecompiler = (ctx, paths, tag = 'remote') => async (buf) => {
  const srsPath = `${paths.dataDir}/tmp/${tag}.srs`
  const jsonPath = `${paths.dataDir}/tmp/${tag}.srs.json`
  await ctx.mkdirp(`${paths.dataDir}/tmp`)
  await ctx.writeFileBinary(srsPath, buf)
  try {
    const r = await ctx.exec(paths.singbox, ['rule-set', 'decompile', '--output', jsonPath, srsPath])
    if (r.code !== 0) throw new Error(`内核解不开这份 .srs:${(r.stderr || '').trim() || `exit ${r.code}`}`)
    return JSON.parse(await ctx.readFile(jsonPath))
  } finally {
    await removeIfExists(ctx, srsPath)
    await removeIfExists(ctx, jsonPath)
  }
}

export const loadRuleList = async (fetchImpl, url, opts = {}) => parseRuleListBody(await fetchRuleList(fetchImpl, url), opts)

// 一份源格式 → 一份 .srs。写临时源文件、编译、删临时文件。
const compileSrs = async (ctx, paths, tag, parsed) => {
  const srcPath = `${paths.dataDir}/tmp/${tag}.json`
  const outPath = `${paths.rulesetDir}/${tag}.srs`
  await ctx.writeFile(srcPath, JSON.stringify(ruleListToSource(parsed)))
  try {
    const r = await compileRuleSetAtomic(ctx, paths.singbox, srcPath, outPath)
    if (r.code !== 0) throw new Error(`编译规则集失败:${(r.stderr || '').trim() || `exit ${r.code}`}`)
  } finally {
    await ctx.remove(srcPath)
  }
}

// 解析好的名单 → 域名一份 list-xxx.srs、IP 一份 list-xxx-ip.srs(哪边没有内容就不出那份文件,
// 上次留下的同名旧文件也删掉,免得配置里引用不到它却还躺在磁盘上)。返回每类条数。
const compileParsed = async (ctx, paths, tag, parsed) => {
  if (ruleListIsEmpty(parsed)) throw new Error('这份名单里没有解析出任何域名或 IP')
  const counts = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v.length).map(([k, v]) => [k, v.length]))
  const { domains, ips } = splitRuleList(parsed)
  const shape = ruleListShape(counts)

  await ctx.mkdirp(`${paths.dataDir}/tmp`)
  await ctx.mkdirp(paths.rulesetDir)
  if (shape.domain) await compileSrs(ctx, paths, tag, domains)
  else await removeIfExists(ctx, `${paths.rulesetDir}/${tag}.srs`)
  if (shape.ip) await compileSrs(ctx, paths, ruleListIpTag(tag), ips)
  else await removeIfExists(ctx, `${paths.rulesetDir}/${ruleListIpTag(tag)}.srs`)
  return counts
}

// 一个链接 → 拉回来、解析(.srs 交给内核解)、编译
const compileOne = async (ctx, paths, { url, tag }, fetchImpl) =>
  compileParsed(ctx, paths, tag, await loadRuleList(fetchImpl, url, { decompile: srsDecompiler(ctx, paths, tag) }))

// 老版式的本地文件(域名 IP 混在一份 list-xxx.srs 里)不用重新下:用内核解回源格式,再拆成
// 两份编译。这样升级后第一次部署就能拿到拆好的文件,不依赖外网(路由器拉 GitHub 未必通);
// 名单本身到了重下时间照常重下。
const resplitLegacy = async (ctx, paths, tag) => {
  const legacyPath = `${paths.rulesetDir}/${tag}.srs`
  const tmp = `${paths.dataDir}/tmp/${tag}.legacy.json`
  await ctx.mkdirp(`${paths.dataDir}/tmp`)
  const r = await ctx.exec(paths.singbox, ['rule-set', 'decompile', '--output', tmp, legacyPath])
  if (r.code !== 0) throw new Error(`解开旧规则集失败:${(r.stderr || '').trim() || `exit ${r.code}`}`)
  let source
  try {
    source = JSON.parse(await ctx.readFile(tmp))
  } finally {
    await removeIfExists(ctx, tmp)
  }
  return compileParsed(ctx, paths, tag, parseRuleSource(source))
}

// 部署前、生成配置之前调一次:把档案里引用到的规则集链接补齐。
// 已经有、且没到重下时间的跳过;拉不动但本地有旧的就用旧的。
// 返回的 lists 是形状表 { [tag]: { domain, ip } }:每条链接编成了哪几份 .srs,生成配置时
// 路由规则 / DNS 规则凭它决定引用哪几份(见 engine/routing-model.mjs)。只有老版式、
// 又拉不动的那种才会缺形状——生成配置时就按老样子引用一份。
export const ensureRuleLists = async (
  ctx,
  paths,
  routing,
  { fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} } = {},
) => {
  const wanted = collectRuleListUrls(routing)
  if (!wanted.length) return { ok: true, updated: [], failed: [], lists: {} }

  const state = await readState(ctx, paths)
  const next = {}
  const updated = []
  const failed = []
  const errText = (error) => (error instanceof Error ? error.message : String(error))
  for (const item of wanted) {
    const prev = state[item.tag]
    const exists = (await ctx.exists(`${paths.rulesetDir}/${item.tag}.srs`))
      || (await ctx.exists(`${paths.rulesetDir}/${ruleListIpTag(item.tag)}.srs`))
    const upToDate = exists && prev && prev.url === item.url && now() - Number(prev.at || 0) < REFRESH_MS
    if (upToDate && prev.split === SPLIT_VERSION) {
      next[item.tag] = prev
      continue
    }
    if (upToDate) {
      // 名单不旧、只是老版式:离线重编,不碰网络
      try {
        const counts = await resplitLegacy(ctx, paths, item.tag)
        next[item.tag] = { ...prev, counts, split: SPLIT_VERSION }
        updated.push(item.tag)
        log(`[rule-list] ${item.tag} 由老版式重编为域名 / IP 两份`)
        continue
      } catch (error) {
        log(`[rule-list] ${item.tag} 老版式重编失败（${errText(error)}）,改为重新拉取`)
      }
    }
    try {
      const counts = await compileOne(ctx, paths, item, fetchImpl)
      next[item.tag] = { url: item.url, at: now(), counts, split: SPLIT_VERSION }
      updated.push(item.tag)
      log(`[rule-list] ${item.url} → ${item.tag}(${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})`)
    } catch (error) {
      const message = errText(error)
      failed.push({ tag: item.tag, url: item.url, message })
      if (!exists) {
        return { ok: false, updated, failed, message: `规则集链接拉取失败:${item.url} —— ${message}` }
      }
      // 有旧的就接着用:名单在别人服务器上,不该因为对方今天抽风就让部署失败。
      // 旧的是老版式就顺手离线拆一下,DNS 规则才引用得到纯域名那份。
      let entry = prev || { url: item.url, at: 0 }
      if (entry.split !== SPLIT_VERSION) {
        try {
          entry = { ...entry, counts: await resplitLegacy(ctx, paths, item.tag), split: SPLIT_VERSION }
          log(`[rule-list] ${item.tag} 由老版式重编为域名 / IP 两份`)
        } catch (e2) {
          log(`[rule-list] ${item.tag} 老版式重编失败（${errText(e2)}）`)
        }
      }
      next[item.tag] = entry
      log(`[rule-list] ${item.url} 拉取失败（${message}）,沿用本地已有的那份`)
    }
  }
  await ctx.writeFile(listStatePath(paths), JSON.stringify(next, null, 2))
  return { ok: true, updated, failed, lists: shapesOf(next) }
}

// 「立即更新」(#155):名单 24 小时才随部署重拉一次,自己维护名单的人改完想马上生效。这里不看新旧,直接重拉
// 重编到同一个路径——内核盯着本地 .srs 文件,变了会自己重新加载,不用重启。只有名单的构成变了(原来只有域名、
// 现在多了 IP,或反过来)才要重启:配置里引用的是哪几份 .srs 在生成配置时就定了。
// 拉不动 / 编译失败就抛出去,本地那份原样留着。
export const refreshRuleList = async (ctx, paths, url, { fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} } = {}) => {
  const tag = listTagForUrl(url)
  const state = await readState(ctx, paths)
  const prev = state[tag]
  const before = prev && prev.split === SPLIT_VERSION && prev.counts ? ruleListShape(prev.counts) : null
  const counts = await compileOne(ctx, paths, { url, tag }, fetchImpl)
  const after = ruleListShape(counts)
  state[tag] = { url, at: now(), counts, split: SPLIT_VERSION }
  await ctx.writeFile(listStatePath(paths), JSON.stringify(state, null, 2))
  log(`[rule-list] 立即更新 ${url} → ${tag}(${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})`)
  // 之前没编过(还没部署过这条链接)不算构成变化:下次部署自然按新形状引用
  const shapeChanged = Boolean(before) && (before.domain !== after.domain || before.ip !== after.ip)
  return { tag, tags: [tag, ruleListIpTag(tag)], counts, total: Object.values(counts).reduce((a, b) => a + b, 0), shapeChanged }
}

// 状态表 → 形状表(每条名单编成了域名 / IP 哪几份)。老版式(没有 split 标记)的本地文件是
// 域名 IP 混在一起的一份,形状说不清,不填
const shapesOf = (state) => {
  const lists = {}
  for (const [tag, entry] of Object.entries(state || {})) {
    if (entry && entry.split === SPLIT_VERSION && entry.counts) lists[tag] = ruleListShape(entry.counts)
  }
  return lists
}

// 不拉网络、只按上次部署留下的状态读形状表:规则页推算「规则路由」要和生成配置时引用的是
// 同一份 .srs(域名那份还是 IP 那份),否则算出来的"第几条"对不上
export const readRuleListShapes = async (ctx, paths) => shapesOf(await readState(ctx, paths))
