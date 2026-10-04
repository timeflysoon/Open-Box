import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDnsmasqQueryLog, queryLogConfText, queryLogWanted, isLoopbackSource, DNSMASQ_QUERY_LOG_PATH } from './dnsmasq-query-log.mjs'

// 开发路由器(OpenWrt 25.12,dnsmasq 2.93,跑在 ujail 里)上 log-queries=extra 写进文件的原样
const SAMPLE = `Sep 27 02:04:57 dnsmasq[1]: started, version 2.93 cachesize 1000
Sep 27 02:04:57 dnsmasq-dhcp[1]: DHCP, IP range 10.0.0.100 -- 10.0.0.249, lease time 12h
Sep 27 02:04:57 dnsmasq[1]: using nameserver 127.0.0.1#7853
Sep 27 02:04:59 dnsmasq[1]: 1 10.0.0.20/41034 query[A] example.com from 10.0.0.20
Sep 27 02:04:59 dnsmasq[1]: 1 10.0.0.20/41034 forwarded example.com to 127.0.0.1#7853
Sep 27 02:04:59 dnsmasq[1]: 2 10.0.0.20/41034 query[AAAA] example.com from 10.0.0.20
Sep 27 02:04:59 dnsmasq[1]: 2 10.0.0.20/41034 forwarded example.com to 127.0.0.1#7853
Sep 27 02:04:59 dnsmasq[1]: 2 10.0.0.20/41034 reply example.com is NODATA-IPv6
Sep 27 02:04:59 dnsmasq[1]: 1 10.0.0.20/41034 reply example.com is 198.19.0.4
Sep 27 02:04:59 dnsmasq[1]: 3 10.0.0.21/54993 query[A] example.com from 10.0.0.21
Sep 27 02:04:59 dnsmasq[1]: 3 10.0.0.21/54993 cached example.com is 198.19.0.4
Sep 27 02:04:59 dnsmasq[1]: 5 127.0.0.1/54794 query[A] router.lan from 127.0.0.1
Sep 27 02:04:59 dnsmasq[1]: 5 127.0.0.1/54794 config router.lan is NXDOMAIN
Sep 27 02:04:59 dnsmasq[1]: 6 fd00::5/5353 query[type=65] Svc.Example.NET from fd00::5
Sep 27 02:04:59 dnsmasq[1]: 6 fd00::5/5353 forwarded Svc.Example.NET to 127.0.0.1#7853
Sep 27 02:04:59 dnsmasq[1]: 7 10.0.0.22/1000 query[A] corp.example from 10.0.0.22
Sep 27 02:04:59 dnsmasq[1]: 7 10.0.0.22/1000 forwarded corp.example to 10.1.1.1
Sep 27 02:04:59 dnsmasq[1]: 8 10.0.0.23/1001 query[PTR] 20.0.0.10.in-addr.arpa from 10.0.0.23
Sep 27 02:04:59 dnsmasq[1]: 8 10.0.0.23/1001 /tmp/hosts/dhcp.cfg01411c 10.0.0.20 is phone
Sep 27 02:27:28 dnsmasq[1]: 16 10.0.0.139/57254 query[A] www.qq.com from 10.0.0.139
Sep 27 02:27:28 dnsmasq[1]: 16 10.0.0.139/57254 cached www.qq.com is <CNAME>
Sep 27 02:27:28 dnsmasq[1]: 16 10.0.0.139/57254 cached ins-r23tsuuf.ias.tencent-cloud.net is 112.53.42.52
Sep 27 02:27:28 dnsmasq[1]: 17 10.0.0.139/57254 query[AAAA] www.qq.com from 10.0.0.139
Sep 27 02:27:28 dnsmasq[1]: 17 10.0.0.139/57254 cached www.qq.com is <CNAME>
Sep 27 02:27:28 dnsmasq[1]: 17 10.0.0.139/57254 forwarded www.qq.com to 127.0.0.1#7853
Sep 27 02:27:28 dnsmasq[1]: 17 10.0.0.139/57254 reply www.qq.com is NODATA-IPv6
`

