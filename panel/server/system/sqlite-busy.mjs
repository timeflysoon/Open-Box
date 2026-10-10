// 两个进程开同一个 sqlite 时的写锁冲突(GitHub #535:升级后起内核的 cli/deploy.mjs 和刚启动的面板同时写库)。
// DatabaseSync 的 timeout 是 sqlite 自己的等锁时长;但 sqlite 判断等下去会死锁时不等、直接回 BUSY,
// 所以在它外面再按间隔重试到同一个期限。node:sqlite 是同步接口,中间用 Atomics.wait 停一下
// SQLITE_BUSY = 5、SQLITE_LOCKED = 6(扩展码的低 8 位)
export const isSqliteBusy = (err) =>
  [5, 6].includes(Number(err?.errcode) & 0xff) || /database (table )?is locked/i.test(String(err?.message ?? ''))

const pause = new Int32Array(new SharedArrayBuffer(4))
const sleepSync = (ms) => { Atomics.wait(pause, 0, 0, ms) }

export const retryBusy = (fn, { waitMs = 60_000, intervalMs = 200, now = Date.now, sleep = sleepSync } = {}) => (...args) => {
  const deadline = now() + waitMs
  for (;;) {
    try {
      return fn(...args)
    } catch (err) {
      if (!isSqliteBusy(err) || now() >= deadline) throw err
      sleep(intervalMs)
    }
  }
}
