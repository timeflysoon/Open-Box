import assert from 'node:assert/strict'
import test from 'node:test'
import { detectPlatform, isOpenWrt, readOsRelease } from './platform.mjs'
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

test('readOsRelease:OpenWrt 官方只写版本号,衍生固件带名字;Debian / Ubuntu 写名字 + 版本;读不到是空串', () => {
  const files = (map) => (p) => {
    if (!(p in map)) throw new Error('ENOENT')
    return map[p]
  }
  const wrt = (id, release) => files({ '/etc/openwrt_release': `DISTRIB_ID='${id}'\nDISTRIB_RELEASE='${release}'\nDISTRIB_REVISION='r28427-6df0e3d02a'\n` })
  assert.equal(readOsRelease({ platform: 'openwrt', readFile: wrt('OpenWrt', '24.10.0') }), '24.10.0')
  assert.equal(readOsRelease({ platform: 'openwrt', readFile: wrt('iStoreOS', '24.10.1') }), 'iStoreOS 24.10.1')
  assert.equal(readOsRelease({ platform: 'openwrt', readFile: files({}) }), '')
  const os = (text) => files({ '/etc/os-release': text })
  assert.equal(readOsRelease({ platform: 'systemd', readFile: os('PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n') }), 'Ubuntu 24.04')
  assert.equal(readOsRelease({ platform: 'systemd', readFile: os('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n') }), 'Debian 12')
  assert.equal(readOsRelease({ platform: 'systemd', readFile: os('NAME="Linux Mint"\nVERSION_ID="22"\nID=linuxmint\n') }), 'Linux Mint 22')
  assert.equal(readOsRelease({ platform: 'systemd', readFile: files({}) }), '')
})
