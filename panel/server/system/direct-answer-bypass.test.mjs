import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import {
  DIRECT_ANSWER_FLAG_ENV, DIRECT_ANSWER_REPEAT_MS, DIRECT_ANSWER_STATE_NAME, KERNEL_DNS_TIMEOUT_MS, createDirectAnswerSwitch,
  directAnswerFlagPath, directAnswerKey, directAnswerStatePath, directAnswerWanted, elementTimeoutSec, keyRoutingHash,
} from './direct-answer-bypass.mjs'
import { DIRECT_ANSWERED_SET } from './entry-bypass.mjs'

const paths = createPaths('/opt/open-box')
const classes = { Speed: 'direct', 国外: 'proxy', 国内: 'direct', 其他: 'direct' }
const whitelist = (over = {}) => ({ generatedAt: 'g1', routingHash: 'hash-a', autoRedirect: true, firstLayer: { entryMode: { mode: 'whitelist' }, policyClasses: { ...classes, ...over } } })
const blacklist = { ...whitelist(), firstLayer: { entryMode: { mode: 'blacklist' }, policyClasses: classes } }
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const flag = directAnswerFlagPath(paths)
const stateFile = directAnswerStatePath(paths)

// 记下每次清集合时开关文件的内容、存档还在不在:必须先换钥匙、再清集合(审查第五项:先清再换的话,两步之间内核按旧钥匙
// 写进去的会一直留着;换了钥匙之后内核作废自己的记录,这一清把之前按旧状态写进去的全清掉)
// dnsmasq 的 HUP 走 dnsmasq-signal.mjs(只发给真正的 dnsmasq 进程),这里换成记下当时钥匙的假的
const recordingCtx = (files = {}) => {
  const ctx = createMockContext({ files })
  const flushes = []
  const hups = []
  const realExec = ctx.exec.bind(ctx)
  ctx.exec = async (cmd, args, opts) => {
    if (cmd === 'nft' && args[0] === 'flush') flushes.push({ set: args[4], key: ctx.files[flag], state: stateFile in ctx.files })
    return realExec(cmd, args, opts)
  }
  const signal = (sig) => { if (sig === 'SIGHUP') hups.push({ key: ctx.files[flag] }); return { found: 1, sent: 1, young: 0 } }
  return { ctx, flushes, hups, signal }
}

test('开关该不该开、钥匙、超时区间', () => {
  assert.equal(directAnswerWanted(whitelist()), true)
  assert.equal(directAnswerWanted({ ...whitelist(), autoRedirect: false }), false, '纯 tun 没有入口集合可写')
  assert.equal(directAnswerWanted(blacklist), false)
  assert.equal(directAnswerWanted(null), false)
  // 黑名单入口:部署算出来可以开(entryMode.directAnswer,#307)才开;纯 tun 照旧不开
  const blackOk = { ...blacklist, firstLayer: { ...blacklist.firstLayer, entryMode: { ...blacklist.firstLayer.entryMode, directAnswer: true } } }
  assert.equal(directAnswerWanted(blackOk), true)
  assert.equal(directAnswerWanted({ ...blackOk, autoRedirect: false }), false)
  assert.equal(flag, '/opt/open-box/data/flip/direct-answer.on')
  assert.equal(stateFile, '/opt/open-box/data/flip/direct-answer.state')
  assert.equal(directAnswerKey('hash-a', 5), 'v1 hash-a 5\n')
  assert.equal(keyRoutingHash('v1 hash-a 5\n'), 'hash-a')
  assert.equal(keyRoutingHash('2026-09-26T00:36:35.000Z\n'), null, 'v0.1.255 写的是一行时间')
  assert.equal(elementTimeoutSec(60), 900)
  assert.equal(elementTimeoutSec(47685), 47685, 'a.nel.cloudflare.com 的 TTL:按 TTL 活')
  assert.equal(elementTimeoutSec(999999), 86400, '最多一天')
})

