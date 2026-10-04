// dnsmasq 转发模式下,终端的查询先到 dnsmasq,再由它从 127.0.0.1 转给内核:内核那边只看得到「路由器转发」,
// 「域名解析查询」的终端设备一栏认不出是哪台。这里让 dnsmasq 把查询日志(log-queries=extra,每行带查询序号和终端地址)
// 写进内存里的一个单独文件(log-facility;不进 logread——系统日志缓冲只有几十到一百多 KB,几分钟就会被刷满),面板边读边清:
//   · 转给内核的(forwarded … to 127.0.0.1#7853):按域名 + 类型记下是哪台终端,内核那条记录落库前对回去(resolve);
//   · dnsmasq 自己答掉的(缓存 cached、本地 config / hosts 文件 / DHCP):内核看不到,这里直接出一条记录(takeAnswered);
//   · 其余的行(启动、DHCP、告警)原样转进系统日志(logger),logread 里照样看得到。
// 只在 OpenWrt 的 dnsmasq 转发模式、开着域名过滤(记录只在这时采集)时开(dns-takeover.mjs 往受管文件里写那两行)。
// 日志文件的状态:
//   指向 /dev/null 的软链接 —— 没人读:开机时面板还没读起来(openwrt/initd/openbox 重放受管文件时建)、面板被停掉
//                             (openwrt/initd/openbox-panel 的 stop_service),dnsmasq 写进 /dev/null,不会把 /tmp 越写越大;
//   普通文件 —— 面板在读。面板自己部署时建的是普通文件(马上就读,dnsmasq 启动那几行也留得住);别的情况面板换上一个空文件
//              (交给 dnsmasq 的用户)、发 USR2 让 dnsmasq 重开日志(sync)。
// 读过的超过 MAX_BYTES 就清空:dnsmasq 用 O_APPEND 写,清空后从头接着写(开发路由器实测)。
//
// 用户自己开了查询日志、写进系统日志时(dns-takeover.mjs 判出来,元数据 dnsmasqQueryLog = { reason: 'user', syslog: true }),
// 不接管他的设置,改成跟着 `logread -f -t -e dnsmasq` 读(#322):同一套解析,不往系统日志转(本来就在里面)。用户开的查询日志
// 一般没有 extra 的序号和端口(`query[A] x from 10.0.0.209`),同一个域名按先进先出把「查询」和「转发 / 缓存」对上。
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { dnsmasqDaemons, signalDnsmasq } from './dnsmasq-signal.mjs'
import { childEnv } from './timezone.mjs'

// init 脚本(openwrt/initd/openbox、openbox-panel)里是同一个路径。OpenWrt 的 dnsmasq 跑在 ujail 里,只有 /var/run/dnsmasq/
// 是可写的挂载,日志只能放这里
export const DNSMASQ_QUERY_LOG_PATH = '/var/run/dnsmasq/open-box-query.log'
export const queryLogConfText = (file = DNSMASQ_QUERY_LOG_PATH) => `log-queries=extra\nlog-facility=${file}\n`
// 要不要让 dnsmasq 记查询日志:记录只在开着域名过滤时采集
export const queryLogWanted = (profile) => profile?.dns?.filter?.enabled === true

const MAX_BYTES = 256 * 1024
// 面板卡住很久没读时,一次最多读这么多,更早的丢掉
const READ_CAP = 1024 * 1024
// 转给内核的查询等内核那条记录的时间;dnsmasq 并掉的重复查询没有下文,到点丢掉
const KEEP_MS = 30000
// 对回去时两边时间的容差:两边都是面板读到的时间,文件每次落库前才读
const MATCH_MS = 15000
const MAX_ENTRIES = 5000
const KERNEL_UPSTREAM = /^(127\.0\.0\.1|::1)#7853$/
// 每次最多转这么多行进系统日志,dnsmasq 狂刷告警时不至于起一大堆 logger
const SYSLOG_BATCH = 50

