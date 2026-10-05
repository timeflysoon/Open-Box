// 订阅定期更新:计划的形状和「这一刻该不该拉」。路由器(system/scheduler.mjs)和 App 本地分流(client-engine 的 due / settle,
// PM 2026-10-04:手机按订阅的计划自己刷新,按手机本地时间)共用这一份。时钟由调用方给,这里不读。

// 定期更新,两种写法(system/scheduler.mjs 到点来做),关掉或不合法就是 null:
//   · { enabled, days(1~30), hour(0~23) }——每隔几天、几点重新拉一次,和后端设置里自身升级的计划一致;
//   · { enabled, mode: 'hours', hours(1~23) }——每隔几小时拉一次,从上一次拉取算起(GitHub #14:
//     CF 优选这类订阅一天要换几次 IP,按天太慢)。
export const normalizeAutoUpdate = (raw) => {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null
  if (raw.mode === 'hours') {
    const hours = Math.min(23, Math.max(1, Math.round(Number(raw.hours)) || 6))
    return { enabled: true, mode: 'hours', hours }
  }
  const days = Math.min(30, Math.max(1, Math.round(Number(raw.days)) || 1))
  const hour = Math.min(23, Math.max(0, Math.round(Number(raw.hour)) || 0))
  return { enabled: true, days, hour }
}


const DAY_MS = 24 * 3600 * 1000
const HOUR_MS = 3600 * 1000
// 上次拉取的时间:毫秒数或 ISO 字符串(路由器的状态文件存的是 ISO);没有就是 null,写坏了是 NaN(和 new Date(坏值) 一样判)
const toMs = (value) => (value === undefined || value === null || value === '' ? null : typeof value === 'number' ? value : Date.parse(String(value)))

// 这一刻该不该拉。按天的:到点(hour 是本地小时)、今天没看过(lastDay)、离上次够了 N 天才拉;按小时的只看离上次够不够——
// 还没定时拉过就从订阅最近一次保存 / 手动更新(updatedAt)算,刚添加的订阅不用马上再拉一遍;留 1 分钟余量,免得整点那个 tick 差几秒被判成没到。
// 回 { due, lastDay }:按天的到点了不管拉不拉都把 lastDay 记成今天(今天不再看)
export const subscriptionDue = ({ plan, enabled, updatedAt, lastAt, lastDay, now, hour, today }) => {
  // 停用的订阅不拉(GitHub #40)
  if (enabled === false || !plan || plan.enabled !== true) return { due: false, lastDay }
  const last = toMs(lastAt)
  if (plan.mode === 'hours') {
    const hours = Math.max(1, Number(plan.hours) || 6)
    const since = last !== null ? last : (updatedAt ? Number(updatedAt) : null)
    return { due: !(since !== null && now - since < hours * HOUR_MS - 60 * 1000), lastDay }
  }
  if (Number(plan.hour) !== hour || lastDay === today) return { due: false, lastDay }
  const days = Math.max(1, Number(plan.days) || 1)
  return { due: last === null || now - last >= (days - 0.5) * DAY_MS, lastDay: today }
}

// 拉完之后记什么:成功记这次时间;按小时的失败也记(否则下一分钟就再拉,拉不通的机场会被每分钟敲一次),按天的失败不动
export const subscriptionSettled = ({ plan, ok, lastAt, now, today }) => ({
  lastDay: today,
  lastAt: ok || (plan && plan.mode === 'hours') ? now : lastAt,
})
