import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { detectDnsHolders, detectConflicts, CONFLICT_SERVICES } from './conflicts.mjs'

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
