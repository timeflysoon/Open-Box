import assert from 'node:assert/strict'
import test from 'node:test'
import { detectPlatform, isOpenWrt } from './platform.mjs'
import { createPaths } from './paths.mjs'

const existsOf = (present) => (p) => present.includes(p)

test('detectPlatform:有 /etc/openwrt_release 就是 openwrt,只有 systemd 才是 systemd,都没有按 openwrt', () => {
  assert.equal(detectPlatform({ env: {}, exists: existsOf(['/etc/openwrt_release', '/run/systemd/system']) }), 'openwrt')
  assert.equal(detectPlatform({ env: {}, exists: existsOf(['/run/systemd/system']) }), 'systemd')
  assert.equal(detectPlatform({ env: {}, exists: existsOf([]) }), 'openwrt')
})

test('detectPlatform:OPENBOX_PLATFORM 能强制指定,不认识的值忽略', () => {
  assert.equal(detectPlatform({ env: { OPENBOX_PLATFORM: 'systemd' }, exists: existsOf(['/etc/openwrt_release']) }), 'systemd')
  assert.equal(detectPlatform({ env: { OPENBOX_PLATFORM: 'openwrt' }, exists: existsOf(['/run/systemd/system']) }), 'openwrt')
  assert.equal(detectPlatform({ env: { OPENBOX_PLATFORM: 'macos' }, exists: existsOf(['/run/systemd/system']) }), 'systemd')
  assert.equal(isOpenWrt('openwrt'), true)
  assert.equal(isOpenWrt('systemd'), false)
  assert.equal(isOpenWrt(undefined), true)
})

test('createPaths:默认 OpenWrt 布局;systemd 平台换服务脚本与租约表,其余目录不变', () => {
  const ow = createPaths()
  const sd = createPaths('/opt/open-box', { platform: 'systemd' })
  assert.equal(ow.platform, 'openwrt')
  assert.equal(sd.platform, 'systemd')
  assert.equal(sd.initd.core, '/opt/open-box/debian/bin/openbox-ctl')
  assert.equal(sd.initd.panel, '/opt/open-box/debian/bin/openbox-panel-ctl')
  assert.equal(sd.dhcpLeases, '/var/lib/misc/dnsmasq.leases')
  for (const key of ['singbox', 'configPath', 'entryBypassPath', 'dataDir', 'rulesetDir', 'metaPath', 'updateScript']) {
    assert.equal(sd[key], ow[key], `${key} 两种平台应一致`)
  }
})
