import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// install.sh / update.sh / uninstall.sh 是三个各自单独 curl 下来跑的脚本,没法共用文件,
// 只能把公共逻辑各存一份拷贝。这里做两件事:
//   1. 钉死"几份拷贝必须逐字相同"(改了一处忘了另一处,真机上就是装到一半才炸);
//   2. 把公共块单独抽出来跑,验证它本身的行为。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPTS = {
  'install.sh': fs.readFileSync(path.join(repoRoot, 'scripts/install.sh'), 'utf8'),
  'update.sh': fs.readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8'),
  'uninstall.sh': fs.readFileSync(path.join(repoRoot, 'scripts/uninstall.sh'), 'utf8'),
}

const block = (text, name) => {
  const a = text.indexOf(`# ---- ${name}:start ----`)
  const b = text.indexOf(`# ---- ${name}:end ----`)
  return a === -1 || b < a ? null : text.slice(a, b)
}

test('临时目录挑选块:install / update / uninstall 三份逐字一致', () => {
  const copies = Object.entries(SCRIPTS).map(([f, t]) => {
    const got = block(t, 'openbox-tmp-parent')
    assert.ok(got, `${f} 里找不到 openbox-tmp-parent 块`)
    return [f, got]
  })
  for (const [f, got] of copies.slice(1)) {
    assert.equal(got, copies[0][1], `${f} 与 ${copies[0][0]} 里的临时目录块不一致`)
  }
})

test('环境自检块:install / update / uninstall 三份逐字一致', () => {
  const copies = Object.entries(SCRIPTS).map(([f, t]) => {
    const got = block(t, 'openbox-env-report')
    assert.ok(got, `${f} 里找不到 openbox-env-report 块`)
    return [f, got]
  })
  for (const [f, got] of copies.slice(1)) {
    assert.equal(got, copies[0][1], `${f} 与 ${copies[0][0]} 里的环境自检块不一致`)
  }
  // 每个脚本都要在"真正开工"的地方把它打开,并且 die 的时候调用
  for (const [f, t] of Object.entries(SCRIPTS)) {
    assert.match(t, /^ENV_REPORT_ON=1$/m, `${f} 没有在开工处打开环境自检`)
    const die = t.slice(t.indexOf('die() {'), t.indexOf('die() {') + 400)
    assert.match(die, /openbox_env_report/, `${f} 的 die() 要打环境信息`)
  }
})

test('环境自检:把排查装不上真正要看的东西都打出来(#191 只给一句「无法创建临时目录」,查了好几轮)', () => {
  const src = block(SCRIPTS['install.sh'], 'openbox-env-report')
  for (const [needle, why] of [
    ['DISTRIB_DESCRIPTION', '固件版本'],
    ['uname -r', '内核版本'],
    ['/proc/mounts', '所在文件系统和 ro/rw 挂载参数'],
    ['df -Pk', '可用空间'],
    ['ls -ld', '目录属性'],
    ['可写检查', '逐个候选临时目录的真实 mkdir 结果'],
    ['MemAvailable', '可用内存'],
    ['缺少的命令', '缺哪些命令'],
  ]) {
    assert.ok(src.includes(needle), `环境自检里缺少${why}(${needle})`)
  }
  assert.match(src, /\[ "\$\{ENV_REPORT_ON:-0\}" = "1" \] \|\| return 0/, '参数用错那种失败不该打环境信息')
})

test('端口检测块:install.sh 与 open-box 两份逐字一致(open-box 那份由 panel-port.test.mjs 覆盖,这里再确认块还在)', () => {
  assert.ok(block(SCRIPTS['install.sh'], 'openbox-port-check'), 'install.sh 里的端口检测块不见了')
})

// 把公共块抽出来单独跑:省得为了测一个函数去跑整个安装流程(第一次就撞上了存储预检)。
const runPicker = (installRoot, env = {}) => {
  const src = block(SCRIPTS['install.sh'], 'openbox-tmp-parent')
  const harness = `#!/bin/sh\nINSTALL_ROOT="${installRoot}"\n${src}\nopenbox_pick_tmp_parent && printf 'ERR=%s\\n' "$openbox_tmp_probe_err"\n`
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-picker-')), 'h.sh')
  fs.writeFileSync(file, harness)
  return spawnSync('sh', [file], { encoding: 'utf8', env: { ...process.env, ...env } })
}

test('临时目录:安装分区能写就用它(下载包上百 MB,不该塞进内存盘)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-tmp-'))
  const r = runPicker(path.join(dir, 'open-box'))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.split('\n')[0], dir, '应当选中安装目录所在的那一层')
})

