import express from 'express'
import { filterKey, filterSettings, validateDnsFilter } from '../engine/dns-filter.mjs'
import { cleanupDnsFilterCache, prepareDnsFilter, readFilterListState } from '../system/dns-filter.mjs'
import { runDeploy, runExclusive } from './deploy-runner.mjs'
import { createDnsFilterPreview } from '../system/dns-filter-preview.mjs'
import { labelClients } from './traffic.mjs'

export const registerDnsFilterRoutes = (app, { store, ctx, paths, data, observer, deploy = runDeploy, previewFetch }) => {
  const router = express.Router()
  const preview = createDnsFilterPreview({ store, ctx, fetchImpl: previewFetch })
  router.use(express.json({ limit: '128kb' }))
  let busy = false
  const status = async () => {
    let applied = null
    // queryLog:dnsmasq 转发模式下认终端用的 dnsmasq 查询日志开没开(system/dnsmasq-query-log.mjs);reason 'user' = 用户自己设了 dnsmasq 日志,没接管
    let queryLog = null
    try {
      const meta = JSON.parse(await ctx.readFile(`${paths.etc}/config.meta.json`))
      applied = meta.dnsFilter || null
      queryLog = meta.dnsmasqQueryLog || null
    } catch { /* not deployed */ }
    const settings = filterSettings(store.getProfile())
    return { settings, lists: readFilterListState(store), applied, queryLog, pending: applied ? applied.key !== filterKey(settings) : settings.enabled, busy, ...observer.status() }
  }
  router.get('/', async (_req, res) => res.json(await status()))
  router.put('/', (req, res) => {
    if (busy) return res.status(409).json({ error: '名单正在更新,请稍后保存' })
    const settings = req.body
    const error = validateDnsFilter(settings)
    if (error) return res.status(400).json({ error })
    store.setProfile({ dns: { filter: settings } })
    res.json({ settings: filterSettings(store.getProfile()) })
  })
  // force(更新名单):只重新下载、编译名单。集合的文件名固定,内容换了内核自己重新加载,不重启内核(system/dns-filter.mjs;
  // 用户 2026-09-30:没必要重启内核的都不重启)。名单份数变了(条目数跨过一份 2.5 万条的边界)、设置改了还没生效,才要重启,
  // 由右上角的统一提示说。不带 force 是「应用设置」= 重启内核(界面上已经不用了,留给接口调用方)
  const apply = async (force, listId = '') => {
    if (busy) throw new Error('DNS 设置正在应用,请稍后重试')
    busy = true
    try {
      if (force) {
        await runExclusive(store, () => prepareDnsFilter({ store, ctx, paths, force: listId || true }))
        await runExclusive(store, () => cleanupDnsFilterCache({ store, ctx, paths })).catch(() => {})
        await observer.tick()
        return { ok: true, stage: 'updated', message: '' }
      }
      const result = await deploy({ store, ctx, paths })
      if (!result.ok) throw new Error(result.message || 'DNS 设置应用失败')
      await runExclusive(store, () => cleanupDnsFilterCache({ store, ctx, paths })).catch(() => {})
      await observer.tick()
      return result
    } finally { busy = false }
  }
  router.post('/apply', async (req, res) => {
    const listId = typeof req.body?.listId === 'string' ? req.body.listId.trim() : ''
    if (listId && !filterSettings(store.getProfile()).lists.some((l) => l.id === listId && l.enabled)) return res.status(400).json({ error: '只能更新已启用的过滤名单' })
    try { res.json({ result: await apply(req.body?.update === true, listId), ...await status() }) }
    catch (error) { res.status(400).json({ error: error.message }) }
  })
  router.get('/summary', (_req, res) => res.json({ enabled: filterSettings(store.getProfile()).enabled, ...observer.status(), ...data.summary() }))
  // 终端设备一栏:按来源 IP 补 DHCP 主机名、标出路由器自己的地址(和流量表的终端同一套)
  router.get('/records', async (req, res) => {
    const out = data.records(req.query)
    res.json({ ...out, rows: await labelClients(ctx, paths, out.rows, 'source') })
  })
  router.get('/preview', async (req, res) => {
    try { res.json(await preview(req.query)) }
    catch (error) { res.status(400).json({ error: error.message }) }
  })
  app.use('/api/openbox/dns-filter', router)
  // 名单自动更新和 Open-Box / Geo 使用同一套计划算法:到点、今天只处理一次、按间隔天数判断。
  // 状态写入统一的 schedule-state.json,面板重启后不会重复下载;失败保留上次有效名单。
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  return {
    updateIfDue: async () => {
      if (busy) return
      const settings = filterSettings(store.getProfile())
      const plan = settings.autoUpdate || {}
      if (!settings.enabled || plan.enabled !== true) return
      const now = new Date()
      if (Number(plan.hour) !== now.getHours()) return
      let schedule
      const schedulePath = paths.dnsFilterScheduleStatePath || paths.scheduleStatePath
      try { schedule = JSON.parse(await ctx.readFile(schedulePath)) || {} } catch { schedule = {} }
      const today = dayKey(now)
      if (schedule.dnsFilterDay === today) return
      schedule.dnsFilterDay = today
      const days = Math.max(1, Number(plan.days) || 1)
      const last = schedule.dnsFilterLastAt ? new Date(schedule.dnsFilterLastAt) : null
      const due = !last || now - last >= (days - 0.5) * 24 * 3600 * 1000
      try { await ctx.writeFile(schedulePath, JSON.stringify(schedule, null, 2)) } catch { /* next tick can retry */ }
      if (!due) return
      const current = await status()
      if (current.pending || !current.applied?.enabled) return
      schedule.dnsFilterLastAt = now.toISOString()
      try { await ctx.writeFile(schedulePath, JSON.stringify(schedule, null, 2)) } catch { /* update still runs */ }
      await apply(true)
    },
  }
}
