// 在线生效 + 待重启判断(用户 2026-09-30:「更新订阅节点,不应该重启内核」「没必要重启内核的,都不要重启内核」
// 「即便要重启内核,放右上角统一提示即可」)。
//
// 做法:按部署时记下的生成输入(元数据的 buildInputs,api/deploy-runner.mjs 的 configFromInputs)+ 此刻的档案 / 节点 /
// 节点组重新生成一份配置,和运行中的(etc/config.json)比——
//   · 出站 / endpoint(订阅节点、节点组、故障转移子组、链式代理、站点集 selector)变了:算出要新增 / 替换 / 删除的,交给
//     内核 tcp13 的 PUT /openbox/outbounds 在线换掉,不重启。组启动时就拿住了成员对象,成员换了组也要一起重建;重建的
//     selector 从缓存文件恢复原来的选择。换之前把「运行中的配置 + 新出站」整份 sing-box check 一遍,换完写回 config.json,
//     运行中的配置和内核里的始终是同一份;
//   · 别的部分(DNS、路由规则、入站、部署时写进系统的入口放行 / dnsmasq 设置)变了:只能重启内核,由 createRestartPending
//     汇总成右上角的一个提示,不自动重启。
import { CLASH_API_BASE } from './penetration.mjs'
import { configFromInputs, directHostDomains, runExclusive } from './deploy-runner.mjs'
import { configMetaPath, deploySideInputs, hotFlipInputs } from '../system/deploy.mjs'
import { readRuleListShapes } from '../system/rule-lists.mjs'
import { validateConfigObject } from '../system/validate.mjs'
import { resolveHostsToCidrs } from '../system/resolve-hosts.mjs'
import { directResolverServers } from '../engine/dns.mjs'
import { writeNodeDirectSets } from '../system/node-direct-files.mjs'
import { isNodeDirectTag } from '../engine/direct-hosts.mjs'
import { serviceStatus } from '../system/service.mjs'
import { DNS_FILTER_RUNTIME, filterKey, filterSettings } from '../engine/dns-filter.mjs'
import { canonical, configRestartKeys, planOutboundUpdate, withOutbounds } from '../engine/hot-swap.mjs'

// 比对本身(出站怎么换、别的哪几段变了)在 engine/hot-swap.mjs,App 本机刷新订阅用同一份;原来从这里引的照旧能引
export { canonical, planOutboundUpdate, withOutbounds }

// 除出站 / endpoint 之外,运行中的和此刻该有的哪里不一样(= 要重启内核才能生效的改动)。reasons 是界面的分类:
//   dns(DNS 设置、域名过滤)/ route(分流规则)/ inbounds(tun、共享网络、DNS 入站)/ system(入口放行、dnsmasq 这些
//   部署时写进系统的设置,和别的)
export const restartReasons = ({ deployed, fresh, meta, profile }) => {
  const reasons = new Set()
  for (const key of configRestartKeys(deployed, fresh)) {
    reasons.add(key === 'dns' ? 'dns' : key === 'route' ? 'route' : key === 'inbounds' ? 'inbounds' : 'system')
  }
  const inputs = meta && meta.buildInputs
  if (inputs && inputs.deploySide && canonical(inputs.deploySide) !== canonical(deploySideInputs(profile))) reasons.add('system')
  const firstLayerInputs = meta && meta.firstLayer && meta.firstLayer.inputs
  if (firstLayerInputs && canonical(firstLayerInputs) !== canonical(hotFlipInputs(profile))) reasons.add('system')
  // 域名过滤:设置改了(名单增删、开关)要重启;名单内容更新走热更新(system/dns-filter.mjs)
  const filterNow = { enabled: profile?.dns?.filter?.enabled === true, key: filterKey(filterSettings(profile)) }
  if (meta && meta.dnsFilter && (Boolean(meta.dnsFilter.enabled) !== filterNow.enabled || (filterNow.enabled && meta.dnsFilter.key !== filterNow.key))) reasons.add('dns')
  return [...reasons]
}

const readDeployed = async (ctx, paths) => {
  let config
  let meta
  try {
    config = JSON.parse(await ctx.readFile(paths.configPath))
    meta = JSON.parse(await ctx.readFile(configMetaPath(paths)))
  } catch {
    return null
  }
  return { config, meta }
}

const freshFrom = async (store, ctx, paths, meta) => configFromInputs(store, paths, meta.buildInputs, { ruleLists: await readRuleListShapes(ctx, paths) })
// 运行中的配置是不是按规则集文件引用订阅和节点站点直连的(老版本部署的是把地址写死在规则里)
const usesNodeDirectSets = (config) => ((config && config.route && config.route.rule_set) || []).some((e) => e && isNodeDirectTag(e.tag))

const errText = (error) => (error instanceof Error ? error.message : String(error))