test('临时目录:安装分区写不了就往下找(iStoreOS 25.12.5 的 /opt 就建不了目录,GitHub #191)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-tmp-'))
  const ro = path.join(dir, 'ro')
  fs.mkdirSync(ro)
  fs.chmodSync(ro, 0o555)
  try {
    const r = runPicker(path.join(ro, 'open-box'))
    assert.equal(r.status, 0, `不该直接失败,应当回退:${r.stderr}`)
    const picked = r.stdout.split('\n')[0]
    assert.notEqual(picked, ro, '不能选中一个写不了的目录')
    assert.ok(['/var/tmp', '/root', '/tmp'].includes(picked), `应当回退到后备位置,实际:${picked}`)
    // 回退目录必须真能创建子目录,不然等于没挑
    const probe = path.join(picked, `.open-box-parity-${process.pid}`)
    fs.mkdirSync(probe)
    fs.rmdirSync(probe)
  } finally {
    fs.chmodSync(ro, 0o755)
  }
})

test('临时目录:OPENBOX_TMPDIR 指定的位置优先(给 /opt 写不了的人留的口子)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-tmp-'))
  const want = path.join(dir, 'mydisk')
  const r = runPicker(path.join(dir, 'open-box'), { OPENBOX_TMPDIR: want })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.split('\n')[0], want, 'OPENBOX_TMPDIR 应当排在最前面(不存在也要先建出来)')
  assert.ok(fs.existsSync(want))
})

test('三个脚本都在 die 时把 stdin 读完(curl | sh 提前退出会让 curl 报 23,真机截图里就是这样)', () => {
  for (const [name, text] of Object.entries(SCRIPTS)) {
    assert.match(text, /drain_stdin\(\) \{/, `${name} 里没有 drain_stdin`)
    assert.match(text, /\[ -t 0 \] && return 0/, `${name} 的 drain_stdin 必须在 stdin 是终端时直接返回,否则交互运行会卡死`)
    const die = text.slice(text.indexOf('die() {'), text.indexOf('die() {') + 400)
    assert.match(die, /drain_stdin/, `${name} 的 die() 要先把 stdin 读完再退出`)
  }
})

test('die 时排空 stdin 必须有时间上限:stdin 是"开着但不来数据"的管道时不能挂死', async () => {
  const src = SCRIPTS['install.sh']
  const fn = src.slice(src.indexOf('drain_stdin() {'), src.indexOf('drain_stdin() {') + 800)
  assert.match(fn, /timeout 3 cat/, '要用 timeout 限住;无限制的 cat 会把脚本挂死(本地实测卡过)')
  // 真跑一次:stdin 接一个一直开着、永远不来数据的管道(node 这边不写也不关),脚本必须自己退出。
  // 不能用 `sleep 30 | sh ...` 来造这个场景 —— 那样 spawnSync 会等整条管道跑完,测的是 sleep 不是脚本。
  const started = Date.now()
  const child = spawn('sh', [path.join(repoRoot, 'scripts/install.sh'), '--nonsense'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  child.stdout.resume()
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, 15000)
    child.on('exit', (c) => { clearTimeout(timer); resolve(c) })
  })
  const elapsed = Date.now() - started
  assert.notEqual(code, null, `stdin 开着不关时脚本挂死了(等了 ${elapsed}ms 还没退)`)
  assert.ok(elapsed < 10000, `排空 stdin 的上限应当是几秒,实际用了 ${elapsed}ms`)
  assert.match(stderr, /未知参数/)
})

test('"请用另一个脚本"的提示必须给出能照抄的完整命令(用户照着敲 install.sh 只会得到 not found)', () => {
  assert.match(
    SCRIPTS['update.sh'],
    /未检测到现有 Open-Box 安装[\s\S]{0,200}curl -fsSL https:\/\/raw\.githubusercontent\.com\/timeflysoon\/Open-Box\/main\/scripts\/install\.sh/,
    'update.sh 在没装过时要给出完整的安装命令',
  )
  assert.match(
    SCRIPTS['install.sh'],
    /已存在且包含完整安装[\s\S]{0,260}curl -fsSL https:\/\/raw\.githubusercontent\.com\/timeflysoon\/Open-Box\/main\/scripts\/update\.sh/,
    'install.sh 在已装过时要给出完整的升级命令',
  )
})

