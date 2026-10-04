import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PANEL_PORT_FALLBACK, panelPort } from './panel-port.mjs'

// 面板端口从 v0.1.217 起可改:装机时能选(install.sh)、装完能在 LuCI 页面或 open-box port 改。
// 这组用例守住三件事:后端各处用的是"真实监听端口"而不是写死的 2026;shell 那份冲突检测
// (install.sh 和 open-box 各存一份拷贝)逐字一致;open-box port 的行为符合页面的预期。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = path.join(repoRoot, 'openwrt/bin/open-box')
const installSh = path.join(repoRoot, 'scripts/install.sh')
const initd = path.join(repoRoot, 'openwrt/initd/openbox-panel')

// 注意:要 await 到 fn 真正跑完再还原,不能 try { return fn() } finally —— 那样 finally 在
// promise 刚返回时就执行了,异步 import 里读到的已经是还原后的值(第一版就栽在这)。
const withEnvPort = async (value, fn) => {
  const had = Object.hasOwn(process.env, 'PORT')
  const old = process.env.PORT
  if (value === undefined) delete process.env.PORT
  else process.env.PORT = value
  try { return await fn() } finally {
    if (had) process.env.PORT = old
    else delete process.env.PORT
  }
}

test('panelPort():读 PORT 环境变量;没有 / 不合法时退回 2026(老机器没有端口文件,必须继续用 2026)', async () => {
  assert.equal(PANEL_PORT_FALLBACK, 2026)
  assert.equal(await withEnvPort(undefined, panelPort), 2026)
  assert.equal(await withEnvPort('', panelPort), 2026)
  assert.equal(await withEnvPort('不是数字', panelPort), 2026)
  assert.equal(await withEnvPort('0', panelPort), 2026)
  assert.equal(await withEnvPort('65536', panelPort), 2026)
  assert.equal(await withEnvPort('3036', panelPort), 3036)
})

test('防火墙放行规则和共享网络的保留端口都跟着真实端口走,不写死 2026', async () => {
  // 两个模块在 import 时就会读 PORT(RESERVED_PORTS 是常量集合),所以用带 query 的动态 import
  // 各要一份全新的模块实例。
  const fresh = (rel) => import(`${rel}?p=${Math.random()}`)
  await withEnvPort('3036', async () => {
    const { RESERVED_PORTS } = await fresh('../engine/servers.mjs')
    assert.ok(RESERVED_PORTS.has(3036), '保留端口里应当是当前面板端口')
    assert.ok(!RESERVED_PORTS.has(2026), '端口改了以后 2026 就不该再被保留')
  })
  await withEnvPort('3036', async () => {
    const { applyPanelLanRule } = await fresh('./firewall.mjs')
    const calls = []
    const ctx = { exec: async (...a) => { calls.push(a.flat().join(' ')); return { stdout: '' } } }
    await applyPanelLanRule(ctx, { commit: false })
    assert.ok(calls.some((c) => c.includes('dest_port=3036')), `放行规则应写 3036:${calls.join(' | ')}`)
  })
})

