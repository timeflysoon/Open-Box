// 每日流量采集。
//
// sing-box 自己不存历史流量:clash API 只有"当前连接表"(/connections,每条连接带累计
// upload/download)和两个自内核启动以来的总计数(uploadTotal/downloadTotal)。要画"每日
// 流量"并且能下钻到节点、域名,面板得自己常驻采样:每 intervalMs 读一次连接表,和上一次
// 比出增量,按"当天 / 节点 / 域名或 IP"三个维度累加,攒够 flushMs 一次写进 sqlite。
//
// 精度说明(前端"未采样到的短连接"那一行就是这么来的):
// - 当天总量用内核的 uploadTotal/downloadTotal 增量,再减去采样到的 dnsmasq 回环部分
//   (见下面 applySnapshot 里的说明);
// - 节点/域名的分量只能从连接表逐条比增量,存活不到一个采样周期的连接根本看不见,
//   连接关闭前最后不到一个周期的字节也会丢。总量 − 各节点之和 = 这部分误差。
//
// 方向:clash API 的 upload = 发往外网的字节(出口),download = 从外网收到的(入口)。
// 库里和接口里一律叫 up/down,前端再翻成 入口/出口。

import { DNSMASQ_OUTBOUND_TAG } from '../engine/config.mjs'

const pad2 = (n) => String(n).padStart(2, '0')

// 分析数据保留时长(月):默认半年,允许 1~36
export const DEFAULT_KEEP_MONTHS = 3
export const MIN_KEEP_MONTHS = 1
export const MAX_KEEP_MONTHS = 36
export const normalizeKeepMonths = (v) => {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return DEFAULT_KEEP_MONTHS
  return Math.min(MAX_KEEP_MONTHS, Math.max(MIN_KEEP_MONTHS, n))
}

// 都按面板进程的本地时间算天:路由器上 TZ 跟 OpenWrt 系统一致,前端拿服务端给的 today 做高亮,
// 不自己算,免得浏览器和路由器时区不一样。
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
// 小时明细:同一份增量除了按天记一份,还按「天@小时」再记一份(day 列写成 2026-09-05@17),
// 按天的查询、下钻、清理全部照用;只有 total 不写这种行——月视图按 kind='total' 扫日期范围,
// 不能混进来,小时的总量在 kind='hour' 那一行。这种行占空间(一天几万行),只保留最近几天。
export const HOUR_DETAIL_KEEP_DAYS = 7
export const hourDayKey = (day, hour) => `${day}@${pad2(hour)}`

// 老数据合并长尾。按天的行里九成以上是「按访问目标拆」的三张表(host、client_host、node_host),一天一万多行,
// 而流量集中在很少的目标上:正式路由器实测,一天四千多个目标里前 300 个占了 96% ~ 98% 的流量。保留时长设得
// 长(比如 12 个月)时这张表会涨到几百 MB。所以超过 TAIL_COLLAPSE_AFTER_DAYS 天的日子只留当天流量最大的
// TAIL_KEEP_HOSTS 个访问目标,其余并成一行 TAIL_OTHER_KEY(交叉表里按前一维各并一行),一天一万六千行 → 不到两千行。
// 三张表用**同一份**保留名单:留下的目标在三张表里都原样在,「其他」在三张表里是同一批目标的和——概览关掉
// 「统计直连流量」时拿一维列表减交叉行、点开一条看构成,算出来的数仍然对得上。总量、终端、节点、终端×节点、
// 24 小时曲线这些行不动。键用 ~ 开头:访问目标只会是小写域名或 IP,撞不上
export const TAIL_COLLAPSE_AFTER_DAYS = 30
export const TAIL_KEEP_HOSTS = 300
export const TAIL_OTHER_KEY = '~other'
const TAIL_PAIR_KINDS = ['client_host', 'node_host']

// sing-box 的 chains 是 [末端节点, ..., 顶层策略](和 clash 一样,tracker 里 Reverse 过)
export const leafOf = (chains) => (Array.isArray(chains) && chains.length ? String(chains[0] ?? '') : '')

// 「组」偶尔会以 chains[0] 的身份出现:内核的连接跟踪是顺着 group.Now() 往下找末端的,自动测速组(urltest,
// 含故障转移页签的内部子组 __fo:…)刚重选、还没有选中项时 Now() 为空,链就停在组上,而实际拨号用的是组里第一个
// 可用节点。这种键落进流量表就成了「新加坡-自动」「__fo:g-…:lane-…」这样的节点名(正式路由器实测每小时都有
// 几条)。补救:采集时拿此刻 /proxies 里该组的选中项(没有就取成员表第一个)当节点,层层下钻到不是组为止;
// 解不开就原样留着,前端再按同样的规则显示
export const FAILOVER_INTERNAL_PREFIX = '__fo:'
const isGroupEntry = (p) => Boolean(p && Array.isArray(p.all))
export const resolveLeaf = (chains, proxies) => {
  let leaf = leafOf(chains)
  const seen = new Set()
  while (proxies && isGroupEntry(proxies[leaf]) && !seen.has(leaf)) {
    seen.add(leaf)
    const p = proxies[leaf]
    const next = typeof p.now === 'string' && p.now ? p.now : (p.all.length ? String(p.all[0]) : '')
    if (!next || next === leaf) break
    leaf = next
  }
  return leaf
}