const setup = (t, { at = 1_700_000_000_000 } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-dnsmasq-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'open-box-query.log')
  const calls = []
  let clock = at
  // 一个跑了一分钟的 dnsmasq;发信号记进 calls(真的实现只发给 dnsmasq 二进制,见 dnsmasq-signal.test.mjs)
  const daemons = () => [{ pid: 4242, ageMs: 60000 }]
  const signal = (sig) => { calls.push(['signal', sig]) }
  const log = createDnsmasqQueryLog({ file, now: () => clock, daemons, signal, procRoot: path.join(dir, 'no-proc'), exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' } } })
  return { dir, file, calls, log, tick: (ms) => { clock += ms }, at: () => clock }
}

test('conf text, wanted flag and loopback detection', () => {
  assert.equal(queryLogConfText(), `log-queries=extra\nlog-facility=${DNSMASQ_QUERY_LOG_PATH}\n`)
  assert.equal(DNSMASQ_QUERY_LOG_PATH, '/var/run/dnsmasq/open-box-query.log')
  assert.equal(queryLogWanted({ dns: { filter: { enabled: true } } }), true)
  assert.equal(queryLogWanted({ dns: { filter: { enabled: false } } }), false)
  assert.equal(queryLogWanted(null), false)
  for (const ip of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackSource(ip), true, ip)
  for (const ip of ['10.0.0.1', '', '::2', '192.168.3.127']) assert.equal(isLoopbackSource(ip), false, ip)
})

test('activation swaps the /dev/null sink for a plain file and asks dnsmasq to reopen it', async (t) => {
  const { file, calls, log } = setup(t)
  fs.symlinkSync('/dev/null', file)
  await log.sync(true)
  assert.equal(log.active(), true)
  const st = fs.lstatSync(file)
  assert.equal(st.isFile(), true, '软链接换成了普通文件')
  assert.equal(st.size, 0)
  assert.equal(st.mode & 0o777, 0o640)
  assert.deepEqual(calls, [['signal', 'SIGUSR2']])
  // 再同步一次:文件还在,不再折腾 dnsmasq
  await log.sync(true)
  assert.equal(calls.length, 1)
})

test('forwarded queries are matched back to the device; dnsmasq answers become records; other lines go to syslog', async (t) => {
  const { file, calls, log, at } = setup(t)
  fs.symlinkSync('/dev/null', file)
  await log.sync(true)
  fs.appendFileSync(file, SAMPLE)
  log.poll()
  // 内核那两条(A / AAAA)对回 10.0.0.20;同一条转发只能用一次
  assert.equal(log.resolve({ domain: 'example.com', qtype: 'AAAA', at: at() }), '10.0.0.20')
  assert.equal(log.resolve({ domain: 'example.com', qtype: 'A', at: at() }), '10.0.0.20')
  assert.equal(log.resolve({ domain: 'example.com', qtype: 'A', at: at() }), '')
  // type=65 按内核的写法叫 HTTPS,域名统一小写
  assert.equal(log.resolve({ domain: 'svc.example.net', qtype: 'HTTPS', at: at() }), 'fd00::5')
  // 转给别的上游的不进内核,不参与对照
  assert.equal(log.resolve({ domain: 'corp.example', qtype: 'A', at: at() }), '')
  const answered = log.takeAnswered()
  assert.deepEqual(answered.map((r) => [r.domain, r.qtype, r.source, r.result, r.via]), [
    ['example.com', 'A', '10.0.0.21', 'cached', 'dnsmasq'],
    ['router.lan', 'A', '127.0.0.1', 'local', 'dnsmasq'],
    ['20.0.0.10.in-addr.arpa', 'PTR', '10.0.0.23', 'local', 'dnsmasq'],
    ['www.qq.com', 'A', '10.0.0.139', 'cached', 'dnsmasq'],
  ], '缓存里只有 CNAME、后面又转给内核的那条不算 dnsmasq 答的')
  // 那条 AAAA 照样转给了内核,内核的记录对得回终端
  assert.equal(log.resolve({ domain: 'www.qq.com', qtype: 'AAAA', at: at() }), '10.0.0.139')
  assert.equal(answered[0].elapsed, null)
  assert.deepEqual(log.takeAnswered(), [])
  // 启动 / DHCP 那几行原样转进系统日志,查询那些行不转
  await log.sync(true)
  const logger = calls.filter((c) => c[0] === 'logger')
  assert.deepEqual(logger.map((c) => c.slice(1)), [
    ['-t', 'dnsmasq[1]', '-p', 'daemon.info', '--', 'started, version 2.93 cachesize 1000'],
    ['-t', 'dnsmasq-dhcp[1]', '-p', 'daemon.info', '--', 'DHCP, IP range 10.0.0.100 -- 10.0.0.249, lease time 12h'],
    ['-t', 'dnsmasq[1]', '-p', 'daemon.info', '--', 'using nameserver 127.0.0.1#7853'],
  ])
})

test('matching tolerates a few seconds either way and forgets stale forwards', async (t) => {
  const { file, log, tick, at } = setup(t)
  fs.symlinkSync('/dev/null', file)
  await log.sync(true)
  fs.appendFileSync(file, 'Sep 27 02:04:59 dnsmasq[1]: 9 10.0.0.30/1 query[A] a.example from 10.0.0.30\nSep 27 02:04:59 dnsmasq[1]: 9 10.0.0.30/1 forwarded a.example to 127.0.0.1#7853\n')
  log.poll()
  const read = at()
  // 内核那条记录比读到日志早几秒(日志是落库前才读的)
  assert.equal(log.resolve({ domain: 'a.example', qtype: 'A', at: read - 20000 }), '', '差太远不认')
  assert.equal(log.resolve({ domain: 'a.example', qtype: 'A', at: read - 3000 }), '10.0.0.30')
  fs.appendFileSync(file, 'Sep 27 02:05:00 dnsmasq[1]: 10 10.0.0.31/1 query[A] b.example from 10.0.0.31\nSep 27 02:05:00 dnsmasq[1]: 10 10.0.0.31/1 forwarded b.example to 127.0.0.1#7853\n')
  log.poll()
  tick(31000)
  log.poll()
  assert.equal(log.resolve({ domain: 'b.example', qtype: 'A', at: at() }), '', '半分钟没对上的丢掉')
})

test('the log is truncated once it passes the size limit and reading resumes from the start', async (t) => {
  const { file, log, at } = setup(t)
  fs.symlinkSync('/dev/null', file)
  await log.sync(true)
  const filler = 'Sep 27 02:04:59 dnsmasq[1]: 11 10.0.0.40/1 reply filler.example is 1.2.3.4\n'
  fs.appendFileSync(file, filler.repeat(Math.ceil((300 * 1024) / filler.length)))
  log.poll()
  assert.equal(fs.statSync(file).size, 0, '读完超过 256 KB 就清空')
  // dnsmasq 用 O_APPEND 接着写:清空之后的内容照样读得到
  fs.appendFileSync(file, 'Sep 27 02:05:01 dnsmasq[1]: 12 10.0.0.41/1 query[A] c.example from 10.0.0.41\nSep 27 02:05:01 dnsmasq[1]: 12 10.0.0.41/1 forwarded c.example to 127.0.0.1#7853\n')
  log.poll()
  assert.equal(log.resolve({ domain: 'c.example', qtype: 'A', at: at() }), '10.0.0.41')
})

test('a half-written last line waits for the rest', async (t) => {
  const { file, log, at } = setup(t)
  fs.symlinkSync('/dev/null', file)
  await log.sync(true)
  fs.appendFileSync(file, 'Sep 27 02:05:02 dnsmasq[1]: 13 10.0.0.50/1 query[A] d.example from 10.0.0.50\nSep 27 02:05:02 dnsmasq[1]: 13 10.0.0.50/1 forwar')
  log.poll()
  assert.equal(log.resolve({ domain: 'd.example', qtype: 'A', at: at() }), '')
  fs.appendFileSync(file, 'ded d.example to 127.0.0.1#7853\n')
  log.poll()
  assert.equal(log.resolve({ domain: 'd.example', qtype: 'A', at: at() }), '10.0.0.50')
})

test('the file turning back into a sink (panel stop hook) triggers re-activation; switching off stops reading', async (t) => {
  const { file, calls, log } = setup(t)
  fs.symlinkSync('/dev/null', file)
  await log.sync(true)
  fs.rmSync(file)
  fs.symlinkSync('/dev/null', file)
  log.poll()
  await log.sync(true)
  assert.equal(fs.lstatSync(file).isFile(), true)
  assert.equal(calls.filter((c) => c[0] === 'signal').length, 2)
  await log.sync(false)
  assert.equal(log.active(), false)
  fs.appendFileSync(file, 'Sep 27 02:05:03 dnsmasq[1]: 14 10.0.0.60/1 query[A] e.example from 10.0.0.60\nSep 27 02:05:03 dnsmasq[1]: 14 10.0.0.60/1 cached e.example is 1.1.1.1\n')
  log.poll()
  assert.deepEqual(log.takeAnswered(), [], '关掉之后不读')
})

test('activation waits while the log path is absent (kernel stopped and cleaned up, dnsmasq not running)', async (t) => {
  const { dir, file, calls, log } = setup(t)
  await log.sync(true)
  assert.equal(log.active(), false, '文件不在不建')
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(calls, [])
  const other = createDnsmasqQueryLog({ file: path.join(dir, 'missing', 'q.log'), daemons: () => [{ pid: 1, ageMs: 60000 }], signal: (sig) => calls.push(['signal', sig]), exec: async (...a) => { calls.push(a); return { code: 0 } } })
  await other.sync(true)
  assert.equal(other.active(), false)
  // 开机重放放好 /dev/null 软链接之后就接上
  fs.symlinkSync('/dev/null', file)
  await log.sync(true)
  assert.equal(log.active(), true)
})

test('a plain file dnsmasq already has open (panel deploy, panel restart) is read in place, and reading resumes where it stopped', async (t) => {
  const { dir, file, calls } = setup(t)
  // 假的 /proc:一个 dnsmasq 进程开着日志文件
  const proc = path.join(dir, 'proc')
  fs.mkdirSync(path.join(proc, '4242', 'fd'), { recursive: true })
  fs.writeFileSync(path.join(proc, '4242', 'comm'), 'dnsmasq\n')
  fs.writeFileSync(file, SAMPLE)
  fs.symlinkSync(file, path.join(proc, '4242', 'fd', '7'))
  let clock = 1_700_000_000_000
  const log = createDnsmasqQueryLog({ file, procRoot: proc, now: () => clock, daemons: () => [{ pid: 4242, ageMs: 60000 }], signal: (sig) => calls.push(['signal', sig]), exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0 } } })
  await log.sync(true)
  assert.deepEqual(calls, [], '不换文件、不发 USR2')
  log.poll()
  assert.equal(log.takeAnswered().length, 4, '启动以来写的都读到')
  await log.sync(true)
  assert.equal(calls.filter((c) => c[0] === 'logger').length, 3, 'dnsmasq 启动那几行转进系统日志')
  // 部署时元数据先写成关、再写成开:停读再读同一个文件,接着上次的位置,不重复出记录
  await log.sync(false)
  await log.sync(true)
  log.poll()
  assert.deepEqual(log.takeAnswered(), [])
  fs.appendFileSync(file, 'Sep 27 02:05:04 dnsmasq[1]: 15 10.0.0.70/1 query[A] f.example from 10.0.0.70\nSep 27 02:05:04 dnsmasq[1]: 15 10.0.0.70/1 cached f.example is 1.1.1.1\n')
  clock += 1000
  log.poll()
  assert.deepEqual(log.takeAnswered().map((r) => r.source), ['10.0.0.70'])
  // 没有 dnsmasq 开着它(陈旧文件):换新文件、发 USR2
  fs.rmSync(path.join(proc, '4242', 'fd', '7'))
  await log.sync(false)
  await log.sync(true)
  assert.deepEqual(calls.filter((c) => c[0] === 'signal'), [['signal', 'SIGUSR2']])
  assert.equal(fs.statSync(file).size, 0)
})