// 把此刻的出站 / endpoint 在线换进内核。返回 { ok:true, changed } / { ok:true, skipped } / { ok:false, reason, message }
export const applyHotOutbounds = async ({ store, ctx, paths, fetchImpl = globalThis.fetch, log = () => {}, now = () => new Date(), resolveHosts = resolveHostsToCidrs }) => {
  const startedAt = Date.now()
  if (!(await serviceStatus(ctx, paths.initd.core)).running) return { ok: true, skipped: 'not-running', changed: 0 }
  const deployed = await readDeployed(ctx, paths)
  if (!deployed) return { ok: true, skipped: 'not-deployed', changed: 0 }
  if (!deployed.meta.buildInputs) return { ok: false, reason: 'old-meta', message: '运行中的配置是老版本部署的,重启一次内核之后才能在线更新节点' }
  // 订阅和节点站点直连:订阅 / 节点的域名变了才重新解析(和部署时一样问直连 DNS);解析结果只进规则集文件
  const inputs = { ...deployed.meta.buildInputs }
  const domains = directHostDomains(store)
  const nodeDirect = usesNodeDirectSets(deployed.config)
  if (nodeDirect && canonical([...domains].sort()) !== canonical([...(inputs.directHostDomains || [])].sort())) {
    inputs.directHostCidrs = domains.length ? await resolveHosts(domains, { servers: directResolverServers(store.getProfile(), inputs.systemDns || []) }).catch(() => inputs.directHostCidrs || []) : []
    inputs.directHostDomains = domains
  }
  let fresh
  try {
    fresh = configFromInputs(store, paths, inputs, { ruleLists: await readRuleListShapes(ctx, paths) })
  } catch (error) {
    return { ok: false, reason: 'generate', message: errText(error) }
  }
  const plan = planOutboundUpdate(deployed.config, fresh.config)
  if (plan.error) return { ok: false, reason: 'plan', message: plan.error }
  const total = plan.endpoints.length + plan.outbounds.length + plan.remove.length
  let next = null
  if (total) {
    next = withOutbounds(deployed.config, fresh.config)
    const validation = await validateConfigObject(ctx, paths, next, `${paths.etc}/config.hot.json`)
    await ctx.remove(`${paths.etc}/config.hot.json`).catch(() => {})
    if (!validation.ok) return { ok: false, reason: 'validate', message: validation.message }
    let response
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      try {
        response = await fetchImpl(`${CLASH_API_BASE}/openbox/outbounds`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${store.getClashSecret()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoints: plan.endpoints, outbounds: plan.outbounds, remove: plan.remove }),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      return { ok: false, reason: 'kernel', message: `内核接口不通:${errText(error)}` }
    }
    let body = {}
    try { body = await response.json() } catch { /* 老内核的 404 不是 JSON */ }
    // 老内核(tcp12 及以前)没有这个接口:只能重启
    if (response.status === 404) return { ok: false, reason: 'kernel-old', message: '内核版本太老,不支持在线替换节点' }
    if (!response.ok) {
      // 409 / 400:内核核对没过,什么都没动;500:建到一半失败,前面的已经换了——两种都留给重启收拾,配置文件不动
      // (运行中的配置和新的还是不一样,右上角会提示重启)
      return { ok: false, reason: 'kernel-error', message: body.message || `HTTP ${response.status}` }
    }
    await ctx.writeFile(paths.configPath, JSON.stringify(next, null, 2))
  }
  // 两份规则集文件:内容变了才写,内核自己重新加载(system/node-direct-files.mjs)
  const directChanged = nodeDirect && fresh.directHosts ? (await writeNodeDirectSets(ctx, paths, fresh.directHosts)).changed : []
  const inputsChanged = canonical(inputs) !== canonical(deployed.meta.buildInputs)
  if (!total && !directChanged.length && !inputsChanged) return { ok: true, changed: 0 }
  // 故障转移的运行映射跟着新配置走;映射变了就换 generatedAt(故障转移管理器拿它当配置版本,变了才重载)
  const failoverChanged = total > 0 && canonical(deployed.meta.failover || []) !== canonical(fresh.failover || [])
  const meta = {
    ...deployed.meta,
    buildInputs: inputs,
    ...(total ? { failover: fresh.failover || [], hotAppliedAt: now().toISOString() } : {}),
    ...(failoverChanged ? { generatedAt: now().toISOString() } : {}),
  }
  await ctx.writeFile(configMetaPath(paths), JSON.stringify(meta, null, 2))
  const parts = [
    plan.created.length ? `新增 ${plan.created.length}` : '',
    plan.replaced.length ? `替换 ${plan.replaced.length}` : '',
    plan.remove.length ? `删除 ${plan.remove.length}` : '',
    directChanged.length ? '订阅和节点站点直连的地址' : '',
  ].filter(Boolean).join('、')
  if (parts) log(`[hot] 在线更新:${parts},内核没有重启(${Date.now() - startedAt} ms)`)
  return { ok: true, changed: total, created: plan.created, replaced: plan.replaced, removed: plan.remove, nodeDirect: directChanged }
}

