import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ACCESS_PASSWORD_KEY, parseStoredString, readAccessPassword } from './access-password-cli.mjs'

const script = fileURLToPath(new URL('./access-password-cli.mjs', import.meta.url))
const cli = fileURLToPath(new URL('../../../openwrt/bin/open-box', import.meta.url))

const makeDb = (dir, value) => {
  const file = path.join(dir, 'openbox.sqlite')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE app_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  if (value !== undefined) db.prepare('INSERT INTO app_storage(key, value) VALUES(?, ?)').run(ACCESS_PASSWORD_KEY, value)
  db.close()
  return file
}

test('parseStoredString:前端存的是带引号的 JSON 字符串;裸字符串原样;空 / 非字符串是空', () => {
  assert.equal(parseStoredString('"p@ss \\"x\\""'), 'p@ss "x"')
  assert.equal(parseStoredString('plain'), 'plain')
  assert.equal(parseStoredString(''), '')
  assert.equal(parseStoredString(null), '')
})

test('读面板密码:只读打开数据库,读出 config/access-password;没设置过是空;数据库不在就报错;读的过程不改库', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-pw-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = makeDb(dir, JSON.stringify('中文 密码-123'))
  const before = fs.readFileSync(file)
  assert.equal(await readAccessPassword(file), '中文 密码-123')
  assert.deepEqual(fs.readFileSync(file), before, '只读:文件一个字节没动')
  assert.deepEqual(fs.readdirSync(dir), ['openbox.sqlite'], '没有留下 -wal / -journal 之类的旁路文件')
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-pw-empty-'))
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }))
  assert.equal(await readAccessPassword(makeDb(empty)), '')
  await assert.rejects(readAccessPassword(path.join(dir, 'nope.sqlite')), /数据库不存在/)
})

test('作为脚本运行(open-box password 调的就是它):退出码 0 + 密码 / 3 = 还没设置 / 1 = 读不了', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-pw-cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = makeDb(dir, JSON.stringify('abcd1234'))
  assert.equal(execFileSync(process.execPath, ['--no-warnings', script, file], { encoding: 'utf8' }), 'abcd1234\n')
  const unsetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-pw-unset-'))
  t.after(() => fs.rmSync(unsetDir, { recursive: true, force: true }))
  const unset = spawnSync(process.execPath, ['--no-warnings', script, makeDb(unsetDir)], { encoding: 'utf8' })
  assert.equal(unset.status, 3)
  assert.equal(unset.stdout, '')
  const missing = spawnSync(process.execPath, ['--no-warnings', script, path.join(dir, 'nope.sqlite')], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /数据库不存在/)
})

test('命令行 open-box:语法过 sh -n;--help 给出用法;未知命令退出码 2;check 在读不到 meta.json 时也给出三行、status=unknown', () => {
  execFileSync('sh', ['-n', cli])
  const help = execFileSync('sh', [cli, '--help'], { encoding: 'utf8' })
  for (const sub of ['password', 'restart', 'check', 'update', 'uninstall']) {
    assert.match(help, new RegExp(`open-box\\s+${sub}`), `--help 要列出 ${sub}`)
  }
  const bad = spawnSync('sh', [cli, 'nonsense'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
  // 菜单五行,顺序是用户定的:1 当前密码 / 2 重新启动 / 3 检查升级 / 4 卸载 / 5 退出
  const menu = spawnSync('sh', [cli], { input: '9\n5\n', encoding: 'utf8' })
  assert.equal(menu.status, 0)
  assert.match(menu.stdout, /1\) 当前密码[\s\S]*2\) 重新启动[\s\S]*3\) 检查升级[\s\S]*4\) 卸载[\s\S]*5\) 退出/)
  assert.match(menu.stdout, /请输入 1 到 5/)
  assert.equal(spawnSync('sh', [cli], { input: '', encoding: 'utf8' }).status, 0)
})

test('命令行 open-box:卸载在菜单里要先确认;答 n 不动手;两条新子命令在脚本缺失时报错退出而不是沉默', () => {
  // 这台 mac 上 /opt/open-box 不存在,cmd_uninstall 应当报"找不到卸载脚本"并以非 0 退出
  const noScript = spawnSync('sh', [cli, 'uninstall'], { encoding: 'utf8' })
  assert.notEqual(noScript.status, 0)
  assert.match(noScript.stderr, /找不到卸载脚本/)
  // 菜单里选 4 再答 n:只提示不执行,然后能继续回到菜单并正常退出
  const declined = spawnSync('sh', [cli], { input: '4\nn\n5\n', encoding: 'utf8' })
  assert.equal(declined.status, 0)
  assert.match(declined.stdout, /确定卸载吗/)
  assert.match(declined.stdout, /没有卸载/)
  assert.doesNotMatch(declined.stderr, /找不到卸载脚本/, '答 n 不该真去调卸载脚本')
  // restart:两个 init 脚本在 mac 上都不存在,应逐个说"没有这个服务"而不是崩掉
  const restart = spawnSync('sh', [cli, 'restart'], { encoding: 'utf8' })
  assert.equal(restart.status, 0)
  assert.match(restart.stdout, /openbox: 没有这个服务/)
  assert.match(restart.stdout, /openbox-panel: 没有这个服务/)
})
