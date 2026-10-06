// 别的代理工具和 Open-Box 内核同时在跑 → 自动停掉 Open-Box 内核(用户 2026-10-05:同一台路由器上不能同时运行两个
// 代理工具,检测到就禁止启动;同时在跑就自动停)。部署流程和 init 脚本只管「起」的那一刻;开机时 Open-Box(S99openbox)
// 排在 PassWall(S99passwall,它还有自己的启动延时)前面,那时看不到它,两个就一起跑起来了(GitHub #426 的假启动)。
//
// 连续两次都看到才停:插件的界面 / 定时任务偶尔会临时跑一下它目录下的程序。停用的是和面板「停止」按钮同一条路
// (api/service.mjs 的 stopKernel:同一个队列、同一把锁,关开机自启——不然下次开机又是先起、再被停)。停了把部署状态
// 记成 conflict + autoStopped,右上角提示说清是自动停的;用户停掉那个工具后点启动,部署结果会把这条记录盖掉
import { autoStopMessage, detectRunningByProcess } from './conflicts.mjs'
import { serviceStatus } from './service.mjs'

export const CONFLICT_HITS_TO_STOP = 2

// guard:跨次检查的计数({ hits });stop:停内核,回 { ok, code, stderr }
export const checkConflictGuard = async ({ store, ctx, paths, stop, guard, log = () => {} }) => {
  const conflicts = await detectRunningByProcess(ctx)
  if (!conflicts.length || !(await serviceStatus(ctx, paths.initd.core)).running) {
    guard.hits = 0
    return { stopped: false, conflicts }
  }
  guard.hits += 1
  if (guard.hits < CONFLICT_HITS_TO_STOP) return { stopped: false, conflicts }
  guard.hits = 0
  const message = autoStopMessage(conflicts)
  const r = await stop()
  if (!r.ok) {
    // 没停成(内核到点没退出之类):下两次检查还在就再试
    log(`[conflict] ${conflicts.map((c) => c.label).join('、')} 和 Open-Box 同时在运行,自动停止内核没成功:${r.stderr || r.code}`)
    return { stopped: false, conflicts, error: r.stderr || String(r.code) }
  }
  store.setDeployState({ stage: 'conflict', message, at: Date.now(), badTags: [], autoStopped: true })
  log(`[conflict] ${message}`)
  return { stopped: true, conflicts }
}

export const startConflictGuard = (deps, { intervalMs = 20_000 } = {}) => {
  const guard = { hits: 0 }
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    checkConflictGuard({ ...deps, guard })
      .catch((err) => deps.log?.(`[conflict] ${err}`))
      .finally(() => { busy = false })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
