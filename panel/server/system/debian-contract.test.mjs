import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPaths } from './paths.mjs'

// Debian / Ubuntu 那套(debian/)和 OpenWrt 那套(openwrt/initd)必须说同一种话:面板只认 start / stop / restart /
// enable / disable / enabled / status 这几个动作(system/service.mjs),起内核前后的系统层动作两边要一致
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const ctl = read('debian/bin/openbox-ctl')
const panelCtl = read('debian/bin/openbox-panel-ctl')
const panelRun = read('debian/bin/openbox-panel-run')
const shim = read('debian/shim/logread')
const coreUnit = read('debian/systemd/openbox.service')
const panelUnit = read('debian/systemd/openbox-panel.service')
const owCore = read('openwrt/initd/openbox')
const owPanel = read('openwrt/initd/openbox-panel')
const paths = createPaths('/opt/open-box', { platform: 'systemd' })

const fn = (body, name) => {
  const m = body.match(new RegExp(`^${name}\\(\\) \\{[^]*?^\\}`, 'm'))
  assert.ok(m, `抽不出 ${name}`)
  return m[0]
}

test('systemd 平台的服务脚本真的在包里,而且可执行、语法过 sh -n', () => {
  for (const rel of ['debian/bin/openbox-ctl', 'debian/bin/openbox-panel-ctl', 'debian/bin/openbox-panel-run', 'debian/shim/logread']) {
    const file = path.join(repoRoot, rel)
    assert.ok(fs.statSync(file).mode & 0o111, `${rel} 没有可执行位`)
    execFileSync('sh', ['-n', file])
  }
  assert.equal(paths.initd.core, '/opt/open-box/debian/bin/openbox-ctl')
  assert.equal(paths.initd.panel, '/opt/open-box/debian/bin/openbox-panel-ctl')
})

test('两个控制脚本都认面板用的全部动作,status 输出 running', () => {
  for (const [name, body] of [['openbox-ctl', ctl], ['openbox-panel-ctl', panelCtl]]) {
    for (const action of ['start', 'stop', 'restart', 'enable', 'disable', 'enabled', 'status']) {
      assert.match(body, new RegExp(`^\\t(?:[a-z-]+\\|)*${action}(?:\\|[a-z-]+)*\\)`, 'm'), `${name} 不处理 ${action}`)
    }
    assert.match(body, /echo "running"/, `${name} 的 status 不输出 running`)
    // 连续崩溃触发 systemd 启动限流后单位是 failed,不 reset-failed 的话 start 会被拒
    assert.match(body, /reset-failed/, `${name} 的 start 没有先 reset-failed`)
  }
  assert.match(ctl, /^\tpre-start\) pre_start ;;$/m)
  assert.match(ctl, /^\tpost-stop\) post_stop ;;$/m)
})

test('起内核前的系统层函数和 OpenWrt init 脚本逐字一致', () => {
  for (const name of ['openbox_entry_bypass', 'openbox_load_modules', 'openbox_apply_mark_rule', 'openbox_clear_mark_rule']) {
    assert.equal(fn(ctl, name), fn(owCore, name), `${name} 两边不一致`)
  }
  // 清残留表:Debian 用 pgrep -x(dash 环境下 pgrep 是 procps 的,-x 才是整名匹配),其余一样
  assert.equal(fn(ctl, 'openbox_clean_stale_nft').replace('pgrep -x sing-box', 'pgrep sing-box'), fn(owCore, 'openbox_clean_stale_nft'))
  // 表名、标记、路由优先级三个常量
  for (const line of ['SINGBOX_OUTPUT_MARK=0x2024', 'NFT_TABLE="inet openbox"', 'OPENBOX_MARK_RULE_PREF=8999', 'ENTRY_BYPASS="$OPENBOX_ROOT/etc/entry-bypass.nft"']) {
    assert.ok(ctl.includes(line) && owCore.includes(line), `常量 ${line} 两边不一致`)
  }
  assert.equal(paths.entryBypassPath, '/opt/open-box/etc/entry-bypass.nft')
  // pre-start 的顺序和 OpenWrt 的 start_service 一样:清残留 → 加载模块 → 装表 → 标记路由
  const order = ['openbox_clean_stale_nft', 'openbox_load_modules', 'openbox_apply_nft', 'openbox_apply_mark_rule']
  const pre = fn(ctl, 'pre_start')
  const idx = order.map((n) => pre.indexOf(`\t${n}\n`))
  assert.ok(idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]), `pre_start 顺序:${idx}`)
  const post = fn(ctl, 'post_stop')
  assert.match(post, /openbox_clear_mark_rule/)
  assert.match(post, /nft delete table \$NFT_TABLE/)
  assert.match(post, /openbox_restore_forward/)
})

test('systemd 单元指向的路径与 createPaths 一致', () => {
  assert.match(coreUnit, /^ExecStartPre=\/opt\/open-box\/debian\/bin\/openbox-ctl pre-start$/m)
  assert.match(coreUnit, /^ExecStopPost=\/opt\/open-box\/debian\/bin\/openbox-ctl post-stop$/m)
  assert.equal(coreUnit.match(/^ExecStart=(.*)$/m)[1], `${paths.singbox} run -c ${paths.configPath} -D ${paths.dataDir}`)
  assert.match(coreUnit, /^Restart=on-failure$/m)
  assert.match(coreUnit, /^StartLimitBurst=5$/m)
  assert.match(panelUnit, /^ExecStart=\/opt\/open-box\/debian\/bin\/openbox-panel-run$/m)
  assert.match(panelUnit, /^Restart=always$/m)
  // logread 替身所在目录要排在 PATH 最前面,面板 exec('logread') 才找得到它
  assert.match(panelUnit, /^Environment=PATH=\/opt\/open-box\/debian\/shim:/m)
  assert.match(shim, /-u openbox\.service -u openbox-panel\.service/)
  assert.match(shim, /-o short/)
})

test('面板启动参数(端口文件、堆上限阈值、数据库路径)与 OpenWrt 脚本一致,且不带 musl 的 LD_LIBRARY_PATH', () => {
  for (const snippet of ['panel_port=2026', 'heap_mb=160', '-lt 786432', 'heap_mb=128', 'ZASHBOARD_DB_PATH="$DATA/openbox.sqlite"', '--max-old-space-size=$heap_mb']) {
    assert.ok(panelRun.includes(snippet) && owPanel.includes(snippet), `${snippet} 两边不一致`)
  }
  assert.match(panelRun, /^unset LD_LIBRARY_PATH$/m)
  assert.match(panelRun, /OPENBOX_PLATFORM=systemd/)
})
