import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 发版体检:安装 / 升级 / 卸载脚本和发布包的内容必须对得上。
//
// 起因是真机上栽过一次(2026-09-20,v0.1.216):LuCI 视图文件改名 status.js → main.js,
// 而脚本里那行 cp 还写着旧文件名 —— 一键安装到那一步直接 die「无法安装 LuCI 视图文件」,
// 全新安装彻底装不上。用户由此定了规矩:**每次发新版都必须能全新安装**。
// 这组用例就是把那条规矩变成每次 npm test 都跑的检查:脚本要拿的文件,包里必须真有。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const scripts = { 'install.sh': read('scripts/install.sh'), 'update.sh': read('scripts/update.sh') }

// 脚本里所有 "$INSTALL_ROOT/openwrt/..." 形式的引用 —— 这些路径都来自发布包里的 openwrt/ 目录,
// 仓库里的同名路径就是打包源(build-release.sh 原样收进包里)。
// 带变量的(比如兼容库按架构挑的 openwrt/bin/compat/$_ob_lib)这里解析不了,由各自的测试核对(node-compat.test.mjs)
const packageRefs = (text) =>
  [...text.matchAll(/"\$INSTALL_ROOT\/((?:openwrt|debian)\/[^"]*)"/g)].map((m) => m[1]).filter((rel) => !rel.includes('$'))

test('安装 / 升级脚本要拿的包内文件,仓库里必须真的存在(改名后忘了同步脚本 = 全新安装装不上)', () => {
  for (const [name, text] of Object.entries(scripts)) {
    const refs = [...new Set(packageRefs(text))]
    assert.ok(refs.length >= 5, `${name} 里应当引用到包内文件,却只解析出 ${refs.length} 条`)
    // Debian / Ubuntu 那套(systemd 单元 + 服务脚本目录)也要被引用到,而且 build-release.sh 得把 debian/ 收进包
    assert.ok(refs.some((r) => r.startsWith('debian/systemd/')), `${name} 没有引用 debian/systemd 的单元文件`)
    for (const rel of refs) {
      const abs = path.join(repoRoot, rel)
      if (rel.endsWith('/')) {
        // 目录形式(脚本按 *.js 整目录拷):目录要在,而且不能是空的
        assert.ok(fs.existsSync(abs) && fs.statSync(abs).isDirectory(), `${name} 引用的目录不存在:${rel}`)
        assert.ok(fs.readdirSync(abs).length > 0, `${name} 引用的目录是空的:${rel}`)
      } else {
        assert.ok(fs.existsSync(abs), `${name} 引用的文件不存在:${rel}(改名 / 删文件后要同步改脚本)`)
      }
    }
  }
})