// 档案 / 节点 / 节点组 / 订阅一改就在后台排一次在线更新(攒 1.5 秒:保存一次订阅会连着写好几处)。和部署同一条队列,
// 部署时不插进来;上一轮还在跑时来的改动,跑完再补一轮
export const createHotApplier = ({ store, ctx, paths, fetchImpl = globalThis.fetch, log = () => {}, debounceMs = 1500, exclusive = runExclusive, apply = applyHotOutbounds, onResult = () => {} }) => {
  let timer = null
  let running = null
  let again = false
  let last = null
  const run = async () => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        try {
          last = await exclusive(store, () => apply({ store, ctx, paths, fetchImpl, log }))
        } catch (error) {
          last = { ok: false, reason: 'error', message: errText(error) }
        }
        if (!last.ok) log(`[hot] 出站没能在线更新(${last.message || last.reason}),要重启内核才生效`)
        try { onResult(last) } catch { /* 订阅者自己的问题 */ }
      } while (again)
      return last
    })().finally(() => { running = null })
    return running
  }
  const request = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void run()
    }, debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  let unsubscribe = () => {}
  return {
    // 面板服务起来时才开始盯改动(单独 import 面板模块的测试不碰内核);起来先对一轮账:面板停着时改过的、上次没换进去的
    start: () => {
      unsubscribe()
      unsubscribe = typeof store.onChange === 'function' ? store.onChange(() => request()) : () => {}
      request()
    },
    request,
    // 立刻跑一轮并等结果(定时订阅更新拉完之后用,日志里能写清楚换没换进去)
    runNow: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      return run()
    },
    last: () => last,
    // 有一轮排着或正在跑:这期间运行中的出站和此刻的不一样是正常的,不算「要重启」
    busy: () => Boolean(timer || running),
    stop: () => {
      if (timer) clearTimeout(timer)
      timer = null
      unsubscribe()
      unsubscribe = () => {}
    },
  }
}

// 右上角「要重启内核」的统一提示用:运行中的配置和此刻该有的,除了能在线换的出站,还有哪里不一样。
// 结果缓存到档案 / 节点 / 节点组 / 订阅再变、部署或在线更新写过配置(元数据的时间戳变了)、规则集链接的形状或域名过滤
// 名单变了为止;兜底最多 ttlMs 后重算
export const createRestartPending = ({ store, ctx, paths, hotApplier = null, ttlMs = 5 * 60_000, now = () => Date.now() }) => {
  let revision = 0
  let cache = null
  let inflight = null
  if (typeof store.onChange === 'function') store.onChange(() => { revision += 1 })
  const compute = async () => {
    const deployed = await readDeployed(ctx, paths)
    if (!deployed) return { pending: false, reasons: [] }
    if (!deployed.meta.buildInputs) return { pending: true, reasons: ['system'] }
    const profile = store.getProfile() || {}
    let fresh
    try {
      fresh = await freshFrom(store, ctx, paths, deployed.meta)
    } catch (error) {
      // 此刻的设置按部署时的输入生成不出配置:最常见的是域名过滤的设置改了、名单还没按新设置准备(重启时部署会先准备),
      // 也可能是设置本身有问题(那重启会失败、把原因报出来)。配置比不了,别的照比;什么都比不出来也算要重启
      const reasons = restartReasons({ deployed: deployed.config, fresh: deployed.config, meta: deployed.meta, profile })
      return { pending: true, reasons: reasons.length ? reasons : ['system'], error: errText(error) }
    }
    const reasons = restartReasons({ deployed: deployed.config, fresh: fresh.config, meta: deployed.meta, profile })
    // 出站和运行中的不一样、又没有一轮在线更新排着 / 在跑:那就是没换进去(内核太老、在线更新失败),也要重启
    const plan = planOutboundUpdate(deployed.config, fresh.config)
    const outboundsDiffer = Boolean(plan.error) || plan.endpoints.length + plan.outbounds.length + plan.remove.length > 0
    if (outboundsDiffer && !(hotApplier && hotApplier.busy())) reasons.push('nodes')
    return { pending: reasons.length > 0, reasons }
  }
  const get = async () => {
    let stamp = ''
    try {
      const meta = JSON.parse(await ctx.readFile(configMetaPath(paths)))
      stamp = `${meta.generatedAt || ''}|${meta.hotAppliedAt || ''}`
    } catch { stamp = 'none' }
    // 不走档案的两样(规则集链接的形状、域名过滤名单)变了也要重算:读起来都很便宜
    let lists = ''
    try { lists = canonical(await readRuleListShapes(ctx, paths)) } catch { lists = '' }
    const filterArtifact = String(store.getRaw ? store.getRaw(DNS_FILTER_RUNTIME) || '' : '')
    const key = `${revision}|${stamp}|${hotApplier && hotApplier.busy() ? 'busy' : 'idle'}|${lists}|${filterArtifact.length}:${filterArtifact.slice(0, 64)}:${filterArtifact.slice(-64)}`
    if (cache && cache.key === key && now() - cache.at < ttlMs) return cache.value
    if (inflight && inflight.key === key) return inflight.promise
    const promise = compute().then((value) => {
      cache = { key, at: now(), value }
      return value
    }).finally(() => { if (inflight && inflight.promise === promise) inflight = null })
    inflight = { key, promise }
    return promise
  }
  return { get, invalidate: () => { cache = null } }
}