test('glibc Node 块:install / update 两份逐字一致,而且都在 systemd 平台上调用了', () => {
  const copies = ['install.sh', 'update.sh'].map((f) => {
    const got = block(SCRIPTS[f], 'openbox-glibc-node')
    assert.ok(got, `${f} 里找不到 openbox-glibc-node 块`)
    return [f, got]
  })
  assert.equal(copies[1][1], copies[0][1], 'install.sh 与 update.sh 里的 glibc Node 块不一致')
  // 版本跟着 meta.json 的 nodeVersion 走,校验对着官方 SHASUMS256.txt,换完删掉 musl 的 lib/,留 .flavor 标记
  assert.match(copies[0][1], /"nodeVersion"/)
  assert.match(copies[0][1], /SHASUMS256\.txt/)
  assert.match(copies[0][1], /nodejs\.org\/dist/)
  assert.match(copies[0][1], /npmmirror\.com\/mirrors\/node/)
  assert.match(copies[0][1], /rm -rf "\$_gn_root\/node\/lib"/)
  assert.match(copies[0][1], /node\/\.flavor/)
  for (const f of ['install.sh', 'update.sh']) {
    // 升级脚本在暂存目录里换(换入之前,现有安装不动,审查第八项);安装脚本直接在安装目录里换
    const root = f === 'update.sh' ? 'STAGE_DIR' : 'INSTALL_ROOT'
    assert.ok(SCRIPTS[f].includes(`_gn_err=$(openbox_glibc_node "$${root}")`), `${f} 没有调用 openbox_glibc_node`)
    assert.match(SCRIPTS[f], new RegExp(`if \\[ "\\$PLATFORM" = "systemd" \\]; then\\s*\\n\\s*info "Debian \\/ Ubuntu[^\\n]*\\n\\s*if ! _gn_err=\\$\\(openbox_glibc_node "\\$${root}"\\); then`), `${f} 的 glibc Node 步骤要只在 systemd 平台跑`)
  }
  // 三个脚本都要认两种平台
  for (const [f, t] of Object.entries(SCRIPTS)) {
    assert.match(t, /^detect_platform\(\) \{$/m, `${f} 缺 detect_platform`)
    assert.match(t, /^detect_platform$/m, `${f} 没有调用 detect_platform`)
    assert.doesNotMatch(t, /^check_openwrt$/m, `${f} 还在调用已经删掉的 check_openwrt`)
  }
})

test('Node 冒烟测试块:install / update 两份逐字一致,而且都真的调用了(GitHub #145)', () => {
  const copies = ['install.sh', 'update.sh'].map((f) => {
    const got = block(SCRIPTS[f], 'openbox-node-smoke')
    assert.ok(got, `${f} 里找不到 openbox-node-smoke 块`)
    return [f, got]
  })
  assert.equal(copies[1][1], copies[0][1], 'install.sh 与 update.sh 里的 Node 冒烟块不一致')
  // `node -v` 不算:打版本号在解析参数阶段就返回,V8 还没初始化,起不来的机器照样打印版本
  assert.match(copies[0][1], /-e 'process\.stdout\.write\("ok"\)'/, '要真的跑一句脚本,不能只 node -v')
  assert.match(copies[0][1], /LD_LIBRARY_PATH="\$1\/node\/lib"/, '要带上随包的 musl 库路径(被测那份 Node 自己的 node\/lib),否则测的不是实际运行环境')
  // 安装脚本测装好的那份;升级脚本在换入之前测暂存目录里的新 Node(审查第八项)
  for (const [f, call] of [['install.sh', 'if ! _ob_node_err=$(openbox_node_smoke); then'], ['update.sh', 'if ! _ob_node_err=$(openbox_node_smoke "$STAGE_DIR"); then']]) {
    const text = SCRIPTS[f]
    assert.ok(text.includes(call), `${f} 没有真正调用冒烟测试`)
    // 跑不起来必须中止,不能继续往下打印"安装完成"——#145 就是这么让人白查半天的
    assert.match(text.slice(text.indexOf(call)).slice(0, 500), /die "/, `${f} 的冒烟测试失败后要中止`)
  }
  // 升级脚本的冒烟测试要排在停服务、换文件之前
  const up = SCRIPTS['update.sh']
  assert.ok(up.indexOf('openbox_node_smoke "$STAGE_DIR"') < up.indexOf('write_status committing "" "" ""'), 'update.sh 要在进入替换阶段之前试新 Node')
})

// 变量后面紧跟中文标点要写成 ${VAR}:macOS 自带的 bash 3.2 在 UTF-8 语言环境下把「。」「,」的第一个字节算进变量名,
// set -u 时报「STATUS_PATH�: unbound variable」(审查第一项)。路由器的 busybox ash、Debian 的 dash 不受影响,
// 但开发机上跑测试会随 LANG 时好时坏,脚本里一律加大括号
test('shell 脚本里 $变量 后面不能直接跟非 ASCII 字符(要写 ${变量})', () => {
  const files = ['scripts/install.sh', 'scripts/update.sh', 'scripts/uninstall.sh', 'scripts/build-release.sh',
    'panel/server/system/update-components.sh', 'openwrt/bin/open-box', 'openwrt/initd/openbox', 'openwrt/initd/openbox-panel',
    'openwrt/bin/compat/node', ...fs.readdirSync(path.join(repoRoot, 'debian/bin')).map((n) => `debian/bin/${n}`)]
  const bad = []
  for (const rel of files) {
    fs.readFileSync(path.join(repoRoot, rel), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return
      for (const m of line.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7f])/g)) bad.push(`${rel}:${i + 1} $${m[1]}`)
    })
  }
  assert.deepEqual(bad, [])
})