// 访问终端:局域网里发起连接的设备,按来源 IP 记
export const clientOf = (metadata) => {
  const m = metadata && typeof metadata === 'object' ? metadata : {}
  return String(m.sourceIP || '').trim()
}

// 有域名(SNI / HTTP Host / 反查)就记域名,没有就记目标 IP
export const hostOf = (metadata) => {
  const m = metadata && typeof metadata === 'object' ? metadata : {}
  const host = String(m.host || '').trim().toLowerCase()
  return host || String(m.destinationIP || '').trim()
}

const toInt = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

const nextMonthOf = (month) => {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${pad2(m + 1)}`
}

// 两维交叉的明细:kind 是 client_host | client_node | node_host,key 是「前一维\t后一维」。
// 面板里点开一条终端/节点/访问目标,就按这三张交叉表查它由什么构成。
export const PAIR_SEP = '\t'
const PAIR_KINDS = {
  client: { host: ['client_host', 0], node: ['client_node', 0] },
  node: { client: ['client_node', 1], host: ['node_host', 0] },
  host: { client: ['client_host', 1], node: ['node_host', 1] },
}
// 给定「我是哪一维、要按哪一维拆」,返回交叉表的 kind 和我在 key 里的位置(0 前 1 后)
export const pairKindFor = (kind, by) => (PAIR_KINDS[kind] && PAIR_KINDS[kind][by]) || null
export const PAIR_KIND_NAMES = ['client_host', 'client_node', 'node_host']

// sqlite 落地。表按 (day, kind, key) 唯一,kind ∈ total | node | host | client | 上面三种交叉,total 的 key 是空串。
// 写入全是"加上增量"的 upsert,所以内存里只用攒增量,不用记绝对值。
// node:sqlite 查出来的是无原型对象,整理成普通对象再往外交(deepEqual、JSON 都省心)
const plain = (row) => ({ ...row })

export const createTrafficStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS traffic_daily (
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      up INTEGER NOT NULL DEFAULT 0,
      down INTEGER NOT NULL DEFAULT 0,
      conns INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, kind, key)
    ) WITHOUT ROWID
  `)
  const upsert = db.prepare(`
    INSERT INTO traffic_daily (day, kind, key, up, down, conns) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, kind, key) DO UPDATE SET
      up = up + excluded.up,
      down = down + excluded.down,
      conns = conns + excluded.conns
  `)
  const selectMonth = db.prepare(`
    SELECT day, up, down, conns FROM traffic_daily
    WHERE kind = 'total' AND day >= ? AND day < ? ORDER BY day
  `)
  const selectTotal = db.prepare(`SELECT up, down, conns FROM traffic_daily WHERE kind = 'total' AND day = ?`)
  const selectRow = db.prepare(`SELECT up, down, conns FROM traffic_daily WHERE day = ? AND kind = ? AND key = ?`)
  const selectKind = db.prepare(`
    SELECT key, up, down, conns FROM traffic_daily
    WHERE day = ? AND kind = ? ORDER BY (up + down) DESC, key LIMIT ?
  `)
  const sumKind = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(up), 0) AS up, COALESCE(SUM(down), 0) AS down
    FROM traffic_daily WHERE day = ? AND kind = ?
  `)
  // 交叉表按前一维查:key 以「x\t」开头,用主键范围扫(\n 是紧挨着 \t 的下一个字符)
  const selectPairHead = db.prepare(`
    SELECT substr(key, length(?1) + 2) AS key, up, down, conns FROM traffic_daily
    WHERE day = ?2 AND kind = ?3 AND key >= ?1 || char(9) AND key < ?1 || char(10)
    ORDER BY (up + down) DESC, key LIMIT ?4
  `)
  const countPairHead = db.prepare(`
    SELECT COUNT(*) AS n FROM traffic_daily
    WHERE day = ?2 AND kind = ?3 AND key >= ?1 || char(9) AND key < ?1 || char(10)
  `)
  // 按后一维查:key 以「\tx」结尾
  const selectPairTail = db.prepare(`
    SELECT substr(key, 1, length(key) - length(?1) - 1) AS key, up, down, conns FROM traffic_daily
    WHERE day = ?2 AND kind = ?3 AND substr(key, -length(?1) - 1) = char(9) || ?1
    ORDER BY (up + down) DESC, key LIMIT ?4
  `)
  const countPairTail = db.prepare(`
    SELECT COUNT(*) AS n FROM traffic_daily
    WHERE day = ?2 AND kind = ?3 AND substr(key, -length(?1) - 1) = char(9) || ?1
  `)
  // 构成的合计(不受 limit 影响):父行总量减它就是"没记到交叉表里的部分"
  const sumPairHead = db.prepare(`
    SELECT COALESCE(SUM(up), 0) AS up, COALESCE(SUM(down), 0) AS down FROM traffic_daily
    WHERE day = ?2 AND kind = ?3 AND key >= ?1 || char(9) AND key < ?1 || char(10)
  `)
  const sumPairTail = db.prepare(`
    SELECT COALESCE(SUM(up), 0) AS up, COALESCE(SUM(down), 0) AS down FROM traffic_daily
    WHERE day = ?2 AND kind = ?3 AND substr(key, -length(?1) - 1) = char(9) || ?1
  `)
  // 24 小时曲线:kind='hour',key 是两位小时,值是内核计数器在那个小时里的增量(和 total 同源)
  const selectHours = db.prepare(`SELECT key AS hour, up, down, conns FROM traffic_daily WHERE day = ? AND kind = 'hour' ORDER BY key`)
  // 某个出站(比如内置直连)按天 / 按月 / 按小时的量:概览「统计直连流量」关掉时从总量里扣掉它用。
  // 按月要跳过「天@小时」那些行(它们也是 kind='node'),不然重复计
  const selectNodeRow = db.prepare(`SELECT up, down, conns FROM traffic_daily WHERE day = ? AND kind = 'node' AND key = ?`)
  const selectMonthNode = db.prepare(`
    SELECT day, up, down, conns FROM traffic_daily
    WHERE kind = 'node' AND key = ? AND day >= ? AND day < ? AND instr(day, '@') = 0 ORDER BY day
  `)
  const selectNodeHours = db.prepare(`
    SELECT day, up, down, conns FROM traffic_daily
    WHERE kind = 'node' AND key = ? AND day >= ? || '@00' AND day <= ? || '@23'
  `)
  const deleteBefore = db.prepare(`DELETE FROM traffic_daily WHERE day < ?`)
  const countKind = db.prepare(`SELECT COUNT(*) AS n FROM traffic_daily WHERE day = ? AND kind = ?`)
  const selectKindAll = db.prepare(`SELECT key, up, down, conns FROM traffic_daily WHERE day = ? AND kind = ?`)
  const deleteRow = db.prepare(`DELETE FROM traffic_daily WHERE day = ? AND kind = ? AND key = ?`)
  // 某一天的小时明细行(day 是「那天@HH」)在主键上紧挨在那天后面:> '那天' 且 < '那天~'
  const deleteHourDetailOfDay = db.prepare(`DELETE FROM traffic_daily WHERE day > ?1 AND day < ?1 || '~'`)
  // 「天@小时」的明细行和按天的行混在一张表里:天数、最早 / 最新那天只数按天的行(不然每天 24 个小时
  // 桶都算一「天」,正式路由器装了 5 天显示「已存 101 天」);字节数按天 / 按小时分开给,小时明细只留
  // HOUR_DETAIL_KEEP_DAYS 天,估算存满要多大时不能按它的日增量乘整个保留时长
  const usageStat = db.prepare(`
    SELECT COUNT(*) AS rows,
           COUNT(DISTINCT CASE WHEN instr(day, '@') = 0 THEN day END) AS days,
           MIN(CASE WHEN instr(day, '@') = 0 THEN day END) AS oldestDay,
           MAX(CASE WHEN instr(day, '@') = 0 THEN day END) AS newestDay,
           COALESCE(SUM(CASE WHEN instr(day, '@') = 0 THEN LENGTH(key) + LENGTH(kind) + 40 ELSE 0 END), 0) AS dayBytes,
           COALESCE(SUM(CASE WHEN instr(day, '@') = 0 AND day < ?1 THEN LENGTH(key) + LENGTH(kind) + 40 ELSE 0 END), 0) AS oldBytes,
           COUNT(DISTINCT CASE WHEN instr(day, '@') = 0 AND day < ?1 THEN day END) AS oldDays,
           COALESCE(SUM(CASE WHEN instr(day, '@') > 0 THEN LENGTH(key) + LENGTH(kind) + 40 ELSE 0 END), 0) AS hourBytes,
           COUNT(DISTINCT CASE WHEN instr(day, '@') > 0 THEN substr(day, 1, 10) END) AS hourDays
    FROM traffic_daily
  `)

  return {
    row(day, kind, key) {
      const r = selectRow.get(day, kind, key)
      return r ? plain(r) : null
    },
    add(rows) {
      if (!rows.length) return
      db.exec('BEGIN')
      try {
        for (const r of rows) upsert.run(r.day, r.kind, r.key, r.up, r.down, r.conns)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    month(month) {
      return selectMonth.all(`${month}-01`, `${nextMonthOf(month)}-01`).map(plain)
    },
    dayTotal(day) {
      const r = selectTotal.get(day)
      return r ? plain(r) : null
    },
    // 某个出站这一天(或「天@小时」)的量,没有就 null
    nodeRow(day, key) {
      const r = selectNodeRow.get(day, key)
      return r ? plain(r) : null
    },
    // 某个出站整月每天的量(只有按天的行)
    monthNode(month, key) {
      return selectMonthNode.all(key, `${month}-01`, `${nextMonthOf(month)}-01`).map(plain)
    },
    // 某个出站这一天 24 个小时桶的量:Map<小时, {up, down, conns}>,没记录的小时没有键
    nodeHours(day, key) {
      return new Map(selectNodeHours.all(key, day, day).map((r) => [Number(String(r.day).slice(11)), { up: Number(r.up) || 0, down: Number(r.down) || 0, conns: Number(r.conns) || 0 }]))
    },
    // 一天 24 个小时桶,没记录的小时补 0
    hours(day) {
      const byHour = new Map(selectHours.all(day).map((r) => [Number(r.hour), r]))
      return Array.from({ length: 24 }, (_, hour) => {
        const r = byHour.get(hour)
        return { hour, up: r ? Number(r.up) || 0 : 0, down: r ? Number(r.down) || 0 : 0, conns: r ? Number(r.conns) || 0 : 0 }
      })
    },
    day(day, kind, limit) {
      return selectKind.all(day, kind, limit).map(plain)
    },
    daySum(day, kind) {
      const r = sumKind.get(day, kind)
      return r ? plain(r) : { n: 0, up: 0, down: 0 }
    },
    // 一条记录的构成:kind/key 是点开的那条,by 是要拆成哪一维
    drill(day, kind, key, by, limit) {
      const pair = pairKindFor(kind, by)
      if (!pair) return { rows: [], count: 0, sum: { up: 0, down: 0 } }
      const [pairKind, pos] = pair
      const select = pos === 0 ? selectPairHead : selectPairTail
      const count = pos === 0 ? countPairHead : countPairTail
      const sum = (pos === 0 ? sumPairHead : sumPairTail).get(key, day, pairKind) || {}
      return {
        rows: select.all(key, day, pairKind, limit).map(plain),
        count: Number((count.get(key, day, pairKind) || {}).n) || 0,
        sum: { up: Number(sum.up) || 0, down: Number(sum.down) || 0 },
      }
    },
    // 这一天要不要合并长尾:访问目标的行数超过「保留数 + 其他那一行」才要。主键范围内数行,很便宜
    needsCollapse(day, keep = TAIL_KEEP_HOSTS) {
      return (Number((countKind.get(day, 'host') || {}).n) || 0) > keep + 1
    },
    // 合并某一天的长尾(见文件头 TAIL_* 的说明),一天一个事务;返回删掉了多少行。重复跑没有副作用:
    // 合并过的日子行数不超标,直接返回 0;「其他」那行用累加的 upsert,中途加进来的新行再并一次也不会丢量
    collapseDay(day, keep = TAIL_KEEP_HOSTS) {
      const hosts = selectKindAll.all(day, 'host').filter((r) => r.key !== TAIL_OTHER_KEY)
      if (hosts.length <= keep) return 0
      hosts.sort((x, y) => (Number(y.up) + Number(y.down)) - (Number(x.up) + Number(x.down)) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
      const kept = new Set(hosts.slice(0, keep).map((r) => r.key))
      let removed = 0
      db.exec('BEGIN')
      try {
        const other = { up: 0, down: 0, conns: 0 }
        for (const r of hosts.slice(keep)) {
          other.up += Number(r.up) || 0; other.down += Number(r.down) || 0; other.conns += Number(r.conns) || 0
          deleteRow.run(day, 'host', r.key); removed++
        }
        upsert.run(day, 'host', TAIL_OTHER_KEY, other.up, other.down, other.conns)
        for (const kind of TAIL_PAIR_KINDS) {
          const merged = new Map()
          for (const r of selectKindAll.all(day, kind)) {
            const i = r.key.lastIndexOf(PAIR_SEP)
            const host = r.key.slice(i + 1)
            if (i < 0 || host === TAIL_OTHER_KEY || kept.has(host)) continue
            const head = r.key.slice(0, i)
            const m = merged.get(head) || { up: 0, down: 0, conns: 0 }
            m.up += Number(r.up) || 0; m.down += Number(r.down) || 0; m.conns += Number(r.conns) || 0
            merged.set(head, m)
            deleteRow.run(day, kind, r.key); removed++
          }
          for (const [head, m] of merged) upsert.run(day, kind, `${head}${PAIR_SEP}${TAIL_OTHER_KEY}`, m.up, m.down, m.conns)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return removed
    },
    prune(beforeDay) {
      deleteBefore.run(beforeDay)
    },
    pruneBatch(beforeDay, hourDays) {
      db.exec('BEGIN')
      try {
        deleteBefore.run(beforeDay)
        for (const day of hourDays) deleteHourDetailOfDay.run(day)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    // 删掉某一天的小时明细(按天的那份不动)
    pruneHourDetail(day) {
      deleteHourDetailOfDay.run(day)
    },
    // 「分析数据保留时长」那张卡片要显示的东西:存了多少天、多少行、大概占多大。
    // 字节数是估的:键本身的长度 + 每行 40 字节(日期、三个整数、页内开销)。和把某一天
    // 的行复制进空库量出来的实际占用对得上(实测差 5% 以内)。days / oldestDay / newestDay
    // 只看按天的行;dayBytes / hourBytes 分别是按天的行和「天@小时」明细行的占用,hourDays
    // 是有小时明细的天数
    // collapseBefore:早于这一天的日子合并过长尾(行少得多),估「存满要多大」时要分开算;不传就当没有
    usage(collapseBefore = '') {
      const r = usageStat.get(collapseBefore) || {}
      const rows = Number(r.rows) || 0
      const dayBytes = Number(r.dayBytes) || 0
      const hourBytes = Number(r.hourBytes) || 0
      return {
        rows,
        days: Number(r.days) || 0,
        oldestDay: r.oldestDay || '',
        newestDay: r.newestDay || '',
        bytes: dayBytes + hourBytes,
        dayBytes,
        hourBytes,
        hourDays: Number(r.hourDays) || 0,
        oldBytes: Number(r.oldBytes) || 0,
        oldDays: Number(r.oldDays) || 0,
      }
    },
  }
}

// 查询在已落盘的数据上叠加内存增量。打开统计页不应触发同步磁盘提交(#77)。
// 有增量的旧行可能从排行末尾升到前面，因此补读这些主键后再排序、截取，不能只合并前 N 行。
export const createTrafficReadStore = (store, getPending) => {
  const add = (a, b) => ({ up: (a?.up || 0) + b.up, down: (a?.down || 0) + b.down, conns: (a?.conns || 0) + b.conns })
  const pending = (day, kind) => getPending().filter((r) => r.day === day && r.kind === kind)
  const ranked = (rows, limit) => rows.sort((a, b) => (b.up + b.down) - (a.up + a.down) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, limit)
  const mergeDays = (rows, extra) => {
    const map = new Map(rows.map((r) => [r.day, r]))
    for (const r of extra) map.set(r.day, { day: r.day, ...add(map.get(r.day), r) })
    return [...map.values()].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0)
  }
  const scalar = (day, kind, key, base) => {
    const r = pending(day, kind).find((r) => r.key === key)
    return r ? add(base, r) : base
  }
  return {
    ...store,
    dayTotal: (day) => scalar(day, 'total', '', store.dayTotal(day)),
    nodeRow: (day, key) => scalar(day, 'node', key, store.nodeRow(day, key)),
    month: (month) => mergeDays(store.month(month), getPending().filter((r) => r.kind === 'total' && r.day.startsWith(`${month}-`) && r.day.length === 10)),
    monthNode: (month, key) => mergeDays(store.monthNode(month, key), getPending().filter((r) => r.kind === 'node' && r.key === key && r.day.startsWith(`${month}-`) && r.day.length === 10)),
    hours(day) {
      const rows = store.hours(day)
      for (const r of pending(day, 'hour')) {
        const hour = Number(r.key)
        if (hour >= 0 && hour < 24) rows[hour] = { hour, ...add(rows[hour], r) }
      }
      return rows
    },
    nodeHours(day, key) {
      const rows = store.nodeHours(day, key)
      for (const r of getPending()) {
        if (r.kind !== 'node' || r.key !== key || !r.day.startsWith(`${day}@`)) continue
        const hour = Number(r.day.slice(11))
        rows.set(hour, add(rows.get(hour), r))
      }
      return rows
    },
    day(day, kind, limit) {
      const rows = new Map(store.day(day, kind, limit).map((r) => [r.key, r]))
      for (const r of pending(day, kind)) {
        const base = rows.get(r.key) || store.row(day, kind, r.key)
        rows.set(r.key, { key: r.key, ...add(base, r) })
      }
      return ranked([...rows.values()], limit)
    },
    daySum(day, kind) {
      const sum = { ...store.daySum(day, kind) }
      for (const r of pending(day, kind)) {
        sum.up += r.up; sum.down += r.down
        if (!store.row(day, kind, r.key)) sum.n++
      }
      return sum
    },
    drill(day, kind, key, by, limit) {
      const base = store.drill(day, kind, key, by, limit)
      const pair = pairKindFor(kind, by)
      if (!pair) return base
      const [pairKind, pos] = pair
      const rows = new Map(base.rows.map((r) => [r.key, r]))
      const sum = { ...base.sum }
      let count = base.count
      for (const r of pending(day, pairKind)) {
        const parts = r.key.split(PAIR_SEP)
        if (parts[pos] !== key) continue
        const other = parts[1 - pos]
        const saved = store.row(day, pairKind, r.key)
        rows.set(other, { key: other, ...add(saved, r) })
        sum.up += r.up; sum.down += r.down
        if (!saved) count++
      }
      return { rows: ranked([...rows.values()], limit), count, sum }
    },
  }
}

export const createTrafficCollector = ({
  store,
  fetchImpl = globalThis.fetch,
  getSecret = () => '',
  baseUrl = 'http://127.0.0.1:9095',
  intervalMs = 2000,
  retryMs = 10_000,
  flushMs = 60_000,
  // 分析数据保留多少个月(面板「后端设置」里可改,1~36,默认 6)。曲线、排行和下钻构成
  // 用同一个期限:分开留会出现"曲线上有这一天、点开却没有构成"的怪事。
  getKeepMonths = () => DEFAULT_KEEP_MONTHS,
  now = () => new Date(),
  log = () => {},
}) => {
  // 待写入的增量:key = day|kind|key。写库连续失败时最多攒这么多条(约几 MB),再多就丢
  const MAX_PENDING = 20_000
  let flushFailing = false
  const pending = new Map()
  // 上次快照里每条连接的累计字节,id → { up, down }
  const seen = new Map()
  let primed = false
  let lastUp = 0
  let lastDown = 0
  let failures = 0
  let stopped = true
  let pollTimer = null
  let flushTimer = null

  const bump = (day, kind, key, up, down, conns) => {
    if (!up && !down && !conns) return
    const id = `${day}|${kind}|${key}`
    const row = pending.get(id)
    if (row) {
      row.up += up
      row.down += down
      row.conns += conns
    } else {
      pending.set(id, { day, kind, key, up, down, conns })
    }
  }

  // 一次快照:和上次比,把增量记到 at 这一天。第一次只做基线不计数——面板重启时
  // 内核可能一直在跑,之前的字节早被上一个面板进程记过了,再算一遍就重复。
  const applySnapshot = (body, at = now(), proxies = null) => {
    const day = localDay(at)
    const list = body && Array.isArray(body.connections) ? body.connections : []
    const up = toInt(body && body.uploadTotal)
    const down = toInt(body && body.downloadTotal)

    if (!primed) {
      for (const c of list) {
        if (c && c.id) seen.set(String(c.id), { up: toInt(c.upload), down: toInt(c.download) })
      }
      lastUp = up
      lastDown = down
      primed = true
      return
    }

    // 内核重启计数会归零:比上次小就当作从 0 起算
    const totalUp = up >= lastUp ? up - lastUp : up
    const totalDown = down >= lastDown ? down - lastDown : down
    lastUp = up
    lastDown = down

    // 经 dnsmasq 回环出站的那些不算流量:它是绑在 lo 上的专用直连,只把发往 tun 网段
    // 53 端口的 DNS 查询交回路由器自己的 dnsmasq(见 engine/routing.mjs),字节根本没
    // 出过路由器。dnsmasq 接管模式下局域网每一次域名解析都从这里过,量还不小——正式
    // 路由器上一天 4.9 万条连接、14.8 GB,占了当天"出口"的三分之二,全是假的。
    // 内核的 uploadTotal/downloadTotal 把它算在内,所以总量也要把采样到的这部分减掉。
    let loopUp = 0
    let loopDown = 0
    const hh = pad2(at.getHours())
    const hday = hourDayKey(day, at.getHours())

    const alive = new Set()
    for (const c of list) {
      if (!c || !c.id) continue
      const id = String(c.id)
      alive.add(id)
      const cu = toInt(c.upload)
      const cd = toInt(c.download)
      const prev = seen.get(id)
      const isNew = !prev
      let du = cu
      let dd = cd
      if (prev) {
        du = cu >= prev.up ? cu - prev.up : cu
        dd = cd >= prev.down ? cd - prev.down : cd
      }
      // 末端节点第一次解析出来就记在这条连接上,之后不再重算:连接是经当时选中的那个节点拨出去的,组后来改选了
      // 别的节点,这条连接走的路也不会变。也正因为记住了,poll 才不用为一条活着的长连接每轮去问内核(见 poll)
      const entry = { up: cu, down: cd, node: prev && prev.node }
      seen.set(id, entry)
      const conns = isNew ? 1 : 0
      if (!du && !dd && !conns) continue
      let node = entry.node
      if (!node) {
        node = resolveLeaf(c.chains, proxies)
        // 有表、而且确实落到了真实节点上才记;没有表 / 还停在组上的,下一轮再试(不花网络请求)
        if (proxies && !isGroupEntry(proxies[node])) entry.node = node
      }
      if (node === DNSMASQ_OUTBOUND_TAG) {
        loopUp += du
        loopDown += dd
        continue
      }
      const host = hostOf(c.metadata)
      const client = clientOf(c.metadata)
      bump(day, 'total', '', 0, 0, conns)
      bump(day, 'hour', hh, 0, 0, conns)
      // 同一份增量记两遍:按天一份,按「天@小时」一份(小时明细,见 hourDayKey 的说明)
      for (const d of [day, hday]) {
        bump(d, 'node', node, du, dd, conns)
        bump(d, 'host', host, du, dd, conns)
        bump(d, 'client', client, du, dd, conns)
        bump(d, 'client_host', client + PAIR_SEP + host, du, dd, conns)
        bump(d, 'client_node', client + PAIR_SEP + node, du, dd, conns)
        bump(d, 'node_host', node + PAIR_SEP + host, du, dd, conns)
      }
    }
    // 总量减掉回环那部分。只能减"采样到的"——活不满一个采样周期的回环查询仍留在内核
    // 计数器里,和其它短连接一样进不了明细,这是采样精度的固有取舍(见文件开头)。
    // 连接数不用另外扣:回环的连接在上面 continue 掉了,本来就没进 total 的计数
    bump(day, 'total', '', Math.max(0, totalUp - loopUp), Math.max(0, totalDown - loopDown), 0)
    // 同一份增量再按采样时刻落进小时桶,给概览的 24 小时曲线用;一天只多 24 行
    bump(day, 'hour', hh, Math.max(0, totalUp - loopUp), Math.max(0, totalDown - loopDown), 0)

    for (const id of seen.keys()) {
      if (!alive.has(id)) seen.delete(id)
    }
  }

  // 把攒的增量写库;写失败放回去下次再试,不能丢
  const flush = () => {
    if (!pending.size) return 0
    const rows = [...pending.values()]
    pending.clear()
    try {
      store.add(rows)
    } catch (err) {
      // 放回去下次再试——但不能无限攒:闪存写满时每次都失败,pending 会一直长到把面板
      // 进程撑爆。超过上限就丢掉这批(丢的是统计,不是配置),并且只在第一次失败时记日志。
      if (pending.size + rows.length <= MAX_PENDING) {
        for (const r of rows) bump(r.day, r.kind, r.key, r.up, r.down, r.conns)
      }
      if (!flushFailing) log(`[traffic] 写入流量记录失败:${err instanceof Error ? err.message : err}`)
      flushFailing = true
      return 0
    }
    flushFailing = false
    return rows.length
  }

  // 合并老数据的长尾(见文件头 TAIL_* 的说明):清理时把该合并的日子排进队列,之后每分钟(tick)只做一天。
  // 一天是一个同步事务(一万多次删除,路由器上一两百毫秒),升级后第一次要补的日子可能有几十上百天,
  // 一口气做完会把面板卡住。平时只看刚过线的那几天;进程起来后第一次把保留期内的日子都看一遍
  let collapseWide = true
  const collapseQueue = []
  let collapseStats = { days: 0, rows: 0 }
  const collapseBeforeDay = () => {
    const c = new Date(now())
    c.setDate(c.getDate() - TAIL_COLLAPSE_AFTER_DAYS)
    return localDay(c)
  }
  const queueCollapse = (months) => {
    if (!store.needsCollapse || !store.collapseDay) return
    const span = collapseWide ? months * 31 + 1 : 3
    for (let i = 1; i <= span; i++) {
      const c = new Date(now())
      c.setDate(c.getDate() - TAIL_COLLAPSE_AFTER_DAYS - i)
      const day = localDay(c)
      if (!collapseQueue.includes(day) && store.needsCollapse(day)) collapseQueue.push(day)
    }
    collapseWide = false
  }
  const collapseOne = () => {
    const day = collapseQueue.shift()
    if (!day) return 0
    try {
      const removed = store.collapseDay(day)
      collapseStats.days++
      collapseStats.rows += removed
      if (!collapseQueue.length) {
        log(`[traffic] 老数据合并长尾:${collapseStats.days} 天,少了 ${collapseStats.rows} 行(超过 ${TAIL_COLLAPSE_AFTER_DAYS} 天的日子只留当天流量最大的 ${TAIL_KEEP_HOSTS} 个访问目标)`)
        collapseStats = { days: 0, rows: 0 }
      }
      return removed
    } catch (err) {
      log(`[traffic] 合并 ${day} 的长尾失败:${err instanceof Error ? err.message : err}`)
      return 0
    }
  }

  let hourPruneWide = true
  // 上次清理是哪一天、按几个月清的:清理一天跑一次就够,但用户改了保留时长要马上按新期限来
  let lastPruneDay = ''
  let lastKeepMonths = null
  const prune = () => {
    try {
      const months = normalizeKeepMonths(getKeepMonths())
      // 拷一份再算:别就地改 now() 给的对象
      const d = new Date(now())
      d.setMonth(d.getMonth() - months)
      // 小时明细只留最近 HOUR_DETAIL_KEEP_DAYS 天:按天做主键范围删,平时只看期限附近几天;
      // 第一次跑扫宽一点,补上停机期间没删掉的
      const hourDays = []
      if (store.pruneHourDetail || store.pruneBatch) {
        const span = hourPruneWide ? 60 : 3
        for (let i = 0; i < span; i++) {
          const c = new Date(now())
          c.setDate(c.getDate() - HOUR_DETAIL_KEEP_DAYS - i)
          hourDays.push(localDay(c))
        }
      }
      if (store.pruneBatch) store.pruneBatch(localDay(d), hourDays)
      else {
        store.prune(localDay(d))
        for (const day of hourDays) store.pruneHourDetail(day)
      }
      hourPruneWide = false
      queueCollapse(months)
      lastPruneDay = localDay(now())
      lastKeepMonths = months
    } catch (err) {
      log(`[traffic] 清理旧记录失败:${err instanceof Error ? err.message : err}`)
    }
  }
  // 每分钟跟着 flush 看一眼:跨天了、或者保留时长改了,才真的去删
  const maybePrune = () => {
    if (localDay(now()) !== lastPruneDay || normalizeKeepMonths(getKeepMonths()) !== lastKeepMonths) prune()
  }
  const tick = () => {
    flush()
    maybePrune()
    collapseOne()
  }

  const PROXIES_TTL_MS = 30_000
  const PROXIES_ON_DEMAND_MIN_MS = 10_000
  let proxiesCache = { at: 0, seq: 0, map: null }
  let pollSeq = 0
  const poll = async () => {
    try {
      const secret = getSecret()
      const seq = ++pollSeq
      const res = await fetchImpl(`${baseUrl}/connections`, {
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      // /proxies 用来把「组当了末端」的连接归到真实节点(见 resolveLeaf)。整份 /proxies 对内核不便宜——每答一次要把
      // 全部出站连同延迟历史序列化一遍,正式路由器(320 个出站)实测一次约 1.3 MB 的垃圾——所以:
      //   - 组的表 PROXIES_TTL_MS 刷一次就够;
      //   - **新出现的**、末端是组的连接,要的是它建立那一刻组的选中项:表不够新就再刷一次,但最多
      //     PROXIES_ON_DEMAND_MIN_MS 一次;已经见过的连接不再为它刷(它的节点第一次见到时就记下了,见 applySnapshot)。
      // 以前是「只要连接表里有末端是组的连接,这一轮就刷」:那种连接往往是长连接,它活多久就每 2 秒问一次——
      // 2026-09-19 正式路由器的内核堆剖面里,/proxies 一项占了内核全部内存分配的 38%(约 50 MB / 分钟),就是这么来的。
      // 问不到就照旧记
      const nowMs = () => now().getTime()
      const fetchProxies = async () => {
        try {
          const pr = await fetchImpl(`${baseUrl}/proxies`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {}, signal: AbortSignal.timeout(4000) })
          if (pr.ok) { proxiesCache = { at: nowMs(), seq, map: ((await pr.json()) || {}).proxies || null } }
        } catch { /* 用旧表 */ }
      }
      if (!proxiesCache.map || nowMs() - proxiesCache.at > PROXIES_TTL_MS) await fetchProxies()
      const list = (body && Array.isArray(body.connections)) ? body.connections : []
      const freshGroupLeaf = Boolean(proxiesCache.map) && primed && list.some((c) => c && c.id && !seen.has(String(c.id)) && isGroupEntry(proxiesCache.map[leafOf(c.chains)]))
      if (freshGroupLeaf && proxiesCache.seq !== seq && nowMs() - proxiesCache.at >= PROXIES_ON_DEMAND_MIN_MS) await fetchProxies()
      applySnapshot(body, now(), proxiesCache.map)
      if (failures) log('[traffic] 连接表恢复可读,继续采集')
      failures = 0
    } catch (err) {
      failures += 1
      // 内核没启动时每次都失败,只在第一次说一声
      if (failures === 1) log(`[traffic] 读不到内核连接表（内核没在跑?）:${err instanceof Error ? err.message : err}`)
    }
  }

  const schedule = () => {
    if (stopped) return
    pollTimer = setTimeout(async () => {
      await poll()
      schedule()
    }, failures ? retryMs : intervalMs)
    pollTimer.unref?.()
  }

  const start = () => {
    if (!stopped) return
    stopped = false
    prune()
    schedule()
    // 每分钟写一次库;清理只在跨天或改了保留时长时才做(见 maybePrune)
    flushTimer = setInterval(tick, flushMs)
    flushTimer.unref?.()
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(pollTimer)
    clearInterval(flushTimer)
    flush()
  }

  const readStore = createTrafficReadStore(store, () => [...pending.values()])
  return { store, readStore, start, stop, flush, prune, tick, applySnapshot, poll, collapseOne, collapseBeforeDay, get pendingSize() { return pending.size }, get collapsePending() { return collapseQueue.length } }
}