test('打包脚本把 debian/ 收进发布包,组件清单的 app 组件也带上它', () => {
  const build = read('scripts/build-release.sh')
  assert.match(build, /cp -R "\$ROOT\/debian" "\$STAGE\/debian"/)
  assert.match(build, /tar \$TAR_NO_XATTR -czf "\$VERSIONED_PATH" node panel bin openwrt debian meta\.json uninstall\.sh update\.sh/)
  assert.match(read('scripts/release-components.py'), /'app': \(meta\['version'\], \['panel', 'openwrt', 'debian', /)
  // 升级脚本换组件时 debian/ 也要在替换名单里,否则新版本的单元文件铺不下去
  assert.match(read('scripts/update.sh'), /COMPONENTS="\$\{UPDATE_COMPONENTS:-node panel bin openwrt debian\}"/)
  assert.match(read('panel/server/system/update-components.sh'), /UPDATE_COMPONENTS="panel openwrt debian"/)
})

// sing-box 是 GPL-3.0:发内核二进制就要让人拿得到对应源码。build.sh 每次都生成源码包,但以前打包脚本从没把它放进产物目录,
// Release 上一直缺这个附件(2026-09-27 查最近 60 个 Release 都没有)。用户当天定:随 Release 上传
test('内核源码包进产物目录:打包脚本找的文件名和 build.sh 生成的一致,并拷进产物目录、带 .sha256', () => {
  const build = read('scripts/build-release.sh')
  assert.match(read('scripts/singbox-tcp-dns-hotfix/build.sh'), /tar -czf "\$hotfix_output\/sing-box-\$hotfix_version-source\.tar\.gz"/)
  assert.match(build, /KERNEL_SOURCE_NAME="sing-box-\$SINGBOX_VERSION-source\.tar\.gz"/)
  assert.match(build, /KERNEL_SOURCE="\$KERNEL_BUILD_DIR\/\$KERNEL_SOURCE_NAME"/)
  assert.match(build, /cp "\$KERNEL_SOURCE" "\$OUTDIR\/\$KERNEL_SOURCE_NAME"/)
  assert.match(build, /sha256sum "\$KERNEL_SOURCE_NAME" > "\$KERNEL_SOURCE_NAME\.sha256"/)
})

test('LuCI 菜单指向的视图文件必须存在,且三个脚本对它的处理一致', () => {
  const menu = JSON.parse(read('openwrt/luci/root/usr/share/luci/menu.d/luci-app-openbox.json'))
  const entry = menu['admin/services/openbox']
  assert.ok(entry && entry.action && entry.action.path, '菜单项里缺 action.path')
  // path 形如 "openbox/main" → 对应 view/openbox/main.js
  const viewRel = `openwrt/luci/htdocs/luci-static/resources/view/${entry.action.path}.js`
  assert.ok(fs.existsSync(path.join(repoRoot, viewRel)), `菜单指向的视图文件不存在:${viewRel}`)

  // 安装 / 升级:按目录拷,不写死文件名 —— 写死的话下次改名又会在这里硬失败
  for (const [name, text] of Object.entries(scripts)) {
    assert.match(text, /view\/openbox\/"\*\.js/, `${name} 应当按目录 *.js 拷 LuCI 视图,不要写死文件名`)
  }
  // 卸载:菜单能指到的那个文件必须被删掉,否则卸载完 LuCI 里还留着一个页面
  const uninstall = read('scripts/uninstall.sh')
  const viewName = path.basename(viewRel)
  assert.ok(
    uninstall.includes(`/www/luci-static/resources/view/openbox/${viewName}`),
    `uninstall.sh 没有删除当前视图文件 ${viewName}`,
  )
})

test('卸载脚本不许重启 rpcd(会把 LuCI 登录会话全踢掉,用户卸载到一半被弹回登录页)', () => {
  const lines = read('scripts/uninstall.sh').split('\n').filter((l) => !l.trim().startsWith('#'))
  const offenders = lines.filter((l) => /init\.d\/rpcd\s+(restart|reload)/.test(l))
  assert.deepEqual(offenders, [], `uninstall.sh 里不该有重启 rpcd 的语句:${offenders.join(' | ')}`)
})

test('三个随发布走的脚本语法都过 sh -n(它们不经 CI,装不上就是装不上)', () => {
  for (const name of ['install.sh', 'update.sh', 'uninstall.sh']) {
    execFileSync('sh', ['-n', path.join(repoRoot, 'scripts', name)])
  }
})

// 连接卡住不动(国内访问 nodejs.org / api.github.com 常见)时下载要能失败、轮到下一个源,不能把安装 / 升级一直挂着。
// 2026-09-30 验收时 ubuntu23 全新安装卡在 nodejs.org 的 18 MB 处不动:install.sh 的 fetch_to_file 以前没有任何时限,
// 永远轮不到 npmmirror。三个脚本里 case "$DOWNLOADER" 的每个下载分支都要带时限
test('下载都有时限:卡住的连接会失败并换下一个源,不会把安装 / 升级一直挂着', () => {
  const branches = []
  const offenders = []
  for (const name of ['install.sh', 'update.sh', 'uninstall.sh']) {
    for (const line of read(`scripts/${name}`).split('\n')) {
      const m = line.match(/^\s*(curl|wget)\)\s+(curl|wget)\s(.*)$/)
      if (!m) continue
      branches.push(line)
      // curl:总时长(小文件)或低速判停(安装包这种大文件,慢网络也要能下完);wget:读超时
      const bounded = m[2] === 'curl' ? /--max-time|--speed-time/.test(m[3]) : /--timeout=/.test(m[3])
      if (!bounded) offenders.push(`${name}: ${line.trim()}`)
    }
  }
  assert.ok(branches.length >= 18, `只认出 ${branches.length} 个下载分支,写法变了?`)
  assert.deepEqual(offenders, [])
})

// v0.1.270 发布前验收拦下的:临时打包工作树里 .build-cache/geodata 是接到主检出缓存的软链接,cp -R 只复制了链接,
// 包里的 Geo 规则集成了指向构建机路径的链接;构建机上的校验顺着链接读得到文件照样通过,全新安装后内核起不来
test('打包脚本:Geo 快照按内容复制;切组件包之前检查 stage 里没有指向包外的软链接', () => {
  const build = read('scripts/build-release.sh')
  assert.match(build, /cp -R "\$GEO_BUNDLE\/\." "\$STAGE\/panel\/server\/resources\/geodata\/"/)
  const check = build.indexOf('check-stage-links.py" "$STAGE"')
  const components = build.indexOf('release-components.py" "$STAGE"')
  assert.ok(check > 0 && check < components, '要在切组件包之前检查')

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-links-'))
  const run = () => spawnSync('python3', [path.join(repoRoot, 'scripts/check-stage-links.py'), stage], { encoding: 'utf8' })
  try {
    fs.mkdirSync(path.join(stage, 'panel/node_modules/.bin'), { recursive: true })
    fs.writeFileSync(path.join(stage, 'panel/node_modules/cli.js'), '')
    fs.symlinkSync('../cli.js', path.join(stage, 'panel/node_modules/.bin/cli'))
    assert.equal(run().status, 0, '包内的相对链接(node_modules/.bin)可以')

    fs.symlinkSync(os.tmpdir(), path.join(stage, 'panel/geodata'))
    const absolute = run()
    assert.equal(absolute.status, 1, '绝对路径链接不行')
    assert.match(absolute.stderr, /panel\/geodata -> /)
    fs.rmSync(path.join(stage, 'panel/geodata'))

    fs.symlinkSync('../../outside', path.join(stage, 'panel/escape'))
    assert.equal(run().status, 1, '相对链接跑出包外也不行')
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
})

// 审查第十六项:以前不给版本号就退回 git describe(本地最近的 tag 还是 v0.1.174),另一个会话没提交的改动也会被打进包里
test('打包脚本:正式打包要显式的 vX.Y.Z 版本号、干净的工作区;meta.json 记源码提交;停用的 CI 工作流已删', () => {
  const build = read('scripts/build-release.sh')
  assert.match(build, /正式打包必须给 OPENBOX_VERSION=vX\.Y\.Z/)
  assert.ok(build.includes("grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+$'"), '版本号只认 vX.Y.Z')
  assert.match(build, /status --porcelain --untracked-files=all -- panel scripts openwrt debian/)
  assert.match(build, /"sourceCommit": "\$SOURCE_COMMIT"/)
  // 源码不推 GitHub,那个工作流从来没跑过;留着只会让人以为发布有 CI 把关
  assert.equal(fs.existsSync(path.join(repoRoot, '.github/workflows/release.yml')), false)
})

// 审查第十七项:发布前在真机 / 虚拟机上验收的工具(scripts/release-verify/README.md)
test('发布前验收工具:shell 脚本过 sh -n,假镜像能编译', () => {
  for (const rel of ['scripts/release-verify/verify-host.sh', 'scripts/release-verify/run-host.sh', 'scripts/release-verify/arm64-vm.sh', 'scripts/release-verify/vz/run-vm.sh']) {
    execFileSync('sh', ['-n', path.join(repoRoot, rel)])
  }
  execFileSync('python3', ['-m', 'py_compile', path.join(repoRoot, 'scripts/release-verify/fake-mirror.py')])
})