test('开关管理:白名单模式写钥匙;分流设置改过、站点集从直连切走时先换钥匙再清集合删存档,最后清 dnsmasq 缓存;从代理切回直连不清', async () => {
  const { ctx, flushes, hups, signal } = recordingCtx()
  let meta = whitelist()
  let clock = 1000
  const logs = []
  const sw = createDirectAnswerSwitch({ ctx, paths, readMeta: async () => meta, log: (m) => logs.push(m), intervalMs: 60000, now: () => clock, signal })
  sw.start()
  await settle()
  assert.equal(ctx.files[flag], 'v1 hash-a 1000\n', '打开时写钥匙')
  assert.deepEqual(flushes, [], '开着的时候不碰集合')
  // 什么都没变:不动
  clock = 2000
  await sw.tick()
  assert.equal(ctx.files[flag], 'v1 hash-a 1000\n')
  // 站点集「国外」从代理切回直连:只会多放行,不清
  meta = whitelist({ 国外: 'direct' })
  await sw.tick()
  assert.deepEqual(flushes, [])
  // 「Speed」从直连切到代理:它的域名以后拿 FakeIP,集合里旧的真实地址不能再放行
  ctx.files[stateFile] = '{}'
  clock = 3000
  meta = whitelist({ 国外: 'direct', Speed: 'proxy' })
  await sw.tick()
  assert.deepEqual(flushes.map((f) => f.set), [DIRECT_ANSWERED_SET[4], DIRECT_ANSWERED_SET[6]])
  assert.ok(flushes.every((f) => f.key === 'v1 hash-a 3000\n'), '先换钥匙再清集合')
  assert.equal(stateFile in ctx.files, false, '存档删掉')
  assert.equal(ctx.files[flag], 'v1 hash-a 3000\n', '换了钥匙')
  assert.deepEqual(hups, [{ key: 'v1 hash-a 3000\n' }], '换完钥匙再清 dnsmasq 缓存:终端的下一次查询到达内核时,内核已经认新钥匙')
  assert.ok(logs.some((l) => l.includes('Speed') && l.includes('从直连切走') && l.includes('清 dnsmasq 的缓存')), '日志写清掉了哪一层缓存')
  // 分流设置改过(指纹变了)
  flushes.length = 0
  clock = 4000
  meta = { ...whitelist({ 国外: 'direct', Speed: 'proxy' }), routingHash: 'hash-b' }
  await sw.tick()
  assert.equal(flushes.length, 2)
  assert.equal(ctx.files[flag], 'v1 hash-b 4000\n')
  assert.equal(hups.length, 2)
  // 离开白名单模式:先删开关和存档,再清集合
  flushes.length = 0
  ctx.files[stateFile] = '{}'
  meta = blacklist
  await sw.tick()
  assert.equal(flag in ctx.files, false)
  assert.equal(stateFile in ctx.files, false)
  assert.deepEqual(flushes.map((f) => [f.key, f.state]), [[undefined, false], [undefined, false]])
  assert.equal(hups.length, 2, '离开白名单模式不用清 dnsmasq(集合不再用了)')
  // 回到白名单:重新写钥匙,不清(离开时清过)
  flushes.length = 0
  clock = 5000
  meta = whitelist()
  await sw.tick()
  assert.equal(ctx.files[flag], 'v1 hash-a 5000\n')
  assert.deepEqual(flushes, [])
  sw.stop()
})

test('面板重启:钥匙和分流设置对得上就不清(保住内核按存档恢复的地址);v0.1.255 留下的老开关换一次钥匙', async () => {
  const same = recordingCtx({ [flag]: 'v1 hash-a 777\n' })
  const a = createDirectAnswerSwitch({ ctx: same.ctx, paths, readMeta: async () => whitelist(), intervalMs: 60000, now: () => 9000, signal: same.signal })
  a.start()
  await settle()
  assert.deepEqual(same.flushes, [])
  assert.equal(same.ctx.files[flag], 'v1 hash-a 777\n', '钥匙不动')
  a.stop()
  const old = recordingCtx({ [flag]: '2026-09-26T00:36:35.000Z\n' })
  const b = createDirectAnswerSwitch({ ctx: old.ctx, paths, readMeta: async () => whitelist(), intervalMs: 60000, now: () => 9000, signal: old.signal })
  b.start()
  await settle()
  assert.equal(old.flushes.length, 2)
  assert.equal(old.ctx.files[flag], 'v1 hash-a 9000\n')
  b.stop()
  // 面板刚起来、入口本来就不是白名单模式:清一次集合兜底
  const off = recordingCtx()
  const c = createDirectAnswerSwitch({ ctx: off.ctx, paths, readMeta: async () => blacklist, intervalMs: 60000, signal: off.signal })
  c.start()
  await settle()
  assert.equal(off.flushes.length, 2)
  await c.tick()
  assert.equal(off.flushes.length, 2, '之后不再清')
  c.stop()
})