const LINE = /^\w{3} [ \d]\d \d\d:\d\d:\d\d (\S+?\[\d+\]): (.*)$/
// logread -t 的行:「Tue Sep 29 17:48:31 2026 [1790675311.862] daemon.info dnsmasq[18363]: query[A] …」。行首是路由器的
// 本地时间,面板(Node)不一定和它同一个时区,旧不旧按 -t 加的 Unix 时间比
const SYSLOG_LINE = /^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4} \[(\d+)(?:\.\d+)?\] \S+ (dnsmasq\[\d+\]): (.*)$/
const QUERY = /^(\d+) (\S+)\/\d+ (.*)$/
// 跟着 logread 读:子进程退出后隔这么久再起;开跟之前的旧行(-l 1 最多带一条)按日志里的时间丢掉
const SYSLOG_RESTART_MS = 5000
const SYSLOG_BACKLOG_MS = 10000
const SYSLOG_MAX_LINES = 20000
const QTYPE_NAMES = { 64: 'SVCB', 65: 'HTTPS' }
const qtypeOf = (raw) => {
  const n = /^type=(\d+)$/i.exec(raw)
  return n ? QTYPE_NAMES[n[1]] || `TYPE${n[1]}` : String(raw).toUpperCase()
}
const domainOf = (raw) => String(raw).replace(/\.$/, '').toLowerCase()
export const isLoopbackSource = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(String(ip || ''))
const priorityOf = (text) => (/fail|error|cannot|warning|attack|refused|overflow|lost|exhausted|maximum/i.test(text) ? 'daemon.warn' : 'daemon.info')

// dnsmasq 进程此刻开着的是不是这个文件(/proc/<pid>/fd 按 inode 比;ujail 里的 dnsmasq 也看得到)
const openedByDnsmasq = (procRoot, st) => {
  let pids = []
  try { pids = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n)) } catch { return false }
  for (const pid of pids) {
    let comm = ''
    try { comm = fs.readFileSync(`${procRoot}/${pid}/comm`, 'utf8').trim() } catch { continue }
    if (comm !== 'dnsmasq') continue
    let fds = []
    try { fds = fs.readdirSync(`${procRoot}/${pid}/fd`) } catch { continue }
    for (const fd of fds) {
      try {
        const target = fs.statSync(`${procRoot}/${pid}/fd/${fd}`)
        if (target.ino === st.ino && target.dev === st.dev) return true
      } catch { /* fd 刚关掉 */ }
    }
  }
  return false
}

// 刚起来的 dnsmasq 先不碰:信号处理可能还没装好(dnsmasq-signal.mjs)
const DNSMASQ_SETTLE_MS = 3000

