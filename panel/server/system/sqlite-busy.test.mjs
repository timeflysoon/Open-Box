import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { isSqliteBusy, retryBusy } from './sqlite-busy.mjs'

const busy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' })

test('认得出锁冲突:BUSY / LOCKED(含扩展码)和报错原文;别的 sqlite 错误不算', () => {
  assert.equal(isSqliteBusy(busy()), true)
  assert.equal(isSqliteBusy({ errcode: 517 }), true, 'SQLITE_BUSY_SNAPSHOT 的低 8 位是 5')
  assert.equal(isSqliteBusy({ errcode: 6 }), true)
  assert.equal(isSqliteBusy(new Error('database table is locked')), true)
  assert.equal(isSqliteBusy({ errcode: 19, message: 'UNIQUE constraint failed' }), false)
  assert.equal(isSqliteBusy(null), false)
})

test('锁冲突按间隔重试到成功;别的错误立刻抛出,不重试', () => {
  let calls = 0
  const sleeps = []
  const fn = retryBusy(() => { calls += 1; if (calls < 3) throw busy(); return 'ok' }, { sleep: (ms) => sleeps.push(ms) })
  assert.equal(fn(), 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [200, 200])
  let other = 0
  const failing = retryBusy(() => { other += 1; throw new Error('no such table: app_storage') }, { sleep: () => assert.fail('不该重试') })
  assert.throws(failing, /no such table/)
  assert.equal(other, 1)
})

test('一直被占着就重试到期限为止,再把锁冲突原样抛出', () => {
  let t = 0
  let calls = 0
  const fn = retryBusy(() => { calls += 1; throw busy() }, { waitMs: 1000, intervalMs: 300, now: () => t, sleep: (ms) => { t += ms } })
  assert.throws(fn, (err) => err.errcode === 5)
  assert.equal(calls, 5, '0 / 300 / 600 / 900 / 1200 各试一次,过了期限就停')
})

test('真实的两个进程:对方占着写锁 1.5 秒,这边不让 sqlite 自己等也能靠重试写进去(#535)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-busy-'))
  const file = path.join(dir, 'db.sqlite')
  try {
    const setup = new DatabaseSync(file)
    setup.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)')
    setup.close()
    const holder = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(${JSON.stringify(file)})
      db.exec('BEGIN IMMEDIATE')
      db.exec("INSERT INTO kv VALUES ('holder', '1')")
      process.stdout.write('locked\\n')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
      db.exec('COMMIT')
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise((resolve) => holder.stdout.once('data', resolve))
    const db = new DatabaseSync(file, { timeout: 0 })
    const set = db.prepare('INSERT INTO kv VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    assert.throws(() => set.run('deploy', 'x'), (err) => isSqliteBusy(err), '不重试的话第一下就是 database is locked')
    const started = Date.now()
    retryBusy((k, v) => set.run(k, v), { waitMs: 10_000, intervalMs: 50 })('deploy', 'running')
    assert.ok(Date.now() - started >= 500, '要等对方提交之后才写得进去')
    await new Promise((resolve) => holder.once('exit', resolve))
    assert.deepEqual(db.prepare('SELECT k, v FROM kv ORDER BY k').all().map((r) => [r.k, r.v]), [['deploy', 'running'], ['holder', '1']])
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
