import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dnsmasqDaemons, signalDnsmasq } from './dnsmasq-signal.mjs'

// 假的 /proc:OpenWrt 上叫 dnsmasq 的进程有三种——ujail 外壳、正在跑的 /etc/init.d/dnsmasq 脚本、真正的 dnsmasq
const fakeProc = (t, uptime, procs) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'uptime'), `${uptime} 1000.00\n`)
  fs.mkdirSync(path.join(root, 'self'))
  for (const [pid, { comm, exe, startTicks }] of Object.entries(procs)) {
    const dir = path.join(root, pid)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'comm'), `${comm}\n`)
    fs.symlinkSync(exe, path.join(dir, 'exe'))
    // 第 22 项 starttime;进程名故意带空格和括号
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm} (x)) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 ${startTicks} 3000000 100\n`)
  }
  return root
}

test('only the real dnsmasq binary is signalled; the ujail wrapper and a running init script are left alone', (t) => {
  const root = fakeProc(t, 500, {
    10: { comm: 'dnsmasq', exe: '/sbin/ujail', startTicks: 1000 },
    11: { comm: 'dnsmasq', exe: '/usr/sbin/dnsmasq', startTicks: 1000 },
    12: { comm: 'dnsmasq', exe: '/bin/busybox', startTicks: 49990 },
    13: { comm: 'dnsmasq', exe: '/usr/sbin/dnsmasq', startTicks: 49950 },
    14: { comm: 'sing-box', exe: '/opt/open-box/bin/sing-box', startTicks: 1000 },
  })
  assert.deepEqual(dnsmasqDaemons({ procRoot: root }).map((d) => [d.pid, Math.round(d.ageMs)]).sort((a, b) => a[0] - b[0]), [[11, 490000], [13, 500]])
  const sent = []
  const kill = (pid, sig) => sent.push([pid, sig])
  assert.deepEqual(signalDnsmasq('SIGHUP', { procRoot: root, kill, minAgeMs: 2000 }), { found: 2, sent: 1, young: 1 }, '刚起来半秒的先不发')
  assert.deepEqual(sent, [[11, 'SIGHUP']])
  sent.length = 0
  assert.deepEqual(signalDnsmasq('SIGUSR2', { procRoot: root, kill }), { found: 2, sent: 2, young: 0 })
  assert.deepEqual(sent.map((x) => x[0]).sort(), [11, 13])
})

test('no /proc (not Linux) or no dnsmasq: nothing found, nothing sent', (t) => {
  assert.deepEqual(signalDnsmasq('SIGHUP', { procRoot: path.join(os.tmpdir(), 'ob-no-such-proc'), kill: () => assert.fail('不该发') }), { found: 0, sent: 0, young: 0 })
  const root = fakeProc(t, 100, { 20: { comm: 'odhcpd', exe: '/usr/sbin/odhcpd', startTicks: 10 } })
  assert.deepEqual(signalDnsmasq('SIGHUP', { procRoot: root, kill: () => assert.fail('不该发') }), { found: 0, sent: 0, young: 0 })
})