test('a dnsmasq that is not running or only just started is left alone this round', async (t) => {
  const { dir, file } = setup(t)
  fs.symlinkSync('/dev/null', file)
  const calls = []
  let running = []
  const log = createDnsmasqQueryLog({ file, daemons: () => running, signal: (sig) => calls.push(sig), procRoot: path.join(dir, 'no-proc') })
  await log.sync(true)
  assert.equal(log.active(), false, 'dnsmasq 没在跑')
  running = [{ pid: 7, ageMs: 800 }]
  await log.sync(true)
  assert.equal(log.active(), false, '刚起来(部署 / 开机重放正在重启它)')
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true, '文件也先不换')
  assert.deepEqual(calls, [])
  running = [{ pid: 7, ageMs: 5000 }]
  await log.sync(true)
  assert.equal(log.active(), true)
  assert.deepEqual(calls, ['SIGUSR2'])
})

// 用户自己开的查询日志(uci logqueries=1,没有 extra 的序号)写进系统日志:logread -f -t 读来的原样(#322 的格式)。
// dnsmasq 单线程,一条查询的「查询」行后面紧跟它的「转发 / 缓存」行;上游的 reply 行晚到
const SYSLOG_SAMPLE = (sec) => `Tue Sep 29 10:03:01 2026 [${sec}.101] daemon.info dnsmasq[18363]: query[HTTPS] openwrt.org from 10.0.0.209
Tue Sep 29 10:03:01 2026 [${sec}.102] daemon.info dnsmasq[18363]: forwarded openwrt.org to 127.0.0.1#7853
Tue Sep 29 10:03:01 2026 [${sec}.103] daemon.info dnsmasq[18363]: query[AAAA] openwrt.org from 10.0.0.209
Tue Sep 29 10:03:01 2026 [${sec}.104] daemon.info dnsmasq[18363]: forwarded openwrt.org to 127.0.0.1#7853
Tue Sep 29 10:03:01 2026 [${sec}.105] daemon.info dnsmasq[18363]: reply openwrt.org is 151.101.2.132
Tue Sep 29 10:03:01 2026 [${sec}.106] daemon.info dnsmasq[18363]: query[A] openwrt.org from 10.0.0.114
Tue Sep 29 10:03:01 2026 [${sec}.107] daemon.info dnsmasq[18363]: cached openwrt.org is 151.101.2.132
Tue Sep 29 10:03:01 2026 [${sec}.108] daemon.info dnsmasq[18363]: query[A] www.baidu.com from 10.0.0.114
Tue Sep 29 10:03:01 2026 [${sec}.109] daemon.info dnsmasq[18363]: cached www.baidu.com is 110.242.69.21
Tue Sep 29 10:03:01 2026 [${sec}.110] daemon.info dnsmasq-dhcp[18363]: DHCPACK(br-lan) 10.0.0.114 aa:bb:cc:dd:ee:ff phone
`

