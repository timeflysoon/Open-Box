// 面板发给内核的测速共用的一份名额(GitHub #514)。
//
// 内核(1.14.1-openbox-tcp14 起)全内核测速最多 4 个同时测、相邻两次开始隔 0.25 秒,分三档:critical(保流量:复查)、
// interactive(有人在等:手动测速、故障转移的例行检测)、background(定时测速),后台最多占 3 个。面板这边以前各模块自己发:
// 故障转移每个组 4 个并发、定时测速一次一个组整批,13 个故障转移组同时到点就是 52 个请求挤在内核队里,排不上的等到本地
// 期限被掐断、记成「未知」,组测速被掐断还把内核那一批后面的成员一起停掉。
//
// 现在先在面板排队:同一时刻最多 limit 个请求在内核那边(和内核的名额一样多),排队不算请求自己的超时(拿到名额才开始发、
// 才开始计时)。空出来的名额先给 critical;interactive 和 background 都有人等时,background 至少拿到 1 个(定时测速管着 DNS
// 自动组这些,不能被故障转移的例行检测饿死)、最多占一半(内核刚启动时自己会把所有组自测一遍,面板的后台请求在内核队里
// 跟着等,占多了故障转移就只剩一个名额);同一档先来先测。还在排队的可以取消(组的轮次作废、刷新);已经发出去的不取消——
// 内核的单节点测速不跟着请求断,测完照样记结果,面板这边提前放掉名额只会让内核那边超额。
export const PROBE_PRIORITIES = ['critical', 'interactive', 'background']
const RANK = { critical: 0, interactive: 1, background: 2 }
const rankOf = (priority) => (priority in RANK ? RANK[priority] : RANK.interactive)

// 吞吐按最近这么长时间里测完的个数算(给「测速需求超过内核能力」的提示用)
const THROUGHPUT_WINDOW_MS = 10 * 60_000

export const createProbeLimiter = ({ limit = 4, now = () => Date.now() } = {}) => {
  const slots = Math.max(1, Math.floor(Number(limit)) || 4)
  const backgroundMax = Math.max(1, Math.floor(slots / 2))
  const queues = [[], [], []]
  let running = 0
  let runningBackground = 0
  const finished = [] // 测完的时刻(吞吐窗口)

  const canStart = (rank) => running < slots && (rank !== RANK.background || runningBackground < backgroundMax)
  const start = (job) => {
    job.queued = false
    running += 1
    job.background = job.rank === RANK.background
    if (job.background) runningBackground += 1
    job.startedAt = now()
    job.grant()
  }
  // 空出来的名额怎么分:critical 先;interactive 和 background 都在等、而 background 一个都没在跑时先给它一个;其余按档
  const dispatch = () => {
    while (running < slots) {
      let job = null
      if (queues[RANK.critical].length) job = queues[RANK.critical].shift()
      else if (queues[RANK.background].length && runningBackground === 0) job = queues[RANK.background].shift()
      else if (queues[RANK.interactive].length) job = queues[RANK.interactive].shift()
      else if (queues[RANK.background].length && canStart(RANK.background)) job = queues[RANK.background].shift()
      if (!job) break
      start(job)
    }
  }
  const release = (job) => {
    if (job.released) return
    job.released = true
    running -= 1
    if (job.background) runningBackground -= 1
    const t = now()
    finished.push(t)
    while (finished.length && t - finished[0] > THROUGHPUT_WINDOW_MS) finished.shift()
    dispatch()
  }
  const removeQueued = (job) => {
    const q = queues[job.rank]
    const i = q.indexOf(job)
    if (i !== -1) q.splice(i, 1)
  }

  // 排一个测速:fn 拿到名额才调用(它自己管请求的超时)。返回 { result, bump, queued }:result 是 fn 的结果;
  // bump(priority) 把还在排队的挪到更高一档(更急的调用方加入了同一个节点的测速)。signal 中止时还在排队的直接退出,
  // result 以 { cancelled: true } 拒绝(调用方自己决定怎么记);已经开始的照常跑完
  const schedule = (priority, fn, { signal } = {}) => {
    const job = { rank: rankOf(priority), queued: true, released: false, background: false, startedAt: 0, grant: null }
    let onAbort = null
    const granted = new Promise((resolve, reject) => {
      job.grant = resolve
      if (signal) {
        onAbort = () => {
          if (!job.queued) return
          job.queued = false
          removeQueued(job)
          reject(Object.assign(new Error('cancelled'), { cancelled: true }))
        }
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    if (!signal || !signal.aborted) {
      // 前面没人排着(同档或更急的)而且有空位就直接开始,不然进队
      const waitingAhead = queues.slice(0, job.rank + 1).some((q) => q.length)
      if (!waitingAhead && canStart(job.rank)) start(job)
      else queues[job.rank].push(job)
    }
    const result = granted.then(async () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      try { return await fn() } finally { release(job) }
    })
    const bump = (next) => {
      const rank = rankOf(next)
      if (!job.queued || rank >= job.rank) return
      removeQueued(job)
      job.rank = rank
      queues[rank].push(job)
      dispatch()
    }
    return { result, bump, queued: () => job.queued }
  }
  const run = (priority, fn, opts) => schedule(priority, fn, opts).result

  const stats = () => ({
    limit: slots, running,
    critical: queues[RANK.critical].length, interactive: queues[RANK.interactive].length, background: queues[RANK.background].length,
  })
  // 最近 10 分钟每秒测完几个(刚启动不到 1 分钟、或者窗口里没测过的给 null:样本太少不下结论)
  const throughput = () => {
    const t = now()
    while (finished.length && t - finished[0] > THROUGHPUT_WINDOW_MS) finished.shift()
    if (!finished.length) return null
    const span = Math.max(t - finished[0], 1)
    return span < 60_000 ? null : finished.length / (span / 1000)
  }
  return { schedule, run, stats, throughput, limit: slots }
}
