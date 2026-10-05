import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { fileHash, GEO_DIR, planUpdate, verifyStage } from './component-update.mjs'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const helper = fileURLToPath(new URL('./component-update.mjs', import.meta.url))
const write = (root, name, text) => {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}
const fixture = t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-components-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const source = path.join(temp, 'source'), local = path.join(temp, 'local'), assets = path.join(temp, 'assets')
  fs.mkdirSync(assets)
  write(source, 'meta.json', JSON.stringify({ version: 'v0.2.0', arch: 'x64', singboxVersion: '1.14.0-openbox-tcp2', nodeVersion: '24.18.0' }))
  write(source, 'panel/index.html', 'app-v2')
  write(source, 'panel/server/system/component-update.mjs', fs.readFileSync(helper))
  // release-components.py 会核对 server/node_modules 里 express / ws / yaml 仍是指向 .pnpm 的符号链接
  for (const name of ['express', 'ws', 'yaml']) {
    write(source, `panel/server/node_modules/.pnpm/${name}@0.0.0/node_modules/${name}/package.json`, '{}')
    fs.symlinkSync(`.pnpm/${name}@0.0.0/node_modules/${name}`, path.join(source, 'panel/server/node_modules', name))
  }
  write(source, 'node/bin/node', `#!/bin/sh\nexec '${process.execPath}' "$@"\n`)
  fs.chmodSync(path.join(source, 'node/bin/node'), 0o755)
  write(source, 'bin/sing-box', 'kernel-v2')
  write(source, 'bin/sing-box.LICENSE', 'kernel-license')
  write(source, 'bin/sing-box.BUILD-INFO.json', JSON.stringify({ version: '1.14.0-openbox-tcp2', openbox_commit: 'new' }))
  write(source, 'openwrt/init', 'service')
  write(source, 'debian/bin/openbox-ctl', 'systemd wrapper')
  write(source, 'update.sh', 'update')
  write(source, 'uninstall.sh', 'uninstall')
  const files = {}
  for (const name of ['geosite-cn.srs', 'geoip-cn.srs']) {
    write(source, `${GEO_DIR}/${name}`, Buffer.from('SRS\x03snapshot'))
    files[name] = fileHash(path.join(source, GEO_DIR, name))
  }
  write(source, `${GEO_DIR}/manifest.json`, JSON.stringify({ schema: 1, version: 'a'.repeat(40), date: '2026-09-12', counts: { geosite: 1, geoip: 1 }, files }))
  execFileSync('python3', [path.join(repo, 'scripts/release-components.py'), source, assets])
  fs.cpSync(source, local, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'open-box-v0.2.0-linux-x64-components.json')))
  return { temp, source, local, assets, manifest }
}

test('完整包内的版本与组件清单一致；程序更新不重复包含内核或 Geo', t => {
  const { source, assets, manifest } = fixture(t)
  verifyStage(manifest, source)
  const entries = execFileSync('tar', ['-tzf', path.join(assets, manifest.components.app.asset)], { encoding: 'utf8' })
  assert.match(entries, /panel\/index.html/)
  assert.match(entries, /panel\/server\/resources\/licenses\/sing-box.LICENSE/)
  assert.doesNotMatch(entries, /geodata\/|bin\/sing-box|node\/bin/)
  const plan = planUpdate(manifest, source, 'x64', 'v0.2.0')
  assert.deepEqual(plan.map(c => [c.kind, c.action]), [['app', 'download'], ['runtime', 'reuse'], ['kernel', 'reuse'], ['geo', 'reuse']])
})

test('同版本但损坏/缺失也会修复；版本不一致只重新下载对应组件', t => {
  const { local, manifest } = fixture(t)
  fs.unlinkSync(path.join(local, GEO_DIR, 'geoip-cn.srs'))
  let plan = planUpdate(manifest, local, 'x64')
  assert.equal(plan.find(c => c.kind === 'geo').action, 'download')
  assert.equal(plan.find(c => c.kind === 'kernel').action, 'reuse')
  write(local, 'bin/sing-box', 'kernel-old')
  plan = planUpdate(manifest, local, 'x64')
  assert.equal(plan.find(c => c.kind === 'kernel').action, 'download')
  assert.throws(() => verifyStage(manifest, local), /校验失败/)
  assert.throws(() => planUpdate(manifest, local, 'arm64'), /架构/)
  assert.throws(() => planUpdate(manifest, local, 'x64', 'v0.3.0'), /版本/)
  const bad = structuredClone(manifest)
  bad.components.geo.asset = 'https://third-party.test/geo.tar.gz'
  assert.throws(() => planUpdate(bad, local, 'x64'), /不合法/)
})