// exec 只用来往系统日志转行(logger);daemons / signal 换成假的给测试用
export const createDnsmasqQueryLog = ({
  file = DNSMASQ_QUERY_LOG_PATH, exec = async () => ({ code: 1 }), now = Date.now, log = () => {}, procRoot = '/proc',
  daemons = () => dnsmasqDaemons({ procRoot }), signal = (sig) => signalDnsmasq(sig, { procRoot, minAgeMs: DNSMASQ_SETTLE_MS }),
  spawn = nodeSpawn,
} = {}) => {
  let active = false
  // 'file':读自己的日志文件;'syslog':跟着 logread 读用户自己开的查询日志
  let mode = ''
  let broken = false
  let offset = 0
  let inode = 0
  let partial = ''
  const pending = new Map()
  // 没有序号的查询(用户自己开的 log-queries,不是 extra):域名 → [{ at, qtype, client }],先进先出
  const plain = new Map()
  let plainCount = 0
  // 域名 → [{ at, qtype, client }]:转给内核、还没对上内核那条记录的
  const forwards = new Map()
  let forwardCount = 0
  let answered = []
  let syslog = []

  // 读到哪儿(inode + offset)不清:停读之后再读同一个文件就接着读,不重复出记录
  const reset = () => { pending.clear(); plain.clear(); plainCount = 0; forwards.clear(); forwardCount = 0; answered = []; syslog = [] }
  const expire = (t) => {
    for (const [serial, p] of pending) if (t - p.at > KEEP_MS) pending.delete(serial)
    for (const [domain, list] of plain) {
      const keep = list.filter((p) => t - p.at <= KEEP_MS)
      plainCount -= list.length - keep.length
      if (keep.length) plain.set(domain, keep)
      else plain.delete(domain)
    }
    for (const [domain, list] of forwards) {
      const keep = list.filter((f) => t - f.at <= KEEP_MS)
      forwardCount -= list.length - keep.length
      if (keep.length) forwards.set(domain, keep)
      else forwards.delete(domain)
    }
  }

  const addForward = (p) => {
    if (forwardCount >= MAX_ENTRIES) return
    const list = forwards.get(p.domain) || []
    list.push({ at: p.at, qtype: p.qtype, client: p.client })
    forwards.set(p.domain, list)
    forwardCount += 1
  }
  const answer = (p, how) => {
    if (answered.length < 2000) answered.push({ at: p.at, domain: p.domain, qtype: p.qtype, source: p.client, result: how.startsWith('cached') ? 'cached' : 'local', list: '', elapsed: null, via: 'dnsmasq' })
  }
  const takePlain = (domain) => {
    const list = plain.get(domain)
    if (!list) return null
    const p = list.shift()
    plainCount -= 1
    if (!list.length) plain.delete(domain)
    return p
  }
  // 没有序号的消息(用户自己开的查询日志):true = 认出来了
  const acceptPlain = (text, t) => {
    let r
    if ((r = /^query\[([^\]]+)\] (\S+) from (\S+)$/.exec(text))) {
      if (plainCount >= MAX_ENTRIES) return true
      const domain = domainOf(r[2])
      const list = plain.get(domain) || []
      list.push({ at: t, domain, qtype: qtypeOf(r[1]), client: r[3] })
      plain.set(domain, list)
      plainCount += 1
      return true
    }
    if ((r = /^forwarded (\S+) to (\S+)$/.exec(text))) {
      const p = takePlain(domainOf(r[1]))
      if (p && KERNEL_UPSTREAM.test(r[2])) addForward(p)
      return true
    }
    if ((r = /^(cached|cached-stale|config|DHCP|\/\S+) (\S+) is (.*)$/.exec(text))) {
      if (r[3] === '<CNAME>') return true
      const p = takePlain(domainOf(r[2]))
      if (p) answer(p, r[1])
      return true
    }
    return /^reply \S+ is /.test(text)
  }

  // fromSyslog:logread 读来的行(格式不同;不往系统日志转,本来就在里面)
  const accept = (line, t, fromSyslog = false) => {
    let ident
    let text
    if (fromSyslog) {
      const m = SYSLOG_LINE.exec(line)
      if (!m) return
      // 开跟之前的旧行不要:它们的「转发」会对上刚落库的同名记录
      if (Number(m[1]) * 1000 < syslogSince - SYSLOG_BACKLOG_MS) return
      ;[, , ident, text] = m
    } else {
      const m = LINE.exec(line)
      if (!m) return
      ;[, ident, text] = m
    }
    const q = QUERY.exec(text)
    if (!q) {
      if (acceptPlain(text, t)) return
      if (!fromSyslog && syslog.length < 1000) syslog.push({ ident, text })
      if (/^started, version /.test(text)) { pending.clear(); plain.clear(); plainCount = 0 }
      return
    }
    const [, serial, , rest] = q
    let r
    if ((r = /^query\[([^\]]+)\] (\S+) from (\S+)$/.exec(rest))) {
      if (pending.size >= MAX_ENTRIES) pending.delete(pending.keys().next().value)
      pending.set(serial, { at: t, domain: domainOf(r[2]), qtype: qtypeOf(r[1]), client: r[3] })
      return
    }
    const p = pending.get(serial)
    if (!p) return
    if ((r = /^forwarded \S+ to (\S+)$/.exec(rest))) {
      pending.delete(serial)
      if (KERNEL_UPSTREAM.test(r[1])) addForward(p)
      return
    }
    // 缓存里只有 CNAME 那一段(cached x is <CNAME>)还没完:后面可能是目标的缓存,也可能照样转给内核(开发路由器实测 AAAA 就是这样)
    if ((r = /^(cached|cached-stale|config|DHCP|\/\S+) \S+ is (.*)$/.exec(rest))) {
      if (r[2] === '<CNAME>') return
      pending.delete(serial)
      answer(p, r[1])
    }
  }

  // 跟着 logread 读(syslog 模式):子进程的输出攒成行,poll 时处理;退出了隔一会儿再起。只结束自己起的这个进程
  let child = null
  let childPartial = ''
  let syslogLines = []
  let syslogSince = 0
  let restartAt = 0
  const startFollow = () => {
    if (child || now() < restartAt) return
    syslogSince = now()
    childPartial = ''
    let proc
    try {
      proc = spawn('logread', ['-f', '-t', '-l', '1', '-e', 'dnsmasq'], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() })
    } catch (error) {
      restartAt = now() + SYSLOG_RESTART_MS
      log(`[dns-filter] logread 起不来: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    child = proc
    proc.stdout.on('data', (chunk) => {
      const lines = (childPartial + chunk.toString('utf8')).split('\n')
      childPartial = lines.pop() || ''
      for (const line of lines) if (syslogLines.length < SYSLOG_MAX_LINES) syslogLines.push(line)
    })
    const gone = () => {
      if (child !== proc) return
      child = null
      restartAt = now() + SYSLOG_RESTART_MS
    }
    proc.on('exit', gone)
    proc.on('error', gone)
  }
  const stopFollow = () => {
    const proc = child
    child = null
    syslogLines = []
    childPartial = ''
    if (proc) { try { proc.kill() } catch { /* 已经退了 */ } }
  }

  const poll = () => {
    if (!active) return
    if (mode === 'syslog') {
      const lines = syslogLines
      syslogLines = []
      const t = now()
      for (const line of lines) accept(line, t, true)
      expire(t)
      return
    }
    let st
    try { st = fs.lstatSync(file) } catch { broken = true; return }
    if (!st.isFile()) { broken = true; return }
    if (st.ino !== inode || st.size < offset) { inode = st.ino; offset = 0; partial = '' }
    if (st.size > offset) {
      if (st.size - offset > READ_CAP) { offset = st.size - READ_CAP; partial = '' }
      const length = st.size - offset
      const buf = Buffer.alloc(length)
      const fd = fs.openSync(file, 'r')
      let got = 0
      try { got = fs.readSync(fd, buf, 0, length, offset) } finally { fs.closeSync(fd) }
      offset += got
      const lines = (partial + buf.subarray(0, got).toString('utf8')).split('\n')
      partial = lines.pop() || ''
      const t = now()
      for (const line of lines) accept(line, t)
    }
    expire(now())
    if (offset > MAX_BYTES) {
      try { fs.truncateSync(file, 0) } catch { /* 下次再清 */ }
      offset = 0
      partial = ''
    }
  }

  // 内核那条记录(来源是本机 = dnsmasq 转来的)对回终端:同域名先找同类型的,再退而求其次找别的类型(两边类型写法对不上时)
  const resolve = (row) => {
    const list = forwards.get(row.domain)
    if (!list) return ''
    const near = (f) => Math.abs(f.at - row.at) <= MATCH_MS
    let i = list.findIndex((f) => f.qtype === row.qtype && near(f))
    if (i < 0) i = list.findIndex(near)
    if (i < 0) return ''
    const [f] = list.splice(i, 1)
    forwardCount -= 1
    if (!list.length) forwards.delete(row.domain)
    return f.client
  }

  const takeAnswered = () => {
    const out = answered
    answered = []
    return out
  }

  // 已经是 dnsmasq 开着的普通文件(面板部署时建的、面板重启前在读的):接着读。否则换上一个空的普通文件(属主跟
  // /var/run/dnsmasq 目录,dnsmasq 降权后要能写),让 dnsmasq 重开日志。
  // 路径压根不在 = dnsmasq 没按这份配置记日志(内核停了,init 脚本清理时删的;或者 dnsmasq 没在跑):不建,下一轮再看——
  // 要记的时候部署(建普通文件)和开机重放(建 /dev/null 软链接)都会先把它放好
  const activate = async () => {
    reset()
    let st = null
    try { st = fs.lstatSync(file) } catch { return false }
    if (st.isFile() && openedByDnsmasq(procRoot, st)) {
      if (st.ino !== inode) { inode = st.ino; offset = 0; partial = '' }
      return true
    }
    // dnsmasq 没在跑、或者刚起来(比如部署 / 开机重放正在重启它):这一轮先不换,免得信号打在还没准备好的进程上
    const running = daemons()
    if (!running.length || running.some((d) => d.ageMs < DNSMASQ_SETTLE_MS)) return false
    const dir = path.dirname(file)
    let owner
    try { owner = fs.statSync(dir) } catch { return false }
    const tmp = `${file}.new`
    try {
      fs.writeFileSync(tmp, '', { mode: 0o640 })
      fs.chownSync(tmp, owner.uid, owner.gid)
      fs.renameSync(tmp, file)
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* 清不掉就算了 */ }
      log(`[dns-filter] dnsmasq 查询日志换不上: ${error.message}`)
      return false
    }
    signal('SIGUSR2')
    inode = 0
    offset = 0
    partial = ''
    return true
  }

  const sendSyslog = async () => {
    const batch = syslog.splice(0, SYSLOG_BATCH)
    if (syslog.length > SYSLOG_BATCH * 4) syslog = []
    for (const { ident, text } of batch) await exec('logger', ['-t', ident, '-p', priorityOf(text), '--', text], { timeoutMs: 5000 })
  }

  return {
    // 每轮(dns-filter-observer 的 tick)按部署元数据对齐:要记就保证文件在、dnsmasq 写的是它;不要了就停读
    // (受管文件和日志文件由部署那边拿掉,dns-takeover.mjs)
    // wanted:false / 'file'(或 true)/ 'syslog'
    sync: async (wanted) => {
      const next = wanted === 'syslog' ? 'syslog' : wanted ? 'file' : ''
      if (next !== mode && active) reset()
      if (next !== 'syslog') stopFollow()
      if (!next) {
        active = false
        mode = ''
        broken = false
        return
      }
      if (next === 'syslog') {
        mode = 'syslog'
        active = true
        startFollow()
        return
      }
      if (mode !== 'file') { active = false; broken = false }
      mode = 'file'
      if (!active || broken) {
        broken = false
        active = await activate()
      }
      if (active && syslog.length) await sendSyslog()
    },
    stop: () => stopFollow(),
    poll,
    resolve,
    takeAnswered,
    active: () => active,
  }
}
