// 命令行 open-box 和 LuCI 页面的「启动 / 重启内核」要和面板里点的一样走 cli/deploy.mjs(生成配置 → 启动 → 起不来自动
// 降级纯 tun),不能直接调 init 脚本:全新安装没有配置时什么都起不来却提示「已发送」(GitHub #299),auto_redirect
// 起不来的设备也不降级(#290)。脚本是装在 /opt/open-box 的,测试复制一份、把路径换成临时目录,Node 换成假的
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CLI = path.join(repo, 'openwrt/bin/open-box')
const LUCI = path.join(repo, 'openwrt/luci/htdocs/luci-static/resources/view/openbox/main.js')

const setup = ({ exitCode = 0, result = '{"ok":true,"stage":"running","message":"","badTags":[]}', sleep = 0 } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-cli-start-'))
  const root = path.join(dir, 'root')
  const calls = path.join(dir, 'calls')
  for (const d of ['node/bin', 'panel/server/cli', 'data', 'debian/bin']) fs.mkdirSync(path.join(root, d), { recursive: true })
  fs.writeFileSync(path.join(root, 'panel/server/cli/deploy.mjs'), '')
  // 假 Node:记下参数和部署要的两个环境变量,像 cli/deploy.mjs 一样先打日志、最后一行打结果 JSON
  fs.writeFileSync(path.join(root, 'node/bin/node'), `#!/bin/sh
echo "node $*|$OPENBOX_ROOT|$ZASHBOARD_DB_PATH" >> "${calls}"
${sleep ? `sleep ${sleep}` : ''}
echo "[deploy] 完成"
echo '${result}'
exit ${exitCode}
`, { mode: 0o755 })
  // 服务脚本(Debian 那种 *-ctl):记下调了什么动作
  for (const svc of ['openbox', 'openbox-panel']) {
    fs.writeFileSync(path.join(root, `debian/bin/${svc}-ctl`), `#!/bin/sh\necho "${svc} $1" >> "${calls}"\n`, { mode: 0o755 })
  }
  const script = path.join(dir, 'open-box')
  fs.writeFileSync(script, fs.readFileSync(CLI, 'utf8')
    .replace(/^ROOT=\/opt\/open-box$/m, `ROOT=${root}`)
    .replace(/^DEPLOY_STATUS=.*$/m, `DEPLOY_STATUS=${path.join(dir, 'status')}`)
    .replace(/^DEPLOY_LOG=.*$/m, `DEPLOY_LOG=${path.join(dir, 'log')}`), { mode: 0o755 })
  const run = (...args) => spawnSync('sh', [script, ...args], { encoding: 'utf8' })
  const readCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [])
  return { dir, root, run, readCalls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('open-box start:用随包 Node 跑 cli/deploy.mjs(带 OPENBOX_ROOT / 数据库),成功打一行结论,降级的提示一并打出来', (t) => {
  const s = setup({ result: '{"ok":true,"stage":"running","message":"","warning":"已改用纯 tun 模式","badTags":[]}' })
  t.after(s.cleanup)
  const r = s.run('start')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /openbox: 已生成配置并启动/)
  assert.match(r.stdout, /已改用纯 tun 模式/)
  assert.deepEqual(s.readCalls(), [`node --no-warnings ${s.root}/panel/server/cli/deploy.mjs|${s.root}|${s.root}/data/openbox.sqlite`])
})

test('open-box start:部署失败时退出码非 0,把原因带出来', (t) => {
  const s = setup({ exitCode: 1, result: '{"ok":false,"stage":"verify","message":"内核启动后崩溃,已恢复直连"}' })
  t.after(s.cleanup)
  const r = s.run('start')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /openbox: 启动失败:内核启动后崩溃,已恢复直连/)
})

test('open-box restart:内核走部署(不再直接调 init 的 restart),面板照旧重启服务', (t) => {
  const s = setup()
  t.after(s.cleanup)
  const r = s.run('restart')
  assert.equal(r.status, 0)
  const calls = s.readCalls()
  assert.ok(calls.some((c) => c.startsWith('node --no-warnings') && c.includes('cli/deploy.mjs')), calls.join('\n'))
  assert.ok(!calls.includes('openbox restart'), '内核不能再走 init restart')
  assert.ok(calls.includes('openbox-panel restart'))
  assert.match(r.stdout, /openbox-panel: 已重启/)
})

test('open-box start --detach:立刻返回,状态先是 running,后台跑完换成结果 JSON;--status 打出来', async (t) => {
  const s = setup({ sleep: 1 })
  t.after(s.cleanup)
  const r = s.run('start', '--detach')
  assert.equal(r.status, 0)
  assert.equal(s.run('start', '--status').stdout.trim(), 'running')
  let status = ''
  for (let i = 0; i < 50; i++) {
    status = s.run('start', '--status').stdout.trim()
    if (status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.deepEqual(JSON.parse(status), { ok: true, stage: 'running', message: '', badTags: [] })
})

test('LuCI 页面:内核卡片的启动 / 重启调 open-box start --detach 再轮询 --status;面板卡片照旧走 init', () => {
  const src = fs.readFileSync(LUCI, 'utf8')
  assert.match(src, /fs\.exec\(CLI_PATH, \[ 'start', '--detach' \]\)/)
  assert.match(src, /fs\.exec\(CLI_PATH, \[ 'start', '--status' \]\)/)
  assert.match(src, /name === 'openbox' \? deployCore\(\) : act\(name, action\)/)
})
