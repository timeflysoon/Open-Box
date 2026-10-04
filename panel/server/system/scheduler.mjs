// 自动更新计划:面板进程自己每分钟看一眼档案里的计划,到点就做;不依赖 cron。
// 程序、内核、Geo 数据一起由 Open-Box 更新脚本处理，订阅保留独立计划。
import { applyHotFlip, fetchSelections, resolveSelections, runExclusive } from '../api/deploy-runner.mjs'
import { readJsonFile, writeJsonFile, readMeta, fetchLatestVersion, compareVersions, startUpdate, readUpdateStatus } from './updater.mjs'
import { serviceStatus } from './service.mjs'
import { refreshSubscriptionById } from '../api/subscriptions.mjs'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

export const runScheduledTasks = async ({ store, ctx, paths, fetchImpl = globalThis.fetch, subscriptionFetchImpl, lookup, hotApplier, now = new Date(), log = () => {}, ...deps }) => {
  // 内核跑着就把各 selector 当前的选择存成快照,给内核停着时的部署用(见 store)
  try {
    if (typeof store.getClashSecret === 'function') {
      const live = await fetchSelections(fetchImpl, store.getClashSecret())
      const selections = resolveSelections(store, live)
      // 热切换的每分钟对账:别的客户端直接调内核接口切了站点集、或者故障转移把站点集带离了直连,面板这边没有
      // 收到切换请求,开关文件就会落后。这里只在内核真的在跑(读到了选择)时比一次,只改写开关文件——
      // **绝不**从这里触发重启;走不通就记一笔,等下次经面板切换或部署
      if (Object.keys(live || {}).length) {
        const r = await (deps.exclusive || runExclusive)(store, () => (deps.applyHotFlip || applyHotFlip)({ store, ctx, paths, selections, log }))
        if (!r.ok && r.reason && !/还没重启内核/.test(r.reason)) log(`[scheduler] 热切换对账没做成:${r.reason}`)
      }
    }
  } catch { /* 读不到就留着上次的 */ }

  const updates = (store.getProfile() || {}).updates || {}
  const state = await readJsonFile(ctx, paths.scheduleStatePath, {})
  const hour = now.getHours()
  const today = dayKey(now)
  let changed = false

  // Geo 跟随发布包，忽略旧备份/旧档案中遗留的 updates.geo 计划。
  const ob = updates.openbox || {}
  if (ob.auto && Number(ob.hour) === hour && state.openboxDay !== today) {
    const days = Math.max(1, Number(ob.days) || 1)
    const last = state.openboxLastAt ? new Date(state.openboxLastAt) : null
    const due = !last || now - last >= (days - 0.5) * 24 * 3600 * 1000
    state.openboxDay = today
    changed = true
    if (due) {
      try {
        const status = await readUpdateStatus(ctx, paths)
        if (!status.running) {
          const meta = await readMeta(ctx, paths)
          const { latest } = await fetchLatestVersion(fetchImpl)
          state.openboxLastAt = now.toISOString()
          if (compareVersions(latest, meta.version) > 0) {
            // 探到的版本号交给升级脚本:它按带版本号的资产下载、解包后核对版本。不传的话脚本自己再探一次,
            // 国内直连不通时拿不到,就退回会动的 releases/latest/download,镜像缓存的旧包也照装(审查第六项)
            const r = await startUpdate(ctx, paths, ob.channel || 'auto', { expect: latest })
            log(`[schedule] open-box update ${meta.version} -> ${latest}: ${r.ok ? 'started' : r.output}`)
          } else {
            log(`[schedule] open-box up to date (${meta.version})`)
          }
        }
      } catch (err) {
        log(`[schedule] open-box update check failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  // 订阅定期更新:每条订阅自己的「每隔几天、几点」或「每隔几小时」(api/subscriptions.mjs 的 autoUpdate)。
  // 按天的和上面自身升级同一套算法:到点、今天没做过、离上次够了 N 天才拉;按小时的只看离上次够不够。拉完节点真变了就在线
  // 换进内核(api/hot-apply.mjs),不重启(用户 2026-09-30:更新订阅节点不应该重启内核);换不进去的由右上角提示重启。
  if (typeof store.getSubscriptions === 'function' && typeof store.getNodes === 'function') {
    const subs = store.getSubscriptions()
    const subState = state.subscriptions || {}
    // 删掉的订阅不留记录
    for (const id of Object.keys(subState)) if (!subs.some((s) => s.id === id)) { delete subState[id]; changed = true }
    let poolChanged = false
    for (const sub of subs) {
      // 停用的订阅不拉(GitHub #40)
      if (sub.enabled === false) continue
      const plan = sub.autoUpdate
      if (!plan || plan.enabled !== true) continue
      const st = subState[sub.id] || {}
      const hourly = plan.mode === 'hours'
      if (hourly) {
        // 每隔几小时:从上一次定时拉取算起;还没拉过就从订阅最近一次保存 / 手动更新算,刚添加的订阅
        // 不用马上再拉一遍。留 1 分钟余量,免得整点那个 tick 差几秒被判成没到
        const hours = Math.max(1, Number(plan.hours) || 6)
        const last = st.lastAt ? new Date(st.lastAt) : (sub.updatedAt ? new Date(sub.updatedAt) : null)
        if (last && now - last < hours * 3600 * 1000 - 60 * 1000) continue
      } else {
        if (Number(plan.hour) !== hour) continue
        if (st.day === today) continue
        const days = Math.max(1, Number(plan.days) || 1)
        const last = st.lastAt ? new Date(st.lastAt) : null
        const due = !last || now - last >= (days - 0.5) * 24 * 3600 * 1000
        subState[sub.id] = { ...st, day: today }
        changed = true
        if (!due) continue
      }
      const before = JSON.stringify(store.getNodes())
      try {
        const r = await refreshSubscriptionById(store, sub.id, { fetchImpl: subscriptionFetchImpl || fetchImpl, ...(lookup ? { lookup } : {}) })
        const nodesChanged = JSON.stringify(store.getNodes()) !== before
        if (nodesChanged) poolChanged = true
        subState[sub.id] = { day: today, lastAt: now.toISOString(), result: `ok:${r.nodeCount}` }
        log(`[schedule] subscription ${sub.name}: ${r.nodeCount} nodes, ${nodesChanged ? 'changed' : 'unchanged'}`)
      } catch (err) {
        // 按小时的失败也记这次时间:否则下一分钟就再拉,拉不通的机场会被每分钟敲一次
        subState[sub.id] = { day: today, lastAt: hourly ? now.toISOString() : st.lastAt, result: `error:${err instanceof Error ? err.message : err}` }
        log(`[schedule] subscription ${sub.name} failed: ${err instanceof Error ? err.message : err}`)
      }
      // 每拉完一条就落一次状态:几条订阅串行要跑一两分钟,中途面板重启(比如赶上自动升级)
      // 的话,拉过的不会在下一分钟再拉一遍、再多重启一次内核
      state.subscriptions = subState
      await writeJsonFile(ctx, paths.scheduleStatePath, state)
    }
    state.subscriptions = subState
    if (poolChanged && hotApplier && (await serviceStatus(ctx, paths.initd.core)).running) {
      const r = await hotApplier.runNow()
      log(`[schedule] subscriptions changed, ${r && r.ok ? `applied to the running core without restart (${r.changed || 0} outbounds)` : `not applied (${(r && (r.message || r.reason)) || 'unknown'}), restart the core to use them`}`)
    }
  }

  if (changed) await writeJsonFile(ctx, paths.scheduleStatePath, state)
}

export const startScheduler = (deps, { intervalMs = 60_000 } = {}) => {
  // 一次 tick 可能跑好几分钟(探版本、下规则集、重新部署),期间下一次 tick 看到的还是
  // 旧的 geoDay,会再跑一遍并发部署——上一轮没结束就跳过这一轮
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    runScheduledTasks(deps)
      .catch((err) => deps.log?.(`[schedule] ${err}`))
      .finally(() => { busy = false })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