test('init 脚本从 data/panel-port 取端口,文件不在就用 2026', () => {
  const text = fs.readFileSync(initd, 'utf8')
  assert.match(text, /panel_port=\$\(cat "\$DATA\/panel-port"/, 'PORT 应当来自 data/panel-port')
  assert.match(text, /\[ -n "\$panel_port" \] \|\| panel_port=2026/, '读不到时必须退回 2026')
  assert.match(text, /PORT="\$panel_port"/, '环境变量 PORT 要用读出来的值')
})

// install.sh 是单独 curl 下来先跑的(那会儿包还没解开),没法和 open-box 共用文件,
// 只能各存一份拷贝 —— 那就把"两份必须一模一样"钉死在测试里。
test('端口冲突检测那段:install.sh 与 open-box 两份拷贝逐字一致', () => {
  const grab = (file) => {
    const text = fs.readFileSync(file, 'utf8')
    const a = text.indexOf('# ---- openbox-port-check:start ----')
    const b = text.indexOf('# ---- openbox-port-check:end ----')
    assert.ok(a !== -1 && b > a, `${path.basename(file)} 里找不到端口检测块`)
    return text.slice(a, b)
  }
  assert.equal(grab(installSh), grab(cli), 'install.sh 和 open-box 里的端口检测块不一致,改了一处要同步另一处')
})

test('open-box port:不带参数打印当前端口;--check 挡住保留端口、越界和非数字', () => {
  execFileSync('sh', ['-n', cli])
  const run = (...args) => spawnSync('sh', [cli, 'port', ...args], { encoding: 'utf8' })
  // 本机没有 /opt/open-box/data/panel-port,应当回落到 2026
  assert.equal(run().stdout.trim(), '2026')
  for (const [bad, why] of [['22', 'SSH'], ['9095', '内核 API'], ['7853', 'DNS'], ['80', 'HTTP'], ['100', '越界'], ['70000', '越界'], ['abc', '非数字'], ['', '空']]) {
    const r = run('--check', bad)
    assert.notEqual(r.status, 0, `${bad}(${why})应当被挡下`)
    assert.ok(r.stderr.trim().length > 0, `${bad} 要给出中文原因`)
  }
})

test('open-box port --check:正在监听的端口要被认出来,空闲端口放行', async () => {
  const srv = net.createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const busy = srv.address().port
  try {
    const r = spawnSync('sh', [cli, 'port', '--check', String(busy)], { encoding: 'utf8' })
    // ss / netstat 在这台机器上都没有的话这项检查会被跳过,那就只断言"没有崩"
    // 只有 iproute2 的 ss(OpenWrt / Linux)才保证能这么解析;mac 上的 BSD netstat 没有 -ltn,
    // 检测会被跳过 —— 路由器上的实际效果另外在真机验证。
    const hasSs = spawnSync('sh', ['-c', 'command -v ss'], { encoding: 'utf8' }).status === 0
    if (hasSs) {
      assert.notEqual(r.status, 0, `${busy} 正在被监听,应当被挡下`)
      assert.match(r.stderr, /占用/)
    }
  } finally {
    await new Promise((r) => srv.close(r))
  }
  // 关掉之后同一个端口就该放行了
  const ok = spawnSync('sh', [cli, 'port', '--check', String(busy)], { encoding: 'utf8' })
  assert.equal(ok.status, 0, `端口释放后应当放行:${ok.stderr}`)
})

test('install.sh:--port 会当场校验(挡下保留端口),用法里也写明了这个参数', () => {
  execFileSync('sh', ['-n', installSh])
  assert.match(fs.readFileSync(installSh, 'utf8'), /--port 3036/, '--help 用法里要有 --port')
  const r = spawnSync('sh', [installSh, '--port', '22'], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr + r.stdout, /面板端口不能用/)
})

test('install.sh 写端口文件、结尾地址用的是选定端口(不再是写死的 2026)', () => {
  const text = fs.readFileSync(installSh, 'utf8')
  assert.match(text, /printf '%s\\n' "\$PANEL_PORT" > "\$INSTALL_ROOT\/data\/panel-port"/, '要把端口落盘给 init 脚本读')
  assert.match(text, /PANEL_URL="http:\/\/\$LAN_IP:\$PANEL_PORT"/, '完成提示里的地址要用实际端口')
  assert.ok(!/:2026"/.test(text.replace(/^#.*$/gm, '')), '非注释处不该再出现写死的 :2026')
})

test('open-box:新装默认 3036,而回落值仍是 2026(老机器升级不能被搬家)', () => {
  const text = fs.readFileSync(cli, 'utf8')
  assert.match(text, /OPENBOX_PORT_DEFAULT=3036/)
  assert.match(text, /OPENBOX_PORT_FALLBACK=2026/)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-port-'))
  fs.writeFileSync(path.join(tmp, 'panel-port'), '4123\n')
  // 把端口文件指到临时目录,验证"有文件就用文件里的值"
  const patched = path.join(tmp, 'open-box')
  fs.writeFileSync(patched, fs.readFileSync(cli, 'utf8').replace('OPENBOX_PORT_FILE=/opt/open-box/data/panel-port', `OPENBOX_PORT_FILE=${tmp}/panel-port`))
  assert.equal(spawnSync('sh', [patched, 'port'], { encoding: 'utf8' }).stdout.trim(), '4123')
})