// 假的 logread 子进程:记下参数,测试往 stdout 里喂数据
const fakeSpawn = () => {
  const procs = []
  const spawn = (cmd, args) => {
    const handlers = {}
    const stdoutHandlers = []
    const proc = {
      cmd, args, killed: false,
      stdout: { on: (ev, fn) => { if (ev === 'data') stdoutHandlers.push(fn) } },
      on: (ev, fn) => { handlers[ev] = fn },
      kill: () => { proc.killed = true },
      feed: (text) => { for (const fn of stdoutHandlers) fn(Buffer.from(text)) },
      exit: () => handlers.exit && handlers.exit(0),
    }
    procs.push(proc)
    return proc
  }
  return { spawn, procs }
}

test('用户自己把查询日志写进系统日志:跟着 logread -f -t 读,没有序号的格式按域名先进先出对回终端,不往系统日志转(#322)', async () => {
  const at = 1_790_000_000_000
  let clock = at
  const calls = []
  const { spawn, procs } = fakeSpawn()
  const log = createDnsmasqQueryLog({ file: '/nonexistent/open-box-query.log', now: () => clock, spawn, exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0 } }, daemons: () => [], signal: () => {} })
  await log.sync('syslog')
  assert.equal(log.active(), true)
  assert.equal(procs.length, 1)
  assert.deepEqual([procs[0].cmd, ...procs[0].args], ['logread', '-f', '-t', '-l', '1', '-e', 'dnsmasq'])
  // 开跟之前的旧行(-l 1 带出来的)丢掉;之后的照常读。数据分两块到,半行等下一块
  const oldLine = `Tue Sep 29 09:00:00 2026 [${Math.floor(at / 1000) - 3600}.000] daemon.info dnsmasq[18363]: query[A] stale.example from 10.0.0.99\n`
  const text = SYSLOG_SAMPLE(Math.floor(at / 1000))
  procs[0].feed(oldLine + text.slice(0, 200))
  procs[0].feed(text.slice(200))
  log.poll()
  // 转给内核的两条(HTTPS、AAAA)对回 10.0.0.209;10.0.0.114 的 A 是 dnsmasq 缓存答的(见下)
  assert.equal(log.resolve({ domain: 'openwrt.org', qtype: 'HTTPS', at: clock }), '10.0.0.209')
  assert.equal(log.resolve({ domain: 'openwrt.org', qtype: 'AAAA', at: clock }), '10.0.0.209')
  assert.equal(log.resolve({ domain: 'openwrt.org', qtype: 'A', at: clock }), '')
  assert.equal(log.resolve({ domain: 'stale.example', qtype: 'A', at: clock }), '')
  assert.deepEqual(log.takeAnswered().map((r) => [r.domain, r.source, r.result]), [
    ['openwrt.org', '10.0.0.114', 'cached'],
    ['www.baidu.com', '10.0.0.114', 'cached'],
  ])
  // 系统日志里本来就有,一行都不往回转
  await log.sync('syslog')
  assert.equal(calls.filter((c) => c[0] === 'logger').length, 0)
  // logread 退出:隔一会儿再起;关掉就结束子进程
  procs[0].exit()
  await log.sync('syslog')
  assert.equal(procs.length, 1, '刚退出,先不重起')
  clock += 6000
  await log.sync('syslog')
  assert.equal(procs.length, 2)
  await log.sync(false)
  assert.equal(procs[1].killed, true)
  assert.equal(log.active(), false)
})
