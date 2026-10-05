import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// scripts/uninstall.sh 真的跑一遍:把脚本里的绝对路径(安装目录、init 脚本、LuCI 文件、/etc/openwrt_release)
// 改指到一个沙箱目录,uci / id / rpcd 用桩,然后在沙箱里执行。
// 重点是 --detach 这条路:LuCI 页面按 rpcd 的 fs.exec 调它,那是一次有超时的 XHR,同步跑必然超时
// (页面报「卸载失败:XHR request timed out」,后台其实还在删),所以卸载要立刻返回、进度写文件。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const script = fs.readFileSync(path.join(repoRoot, 'scripts/uninstall.sh'), 'utf8')

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-uninstall-'))
  const root = path.join(dir, 'opt/open-box')
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.mkdirSync(path.join(root, 'panel'), { recursive: true })
  fs.writeFileSync(path.join(root, 'meta.json'), '{"version":"v0.0.0"}')
  fs.writeFileSync(path.join(root, 'data/openbox.sqlite'), 'db')
  fs.writeFileSync(path.join(root, 'panel/big'), 'x'.repeat(1024))
  fs.mkdirSync(path.join(dir, 'etc/init.d'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'www/luci-static/resources/view/openbox'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'usr/share/rpcd/acl.d'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'usr/share/luci/menu.d'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'usr/bin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'etc/openwrt_release'), 'DISTRIB_ID="OpenWrt"')
  for (const name of ['openbox', 'openbox-panel', 'firewall', 'rpcd']) {
    const p = path.join(dir, 'etc/init.d', name)
    fs.writeFileSync(p, `#!/bin/sh\necho "$(basename "$0") $*" >> "${dir}/tmp/initd.calls"\n`)
    fs.chmodSync(p, 0o755)
  }
  fs.writeFileSync(path.join(dir, 'www/luci-static/resources/view/openbox/main.js'), 'js')
  fs.writeFileSync(path.join(dir, 'www/luci-static/resources/view/openbox/status.js'), 'js')  // v0.1.215 及更早的旧名
  fs.writeFileSync(path.join(dir, 'usr/share/rpcd/acl.d/luci-app-openbox.json'), '{}')
  fs.writeFileSync(path.join(dir, 'usr/share/luci/menu.d/luci-app-openbox.json'), '{}')
  // 桩:uci 记录调用并对 "changes" 回空(= 没有改动,不触发 commit/reload);id 让 check_root 过
  const uci = path.join(dir, 'bin/uci')
  fs.writeFileSync(uci, `#!/bin/sh\necho "uci $*" >> "${dir}/tmp/uci.calls"\nexit 0\n`)
  fs.chmodSync(uci, 0o755)
  const id = path.join(dir, 'bin/id')
  fs.writeFileSync(id, '#!/bin/sh\necho 0\n')
  fs.chmodSync(id, 0o755)
  // 脚本里的绝对路径改指沙箱;安装目录搬到沙箱里(自迁移副本会落在沙箱的 opt/ 下)
  const body = script
    .replaceAll('/opt/open-box', root)
    .replaceAll('/etc/init.d/', `${dir}/etc/init.d/`)
    .replaceAll('/etc/openwrt_release', `${dir}/etc/openwrt_release`)
    .replaceAll('/www/luci-static', `${dir}/www/luci-static`)
    .replaceAll('/usr/share/luci', `${dir}/usr/share/luci`)
    .replaceAll('/usr/share/rpcd', `${dir}/usr/share/rpcd`)
    .replaceAll('/usr/bin/open-box', `${dir}/usr/bin/open-box`)
    .replaceAll('/tmp/luci-', `${dir}/tmp/luci-`)
  const file = path.join(root, 'uninstall.sh')
  fs.writeFileSync(file, body)
  fs.chmodSync(file, 0o755)
  return { dir, root, file, tmp: path.join(dir, 'tmp') }
}
const run = (s, args, extraEnv = {}) =>
  execFileSync('sh', [s.file, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(s.dir, 'bin')}:${process.env.PATH}`, TMPDIR: s.tmp, ...extraEnv },
  })
const status = (s) => {
  const p = path.join(s.tmp, 'openbox-uninstall.status')
  if (!fs.existsSync(p)) return {}
  return Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
}
const waitFor = async (fn, ms = 15000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

test('uninstall.sh:同步跑完整流程——停服务、清防火墙、删 init / LuCI / 程序文件,默认保留 data,进度写到 done', () => {
  const s = sandbox()
  const out = run(s, [])
  assert.match(out, /Open-Box 已卸载,数据保留在/)
  assert.equal(status(s).stage, 'done')
  assert.ok(fs.existsSync(path.join(s.root, 'data/openbox.sqlite')), 'data 默认保留')
  assert.ok(!fs.existsSync(path.join(s.root, 'panel')), '程序文件删掉')
  assert.ok(!fs.existsSync(path.join(s.dir, 'etc/init.d/openbox')), 'init 脚本删掉')
  assert.ok(!fs.existsSync(path.join(s.dir, 'www/luci-static/resources/view/openbox')), 'LuCI 页面(新旧两个文件名)连目录一起删掉')
  assert.ok(!fs.existsSync(path.join(s.dir, 'usr/share/rpcd/acl.d/luci-app-openbox.json')), 'ACL 删掉')
  const initd = fs.readFileSync(path.join(s.tmp, 'initd.calls'), 'utf8')
  for (const line of ['openbox-panel stop', 'openbox-panel disable', 'openbox stop', 'openbox disable']) {
    assert.ok(initd.includes(line), `应调用 ${line}:${initd}`)
  }
  // rpcd 绝对不能重启:LuCI 的登录会话都在它内存里,一重启用户就被踢回 OpenWrt 登录页
  // (真机上就是这么"卸载到一半退出 OpenWrt"的)。菜单项靠删 menu.d + 清 luci 缓存就没了。
  assert.ok(!initd.includes('rpcd'), `不该碰 rpcd:${initd}`)
  assert.match(fs.readFileSync(path.join(s.tmp, 'uci.calls'), 'utf8'), /delete .*firewall\.openbox_panel/)
})

test('uninstall.sh --purge:连 data 一起删', () => {
  const s = sandbox()
  const out = run(s, ['--purge'])
  assert.match(out, /已完全卸载/)
  assert.ok(!fs.existsSync(s.root), '安装目录整个删掉')
})

test('uninstall.sh --detach(LuCI 页面走这条):立刻返回、后台接着删,进度从 starting 走到 done;自迁移副本收尾删掉', async () => {
  const s = sandbox()
  const started = Date.now()
  const out = run(s, ['--detach'])
  const elapsed = Date.now() - started
  assert.match(out, /卸载已在后台开始/)
  assert.ok(elapsed < 3000, `--detach 必须立刻返回,实际 ${elapsed}ms`)
  // 立刻就能读到进度(页面轮询第一下就有东西看)
  assert.ok(['starting', 'stopping', 'firewall', 'files', 'removing', 'done'].includes(status(s).stage), JSON.stringify(status(s)))
  assert.ok(await waitFor(() => status(s).stage === 'done'), `后台没跑到 done:${JSON.stringify(status(s))}`)
  assert.ok(!fs.existsSync(path.join(s.root, 'panel')), '后台进程真的删了程序文件')
  assert.ok(fs.existsSync(path.join(s.root, 'data/openbox.sqlite')), 'data 仍在')
  assert.ok(await waitFor(() => !fs.readdirSync(path.join(s.dir, 'opt')).some((f) => f.startsWith('.openbox-uninstall.'))), '自迁移副本应在收尾时删掉')
  assert.match(fs.readFileSync(path.join(s.tmp, 'openbox-uninstall.log'), 'utf8'), /Open-Box 已卸载/)
})

test('uninstall.sh --detach:固件连 setsid / busybox setsid / nohup 都没有也照样派到后台删完(#406)', async () => {
  const s = sandbox()
  // PATH 只链 /usr/bin、/bin 里除这三样以外的命令
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-path-'))
  for (const src of ['/usr/bin', '/bin']) {
    for (const f of fs.readdirSync(src)) {
      if (['setsid', 'busybox', 'nohup'].includes(f) || fs.existsSync(path.join(bin, f))) continue
      try { fs.symlinkSync(path.join(src, f), path.join(bin, f)) } catch { /* 同名的已链过 */ }
    }
  }
  const out = run(s, ['--detach'], { PATH: `${path.join(s.dir, 'bin')}:${bin}` })
  assert.match(out, /卸载已在后台开始/)
  assert.ok(await waitFor(() => status(s).stage === 'done'), `后台没跑到 done:${JSON.stringify(status(s))}`)
  assert.ok(!fs.existsSync(path.join(s.root, 'panel')), '后台进程真的删了程序文件')
})

test('uninstall.sh:没装过就说一声退出;参数不认识就报错(两种都不留 done 进度)', () => {
  const s = sandbox()
  // 把脚本挪到安装目录外,再删掉安装目录:模拟没装过
  const copy = path.join(s.dir, 'standalone.sh')
  fs.copyFileSync(s.file, copy)
  fs.rmSync(s.root, { recursive: true, force: true })
  const env = { ...process.env, PATH: `${path.join(s.dir, 'bin')}:${process.env.PATH}`, TMPDIR: s.tmp }
  assert.match(execFileSync('sh', [copy], { encoding: 'utf8', env }), /无需卸载/)
  assert.notEqual(status(s).stage, 'done')
  assert.throws(
    () => execFileSync('sh', [copy, '--what'], { encoding: 'utf8', env, stdio: 'pipe' }),
    /未知参数/,
    '不认识的参数要报错退出',
  )
})
