import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 随包 Node 的 madvise 兼容库(GitHub #290 #293,源码 scripts/node-compat/obmadvise.c):内核没编 madvise 系统调用的
// 设备上,安装 / 升级脚本带上它把 Node 跑起来,并把库的路径记进 data/node-preload,所有启动 Node 的地方照着带上。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const execSh = (args) => {
  const r = spawnSync('sh', args, { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}

// ---------- 编好的库:格式对、只导出 madvise、不依赖任何库 ----------
const readElf = (file) => {
  const buf = fs.readFileSync(file)
  assert.equal(buf.readUInt32BE(0), 0x7f454c46, `${file} 不是 ELF`)
  assert.equal(buf[4], 2, '要 64 位')
  assert.equal(buf[5], 1, '要小端')
  const shoff = Number(buf.readBigUInt64LE(40))
  const shentsize = buf.readUInt16LE(58)
  const shnum = buf.readUInt16LE(60)
  const sections = Array.from({ length: shnum }, (_, i) => {
    const o = shoff + i * shentsize
    return { type: buf.readUInt32LE(o + 4), offset: Number(buf.readBigUInt64LE(o + 24)), size: Number(buf.readBigUInt64LE(o + 32)), link: buf.readUInt32LE(o + 40) }
  })
  const cstr = (sec, off) => {
    const start = sec.offset + off
    return buf.toString('latin1', start, buf.indexOf(0, start))
  }
  const dynsym = sections.find((s) => s.type === 11)
  const dynstr = sections[dynsym.link]
  const symbols = []
  for (let o = dynsym.offset; o < dynsym.offset + dynsym.size; o += 24) {
    const name = cstr(dynstr, buf.readUInt32LE(o))
    if (name) symbols.push({ name, defined: buf.readUInt16LE(o + 6) !== 0 })
  }
  const dynamic = sections.find((s) => s.type === 6)
  const needed = []
  for (let o = dynamic.offset; o < dynamic.offset + dynamic.size; o += 16) {
    if (buf.readBigInt64LE(o) === 1n) needed.push(cstr(dynstr, Number(buf.readBigUInt64LE(o + 8))))
  }
  return { type: buf.readUInt16LE(16), machine: buf.readUInt16LE(18), symbols, needed }
}

test('兼容库:aarch64 / x86_64 两份都在 openwrt/bin/compat/(发布包整个拷 openwrt/bin),是共享库、只导出 madvise、不依赖别的库', () => {
  for (const [arch, machine] of [['aarch64', 183], ['x86_64', 62]]) {
    const elf = readElf(path.join(repoRoot, `openwrt/bin/compat/libobmadvise-${arch}.so`))
    assert.equal(elf.type, 3, `${arch}:要是共享库(ET_DYN)`)
    assert.equal(elf.machine, machine, `${arch}:机器类型不对`)
    assert.deepEqual(elf.symbols.filter((s) => s.defined).map((s) => s.name), ['madvise'], `${arch}:只该接管 madvise`)
    // musl 和 glibc 都导出 __errno_location;不写 DT_NEEDED,哪个 C 库的进程都能直接预加载
    assert.deepEqual(elf.symbols.filter((s) => !s.defined).map((s) => s.name), ['__errno_location'], `${arch}:只能引用 __errno_location`)
    assert.deepEqual(elf.needed, [], `${arch}:不能依赖别的库`)
  }
})

test('发布包整个拷 openwrt/bin(兼容库和启动脚本跟着进包,打包脚本不用单独列)', () => {
  assert.match(read('scripts/build-release.sh'), /^cp -R "\$ROOT\/openwrt\/bin" "\$STAGE\/openwrt\/bin"$/m)
})

// ---------- 冒烟测试:直接跑不起来就带上兼容库再试,能跑就记下来 ----------
const smokeBlock = (() => {
  const text = read('scripts/install.sh')
  const a = text.indexOf('# ---- openbox-node-smoke:start ----')
  const b = text.indexOf('# ---- openbox-node-smoke:end ----')
  assert.ok(a !== -1 && b > a, 'install.sh 里找不到 openbox-node-smoke 块')
  return text.slice(a, b)
})()

// 装一个假的安装目录:node 是个脚本,按 mode 决定跑不跑得起来
//   plain:直接就能跑;needs-shim:只有预加载了 libobmadvise 才能跑(模拟 QWRT 内核);broken:怎么都不行
const runSmoke = (mode, { preloadFile = null, env = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-node-compat-'))
  fs.mkdirSync(path.join(root, 'node/bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'openwrt/bin/compat'), { recursive: true })
  for (const arch of ['aarch64', 'x86_64']) fs.writeFileSync(path.join(root, `openwrt/bin/compat/libobmadvise-${arch}.so`), '')
  const fail = 'printf \'\\n#\\n# Fatal error in , line 0\\n# Check failed: 0 == ret.\\n#\\n\' >&2; exit 133'
  const body = {
    plain: 'printf ok',
    'needs-shim': `case "$LD_PRELOAD" in *libobmadvise-*.so) printf ok ;; *) ${fail} ;; esac`,
    broken: fail,
  }[mode]
  fs.writeFileSync(path.join(root, 'node/bin/node'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  if (preloadFile !== null) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data/node-preload'), preloadFile)
  }
  const harness = `INSTALL_ROOT='${root}'\n${smokeBlock}\nif out=$(openbox_node_smoke); then echo "RC=0"; else echo "RC=1"; printf '%s\\n' "$out"; fi\n`
  const r = spawnSync('sh', ['-c', harness], { encoding: 'utf8', env: { ...process.env, ...env } })
  const flag = path.join(root, 'data/node-preload')
  return { stdout: r.stdout, stderr: r.stderr, flag: fs.existsSync(flag) ? fs.readFileSync(flag, 'utf8') : null, root }
}
// 冒烟块按 uname -m 挑库:这台机器的 uname -m 对应哪一份
const machineArch = () => {
  const m = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim()
  return m === 'arm64' || m === 'aarch64' ? 'aarch64' : 'x86_64'
}

test('冒烟测试:直接跑崩了(内核没有 madvise)、带上兼容库能跑 → 通过,把库的路径记进 data/node-preload,并告诉用户', () => {
  const r = runSmoke('needs-shim')
  assert.match(r.stdout, /^RC=0$/m)
  assert.equal(r.flag, `${r.root}/openwrt/bin/compat/libobmadvise-${machineArch()}.so\n`)
  assert.match(r.stderr, /内核没有 madvise 系统调用,随包 Node 改用兼容库运行/)
})

test('冒烟测试:直接就能跑 → 通过,删掉以前记下的 data/node-preload(换了固件的机器不再带兼容库)', () => {
  const r = runSmoke('plain', { preloadFile: '/opt/open-box/openwrt/bin/compat/libobmadvise-x86_64.so\n' })
  assert.match(r.stdout, /^RC=0$/m)
  assert.equal(r.flag, null)
})

test('冒烟测试:带上兼容库也跑不起来 → 失败,打出第一次的报错,不留 data/node-preload', () => {
  const r = runSmoke('broken')
  assert.match(r.stdout, /^RC=1$/m)
  assert.match(r.stdout, /Check failed: 0 == ret\./)
  assert.equal(r.flag, null)
})

test('冒烟测试:面板发起的升级从面板进程继承了 LD_PRELOAD,「直接跑」那次也要清掉它,不能误判成不需要兼容库', () => {
  const r = runSmoke('needs-shim', { env: { LD_PRELOAD: '/opt/open-box/openwrt/bin/compat/libobmadvise-x86_64.so' } })
  assert.match(r.stdout, /^RC=0$/m)
  assert.equal(r.flag, `${r.root}/openwrt/bin/compat/libobmadvise-${machineArch()}.so\n`)
})

// ---------- 面板服务的启动脚本 openwrt/bin/compat/node ----------
// procd 开着 stdout / stderr 转日志时,启动前把 LD_PRELOAD 整个换成 /lib/libsetlbf.so(开发路由器实测面板照样崩),
// 所以兼容库只能由这个脚本在 procd 之后补上
const runLauncher = ({ preload, inherited }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-node-launcher-'))
  fs.mkdirSync(path.join(root, 'openwrt/bin/compat'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node/bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  const shim = path.join(root, 'openwrt/bin/compat/libobmadvise-x86_64.so')
  fs.writeFileSync(shim, '')
  fs.copyFileSync(path.join(repoRoot, 'openwrt/bin/compat/node'), path.join(root, 'openwrt/bin/compat/node'))
  fs.writeFileSync(path.join(root, 'node/bin/node'), '#!/bin/sh\nprintf \'LD_PRELOAD=%s\\n\' "$LD_PRELOAD"; printf \'ARG=%s\\n\' "$@"\n', { mode: 0o755 })
  if (preload) fs.writeFileSync(path.join(root, 'data/node-preload'), preload === 'shim' ? `${shim}\n` : preload)
  const env = { ...process.env }
  delete env.LD_PRELOAD
  if (inherited) env.LD_PRELOAD = inherited
  const r = spawnSync('sh', [path.join(root, 'openwrt/bin/compat/node'), '--max-old-space-size=160', '/opt/open-box/panel/server/index.mjs'], { encoding: 'utf8', env })
  return { out: r.stdout, shim }
}

test('面板启动脚本 compat/node:叫 node(procd 按文件名给日志打 node[pid] 标签)、可执行;带上兼容库并保留 procd 的 libsetlbf.so,参数原样交给随包 Node', () => {
  const rel = 'openwrt/bin/compat/node'
  assert.ok(fs.statSync(path.join(repoRoot, rel)).mode & 0o111, `${rel} 要可执行`)
  execSh(['-n', path.join(repoRoot, rel)])
  const a = runLauncher({ preload: 'shim', inherited: '/lib/libsetlbf.so' })
  assert.match(a.out, new RegExp(`^LD_PRELOAD=${a.shim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:/lib/libsetlbf.so$`, 'm'))
  assert.match(a.out, /^ARG=--max-old-space-size=160\nARG=\/opt\/open-box\/panel\/server\/index\.mjs$/m)
  const b = runLauncher({ preload: 'shim' })
  assert.match(b.out, new RegExp(`^LD_PRELOAD=${b.shim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  // 记的库不在了(老路径)就不带,只留 procd 的
  const c = runLauncher({ preload: '/nonexistent/libobmadvise-x86_64.so\n', inherited: '/lib/libsetlbf.so' })
  assert.match(c.out, /^LD_PRELOAD=\/lib\/libsetlbf\.so$/m)
})

// ---------- 每个启动 Node 的地方都照着 data/node-preload 带上兼容库 ----------
test('启动 Node 的地方都读 data/node-preload:OpenWrt 面板服务、Debian 面板启动脚本、open-box 命令、升级后部署、组件升级', () => {
  // OpenWrt 面板服务:有 data/node-preload 就经 openwrt/bin/compat/node 起(procd 会换掉环境变量里的 LD_PRELOAD,见下一条)
  const initd = read('openwrt/initd/openbox-panel')
  assert.match(initd, /if \[ -s "\$DATA\/node-preload" \] && \[ -f "\$OPENBOX_ROOT\/openwrt\/bin\/compat\/node" \]; then/)
  assert.match(initd, /node_cmd="\$OPENBOX_ROOT\/openwrt\/bin\/compat\/node"/)
  assert.match(initd, /procd_set_param command "\$node_cmd" /)
  assert.doesNotMatch(initd, /^[^#\n]*LD_PRELOAD=/m, 'procd 开着 stdout 转日志时会把 LD_PRELOAD 换成 libsetlbf.so,init 脚本里设了也白设')

  const panelRun = read('debian/bin/openbox-panel-run')
  assert.match(panelRun, /^node_preload=\$\(cat "\$DATA\/node-preload" 2>\/dev\/null\)$/m)
  assert.match(panelRun, /export LD_PRELOAD="\$node_preload"/)
  assert.ok(panelRun.indexOf('export LD_PRELOAD') < panelRun.indexOf('exec "$NODE"'), '要在 exec Node 之前')

  const cli = read('openwrt/bin/open-box')
  const cliRuns = cli.split('\n').filter((l) => /"\$NODE" --/.test(l) && !/^\s*#/.test(l))
  assert.ok(cliRuns.length >= 2, 'open-box 里起 Node 的地方变了,测试要跟着改')
  for (const line of cliRuns) assert.match(line, /LD_PRELOAD="\$_preload"/, `open-box 这行没带兼容库:${line.trim()}`)
  assert.match(cli, /_preload=\$\(cat "\$ROOT\/data\/node-preload" 2>\/dev\/null\)/)

  const update = read('scripts/update.sh')
  // 844c7f0 起这次部署包在 (cd / && …) 里、输出写进 $_deploy_out(升级日志带得出失败原因)
  const deployStart = update.indexOf('if (cd / && OPENBOX_ROOT="$INSTALL_ROOT" ZASHBOARD_DB_PATH=')
  const deployEnd = update.indexOf('"$DEPLOY_CLI") >"$_deploy_out"')
  assert.ok(deployStart >= 0 && deployEnd > deployStart, 'update.sh 里升级后部署的那行变了,测试要跟着改')
  const deploy = update.slice(deployStart, deployEnd)
  assert.match(deploy, /LD_PRELOAD="\$\(cat "\$INSTALL_ROOT\/data\/node-preload" 2>\/dev\/null\)"/, '升级后按新版本部署的那次 Node 要带兼容库')

  const components = read('panel/server/system/update-components.sh')
  const nodeRuns = components.match(/"\$_component_node" "\$_component_helper"/g) || []
  const withPreload = components.match(/LD_PRELOAD="\$_component_preload" LD_LIBRARY_PATH=[^\n]*\\\n\s+"\$_component_node" "\$_component_helper"/g) || []
  assert.equal(nodeRuns.length, 2, '组件升级里起 Node 的地方变了,测试要跟着改')
  assert.equal(withPreload.length, nodeRuns.length, '组件升级里每次起 Node 都要带兼容库')
  // update.sh 是 set -eu:文件不在时 cat 失败不能让升级退出(component-update.test.mjs 在 set -eu 下真跑这段)
  assert.match(components, /_component_preload=\$\(cat "\$INSTALL_ROOT\/data\/node-preload" 2>\/dev\/null \|\| true\)/)
})