for (const changed of [[], ['geo'], ['kernel'], ['geo', 'kernel']]) {
  test(`真实升级 shell 按需下载并组合：变化 ${changed.join('+') || '无'}，全部来自自己的 Release`, t => {
    const { temp, local, assets, manifest } = fixture(t)
    if (changed.includes('geo')) write(local, `${GEO_DIR}/geoip-cn.srs`, 'old-geo')
    if (changed.includes('kernel')) write(local, 'bin/sing-box', 'old-kernel')
    fs.unlinkSync(path.join(local, 'bin/sing-box.LICENSE'))
    write(local, 'bin/sing-box.BUILD-INFO.json', JSON.stringify({ version: '1.14.0-openbox-tcp2', openbox_commit: 'old' }))
    const originalKernel = fs.readFileSync(path.join(local, 'bin/sing-box'))
    write(local, 'data/user-config', 'keep-me')
    const download = path.join(temp, 'download'); fs.mkdirSync(download)
    const script = `set -eu
INSTALL_ROOT="$1"
TMP_DL="$2"
ASSETS="$3"
EXPECT_VERSION=v0.2.0
ARCH=x64
REPO=timeflysoon/Open-Box
info() { :; }
warn() { :; }
die() { echo "$*" >&2; exit 1; }
check_cancel_and_abort() { :; }
write_status() { :; }
safe_rm_rf() { rm -rf "$1"; }
build_url() { echo "$1"; }
fetch_to_file() {
  case "$1" in https://github.com/timeflysoon/Open-Box/releases/download/v0.2.0/*) ;; *) die "wrong source";; esac
  cp "$ASSETS/\${1##*/}" "$2"
}
download_with_progress() { echo "\${1##*/}" >> "$TMP_DL/requested"; fetch_to_file "$1" "$2"; }
. "$4"
prepare_component_update
printf '%s' "$STAGE_DIR" > "$TMP_DL/stage"
printf '%s' "$UPDATE_COMPONENTS" > "$TMP_DL/swaps"
`
    execFileSync('sh', ['-c', script, 'test', local, download, assets, fileURLToPath(new URL('./update-components.sh', import.meta.url))])
    const requests = fs.readFileSync(path.join(download, 'requested'), 'utf8').trim().split('\n')
    assert.deepEqual(requests.sort(), ['app', ...changed].map(k => manifest.components[k].asset).sort())
    const stage = fs.readFileSync(path.join(download, 'stage'), 'utf8')
    verifyStage(manifest, stage)
    assert.equal(fs.readFileSync(path.join(local, 'data/user-config'), 'utf8'), 'keep-me')
    assert.deepEqual(fs.readFileSync(path.join(local, 'bin/sing-box')), originalKernel, '暂存完成前不修改正式文件')
    assert.equal(fs.readFileSync(path.join(download, 'swaps'), 'utf8').includes('bin'), changed.includes('kernel'))
  })
}

test('Debian / Ubuntu:node/ 换成 glibc 版后哈希对不上,但 .flavor 写着同版本就算匹配,不再每次升级重下运行时', t => {
  const { manifest, local } = fixture(t)
  write(local, 'node/bin/node', '#!/bin/sh\necho glibc\n')
  let plan = planUpdate(manifest, local, 'x64')
  assert.equal(plan.find(c => c.kind === 'runtime').action, 'download')
  write(local, 'node/.flavor', `glibc ${manifest.components.runtime.version}\n`)
  fs.chmodSync(path.join(local, 'node/bin/node'), 0o755)
  plan = planUpdate(manifest, local, 'x64')
  assert.equal(plan.find(c => c.kind === 'runtime').action, 'reuse')
  // .flavor 还在但 node 本身没了执行权限 / 丢了:不复用(GPT 复核第三项)
  fs.chmodSync(path.join(local, 'node/bin/node'), 0o644)
  assert.equal(planUpdate(manifest, local, 'x64').find(c => c.kind === 'runtime').action, 'download')
  fs.rmSync(path.join(local, 'node/bin/node'))
  assert.equal(planUpdate(manifest, local, 'x64').find(c => c.kind === 'runtime').action, 'download')
  write(local, 'node/bin/node', '#!/bin/sh\necho glibc\n')
  fs.chmodSync(path.join(local, 'node/bin/node'), 0o755)
  // 版本不一样的 glibc Node 照样要换
  write(local, 'node/.flavor', 'glibc 22.0.0\n')
  assert.equal(planUpdate(manifest, local, 'x64').find(c => c.kind === 'runtime').action, 'download')
})
