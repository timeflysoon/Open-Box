// 面板内存自检。V8 的堆上限由 init 脚本的 --max-old-space-size 管(openwrt/initd/openbox-panel);这里管的是
// 整个进程的常驻内存(RSS):堆以外的 Buffer、sqlite、原生内存也算在里面,init 脚本是老版本、没带堆上限的安装也靠它。
// 连续几次超过上限就平滑退出,procd 立刻拉起新进程(respawn)——比等系统内存耗尽、整机抖动几分钟后被 OOM killer
// 挑中要好(2026-09-17 正式路由器:1 GB 内存的虚拟机,面板涨到 337 MB,整机卡死 5 分钟,LuCI 和转发都停了)。
// 正在部署 / 停止 / 回滚 / 升级时不重启:那些动作改到一半断掉比多占一会儿内存糟得多,等它们结束下一轮再说。
// 刚启动不到 10 分钟就超限的也不重启:那说明上限设得比正常水位还低、或者有别的毛病,重启只会变成每几分钟一次的
// 死循环——只记日志,留给人看。
export const DEFAULT_RSS_LIMIT_MB = 300
const MIN_LIMIT_MB = 120

// 上限:环境变量 OPENBOX_PANEL_RSS_LIMIT_MB 优先;否则按 init 脚本给的堆上限(OPENBOX_PANEL_HEAP_MB)加 140 MB
// (Node 运行时本身、新生代、代码、Buffer 的余量);都没有就 300 MB
export const rssLimitMb = (env = process.env) => {
  const explicit = Number(env.OPENBOX_PANEL_RSS_LIMIT_MB)
  if (Number.isFinite(explicit) && explicit >= MIN_LIMIT_MB) return Math.round(explicit)
  const heap = Number(env.OPENBOX_PANEL_HEAP_MB)
  if (Number.isFinite(heap) && heap > 0) return Math.max(MIN_LIMIT_MB, Math.round(heap + 140))
  return DEFAULT_RSS_LIMIT_MB
}

export const createMemoryWatchdog = ({
  limitMb = rssLimitMb(), checks = 3, intervalMs = 60_000, minUptimeSeconds = 600, trendEvery = 30,
  memoryUsage = () => process.memoryUsage(), uptime = () => process.uptime(), isBusy = async () => false, onExceed = async () => {},
  log = (m) => console.log(m), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
} = {}) => {
  let over = 0
  let fired = false
  let timer = null
  let ticking = false
  let ticks = 0
  const tick = async () => {
    if (fired || ticking) return { fired }
    ticking = true
    try {
      const usage = memoryUsage()
      const rssMb = usage.rss / 1048576
      // 每半小时记一行走势:常驻 / V8 堆 / 堆外(Buffer、ws 攒的帧、sqlite),事后好分清涨的是哪一块
      if (++ticks % trendEvery === 0) {
        const mb = (n) => Math.round((n || 0) / 1048576)
        log(`[memory] 面板常驻 ${mb(usage.rss)} MB,V8 堆 ${mb(usage.heapUsed)} / ${mb(usage.heapTotal)} MB,堆外 ${mb(usage.external)} MB（其中 ArrayBuffer ${mb(usage.arrayBuffers)} MB）`)
      }
      if (rssMb <= limitMb) { over = 0; return { rssMb, over, fired } }
      over += 1
      log(`[memory] 面板常驻内存 ${rssMb.toFixed(0)} MB,超过上限 ${limitMb} MB(连续第 ${over} 次,满 ${checks} 次自动重启面板)`)
      if (over < checks) return { rssMb, over, fired }
      if (uptime() < minUptimeSeconds) {
        log(`[memory] 面板启动才 ${Math.round(uptime())} 秒就超限,不自动重启（避免反复重启）;请检查上限设置或导出诊断包`)
        return { rssMb, over, fired, tooYoung: true }
      }
      if (await isBusy()) {
        log('[memory] 正在部署 / 升级,等它结束再重启面板')
        return { rssMb, over, fired, busy: true }
      }
      fired = true
      await onExceed({ rssMb, limitMb })
      return { rssMb, over, fired }
    } finally {
      ticking = false
    }
  }
  return {
    limitMb,
    tick,
    start() {
      if (timer) return
      timer = setIntervalImpl(() => { tick().catch((err) => log(`[memory] 自检出错:${err instanceof Error ? err.message : err}`)) }, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearIntervalImpl(timer)
      timer = null
    },
  }
}

// 自检触发的重启留一份记录(最近 10 次):syslog 缓冲在流量大的路由器上几分钟就被冲掉,事后要查得有地方看
export const recordWatchdogRestart = async (ctx, path, event, { keep = 10 } = {}) => {
  let list = []
  try { list = JSON.parse(await ctx.readFile(path)) } catch { list = [] }
  if (!Array.isArray(list)) list = []
  list.push(event)
  await ctx.writeFile(path, `${JSON.stringify(list.slice(-keep), null, 2)}\n`)
}