// 内核那一半在 scripts/singbox-tcp-dns-hotfix/openbox_pkg*.go(内核 tcp10 / tcp11):开关文件的环境变量、存档文件名、
// 表 / 集合名、直连侧解析器的 tag、超时区间,两边写的是同一套;服务脚本把开关路径传给内核
test('和内核补丁、服务配置对得上', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const pkg = fs.readFileSync(path.join(root, 'scripts/singbox-tcp-dns-hotfix/openbox_pkg.go'), 'utf8')
  const constOf = (name) => { const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(pkg); return m ? m[1] : null }
  assert.equal(constOf('DirectAnswerFlagEnv'), DIRECT_ANSWER_FLAG_ENV)
  assert.equal(constOf('DirectAnswerStateName'), DIRECT_ANSWER_STATE_NAME)
  assert.equal(constOf('DirectAnswerTable'), 'openbox')
  assert.equal(constOf('DirectAnswerSet4'), DIRECT_ANSWERED_SET[4])
  assert.equal(constOf('DirectAnswerSet6'), DIRECT_ANSWERED_SET[6])
  assert.equal(constOf('DirectTransportTag'), 'dns-direct')
  assert.match(pkg, /DirectAnswerMinTimeout\s*=\s*15 \* time\.Minute/)
  assert.match(pkg, /DirectAnswerMaxTimeout\s*=\s*24 \* time\.Hour/)
  const initd = fs.readFileSync(path.join(root, 'openwrt/initd/openbox'), 'utf8')
  assert.match(initd, new RegExp(`procd_set_param env ${DIRECT_ANSWER_FLAG_ENV}="\\$DATA/flip/direct-answer\\.on"`))
  const unit = fs.readFileSync(path.join(root, 'debian/systemd/openbox.service'), 'utf8')
  assert.match(unit, new RegExp(`^Environment=${DIRECT_ANSWER_FLAG_ENV}=${directAnswerFlagPath(paths).replace(/\./g, '\\.')}$`, 'm'))
  const versions = fs.readFileSync(path.join(root, 'scripts/singbox-tcp-dns-hotfix/versions.sh'), 'utf8')
  const tcp = Number((/openbox-tcp(\d+)/.exec(versions) || [])[1])
  assert.ok(tcp >= 11, `内核版本要带 tcp11 起的补丁(存档、一天上限),现在是 tcp${tcp}`)
})

// 补清的时刻要落在「内核重载规则之前发出去的直连查询」都回来(或超时)之后:DNS 超时之外还要留出内核重载比面板慢的余量
test('补清一遍的间隔比内核 DNS 超时多留 5 秒以上', () => {
  assert.equal(KERNEL_DNS_TIMEOUT_MS, 10_000)
  assert.ok(DIRECT_ANSWER_REPEAT_MS - KERNEL_DNS_TIMEOUT_MS >= 5_000, `现在只多 ${DIRECT_ANSWER_REPEAT_MS - KERNEL_DNS_TIMEOUT_MS} 毫秒`)
})

// 翻面之前发出去的直连查询,应答在换钥匙之后才回来,也会按新钥匙写进去(审查第五项):隔 repeatMs 再换一遍、清一遍
test('换钥匙之后隔一会儿再换一遍、清一遍;离开白名单模式就不补了;stop 等正在进行的那次做完', async () => {
  const { ctx, flushes, hups, signal } = recordingCtx()
  let meta = whitelist()
  let clock = 1000
  const logs = []
  const sw = createDirectAnswerSwitch({ ctx, paths, readMeta: async () => meta, log: (m) => logs.push(m), intervalMs: 60000, now: () => clock, signal, repeatMs: 10_000 })
  sw.start()
  await settle()
  clock = 3000
  meta = whitelist({ Speed: 'proxy' })
  await sw.tick()
  assert.equal(flushes.length, 2)
  assert.equal(ctx.files[flag], 'v1 hash-a 3000\n')
  // 还没到时候:不补
  clock = 9000
  await sw.tick()
  assert.equal(flushes.length, 2)
  // 到了:再换一把钥匙、清一遍、清一遍 dnsmasq 缓存,只补这一次
  clock = 13_000
  await sw.tick()
  assert.equal(flushes.length, 4)
  assert.ok(flushes.slice(2).every((f) => f.key === 'v1 hash-a 13000\n'))
  assert.equal(hups.length, 2)
  assert.ok(logs.some((l) => l.includes('再换一遍钥匙')))
  clock = 30_000
  await sw.tick()
  assert.equal(flushes.length, 4, '补过一次就不再补')
  // 翻面后马上离开白名单模式:补的那次取消
  meta = whitelist({ Speed: 'proxy', Google: 'direct' })
  await sw.tick()
  meta = whitelist({ Speed: 'proxy' })
  clock = 31_000
  await sw.tick()
  const before = flushes.length
  meta = blacklist
  await sw.tick()
  meta = whitelist({ Speed: 'proxy' })
  clock = 60_000
  await sw.tick()
  await sw.tick()
  assert.equal(flushes.length, before + 2, '只有离开时那一次清空')
  // stop 返回正在进行的那次
  meta = whitelist({ Speed: 'direct', Google: 'proxy' })
  const pending = sw.tick()
  const stopped = sw.stop()
  await stopped
  await pending
  assert.equal(typeof stopped.then, 'function')
})
