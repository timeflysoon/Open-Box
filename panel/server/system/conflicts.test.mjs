import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { detectDnsHolders, detectConflicts, conflictMessage, CONFLICT_SERVICES, PROCESS_ARGS_SCRIPT } from './conflicts.mjs'

test('清单覆盖六个已知插件', () => {
  assert.deepEqual(CONFLICT_SERVICES.map((s) => s.id).sort(),
    ['homeproxy', 'nikki', 'openclash', 'passwall', 'passwall2', 'shadowsocksr'])
  for (const s of CONFLICT_SERVICES) assert.ok(s.initd.startsWith('/etc/init.d/'))
})

test('未安装 → 无冲突', async () => {
  const ctx = createMockContext()
  const r = await detectConflicts(ctx)
  assert.equal(r.hasRunning, false)
  assert.deepEqual(r.conflicts, [])
})

test('装了但没运行 → 不算冲突', async () => {
  const ctx = createMockContext({
    files: { '/etc/init.d/openclash': '#!/bin/sh' },
    execResults: { '/etc/init.d/openclash status': { code: 1, stdout: 'inactive' } },
  })
  const r = await detectConflicts(ctx)
  assert.equal(r.hasRunning, false)
})

test('运行中 → 报冲突并带 label', async () => {
  const ctx = createMockContext({
    files: { '/etc/init.d/openclash': '#!/bin/sh', '/etc/init.d/nikki': '#!/bin/sh' },
    execResults: {
      '/etc/init.d/openclash status': { code: 0, stdout: 'running' },
      '/etc/init.d/nikki status': { code: 1, stdout: '' },
    },
  })
  const r = await detectConflicts(ctx)
  assert.equal(r.hasRunning, true)
  assert.deepEqual(r.conflicts.map((c) => c.id), ['openclash'])
  assert.equal(r.conflicts[0].label, 'OpenClash')
})

// GitHub #426:PassWall 的 init 脚本不是 procd 的,status 认不出它在跑;它起的 sing-box / xray 都在 /tmp/etc/passwall 下
test('init 脚本说没在跑,但进程在 → 也算冲突(PassWall 这类自己起进程的插件,#426)', async () => {
  // 每个参数一行(/proc/*/cmdline 的 \0 换成换行)
  const args = [
    '/sbin/procd',
    '/tmp/etc/passwall/bin/sing-box', 'run', '-c', '/tmp/etc/passwall/haproxy_ewQxI7zB_2001.json',
    '/opt/open-box/bin/sing-box', 'run', '-c', '/opt/open-box/etc/config.json', '-D', '/opt/open-box/data',
  ].join('\n')
  const ctx = createMockContext({
    files: { '/etc/init.d/passwall': '#!/bin/sh', '/etc/init.d/passwall2': '#!/bin/sh', '/etc/init.d/openclash': '#!/bin/sh' },
    execResults: {
      '/etc/init.d/passwall status': { code: 1, stdout: 'Syntax: /etc/init.d/passwall [command]' },
      '/etc/init.d/passwall2 status': { code: 1, stdout: '' },
      '/etc/init.d/openclash status': { code: 1, stdout: '' },
      [`sh -c ${PROCESS_ARGS_SCRIPT}`]: { code: 0, stdout: args },
    },
  })
  const r = await detectConflicts(ctx)
  assert.equal(r.hasRunning, true)
  assert.deepEqual(r.conflicts.map((c) => c.id), ['passwall'], 'passwall2 / openclash 的进程不在;Open-Box 自己的 sing-box 不算')
  assert.equal(ctx.calls.filter((c) => c.cmd === 'sh').length, 1, '进程表只读一次')
  // 只装着、进程也不在:不算
  const idle = createMockContext({
    files: { '/etc/init.d/passwall': '#!/bin/sh' },
    execResults: { '/etc/init.d/passwall status': { code: 1, stdout: '' }, [`sh -c ${PROCESS_ARGS_SCRIPT}`]: { code: 0, stdout: '/sbin/procd\n/usr/sbin/dnsmasq' } },
  })
  assert.equal((await detectConflicts(idle)).hasRunning, false)
})

test('只认插件的运行目录:关着时它的界面 / 定时任务临时跑的脚本(/usr/share/passwall)不算;旧版的 /var/etc 也认', () => {
  const passwall = CONFLICT_SERVICES.find((s) => s.id === 'passwall')
  assert.ok(passwall.process.test('/tmp/etc/passwall/bin/xray'))
  assert.ok(passwall.process.test('/var/etc/passwall/haproxy.cfg'))
  assert.ok(!passwall.process.test('/usr/share/passwall/subscribe.lua'))
  assert.ok(!passwall.process.test('/tmp/etc/passwall2/bin/xray'), 'PassWall2 归 PassWall2')
  assert.ok(CONFLICT_SERVICES.find((s) => s.id === 'passwall2').process.test('/tmp/etc/passwall2/bin/xray'))
  assert.ok(CONFLICT_SERVICES.find((s) => s.id === 'homeproxy').process.test('/var/run/homeproxy/sing-box-c.json'))
  assert.ok(CONFLICT_SERVICES.find((s) => s.id === 'shadowsocksr').process.test('/var/etc/ssrplus/tcp-only-ssr-retcp.json'))
  assert.ok(!CONFLICT_SERVICES.some((s) => s.process.test('/opt/open-box/bin/sing-box')), 'Open-Box 自己不算')
})

test('拒绝启动的提示:是哪个工具、为什么、怎么办', () => {
  assert.equal(
    conflictMessage([{ label: 'PassWall' }, { label: 'OpenClash' }]),
    '检测到 PassWall、OpenClash 正在运行。同一台路由器上不能同时运行两个代理工具,会互相冲突,Open-Box 不启动内核。请先停用 PassWall、OpenClash(关掉它的主开关或卸载)再启动。',
  )
})

test('谁占着 53:认出 AdGuard Home 这类抢 DNS 的东西,dnsmasq / sing-box 是自己人不算(GitHub #200)', async () => {
  const netstat = [
    'Active Internet connections (only servers)',
    'udp        0      0 0.0.0.0:53              0.0.0.0:*                           2531/AdGuardHome',
    'tcp        0      0 127.0.0.1:53            0.0.0.0:*               LISTEN      1102/dnsmasq',
    'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      900/dropbear',
  ].join('\n')
  const ctx = { exec: async (cmd) => (cmd === 'ss' ? { code: 1, stdout: '', stderr: 'not found' } : { code: 0, stdout: netstat, stderr: '' }) }
  const holders = await detectDnsHolders(ctx)
  assert.deepEqual(holders.map((h) => h.process), ['AdGuardHome'], 'dnsmasq 是自己人;22 端口的不算')

  // ss 的写法不一样:users:(("AdGuardHome",pid=2531,fd=7))
  const ssOut = 'udp   UNCONN 0  0   0.0.0.0:53   0.0.0.0:*    users:(("AdGuardHome",pid=2531,fd=7))'
  const ssCtx = { exec: async (cmd) => (cmd === 'ss' ? { code: 0, stdout: ssOut, stderr: '' } : { code: 0, stdout: '', stderr: '' }) }
  assert.deepEqual((await detectDnsHolders(ssCtx)).map((h) => h.process), ['AdGuardHome'])

  // 两个命令都没有时不能炸,返回空
  assert.deepEqual(await detectDnsHolders({ exec: async () => { throw new Error('no such command') } }), [])
})
