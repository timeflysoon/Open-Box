import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { createStore } from '../store/openbox-store.mjs'
import { ROUTER_ID_KEY, lanAddresses, registerClientAppRoutes, registerPublicClientRoutes, routerId } from './client-app.mjs'
import { DEFAULT_SHARE_REGIONS, shareRegionsVersion } from '../engine/share-regions.mjs'

const setup = async () => {
  const map = new Map()
  const store = createStore({ get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v), del: (k) => map.delete(k) })
  const geoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-geo-'))
  fs.writeFileSync(path.join(geoDir, 'geosite-cn.srs'), Buffer.from('SRS-test'))
  const app = express()
  registerPublicClientRoutes(app, { store, geoDir })
  registerClientAppRoutes(app, { store })
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  return {
    store, map,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('router id is generated once, stored under a protected key, and stable', async () => {
  const { store, map, close } = await setup()
  try {
    const id = routerId(store)
    assert.match(id, /^[0-9a-f]{32}$/)
    assert.equal(routerId(store), id)
    assert.equal(map.get(ROUTER_ID_KEY), id)
    assert.ok(ROUTER_ID_KEY.startsWith('openbox/'))
  } finally { await close() }
})

test('public client routes answer only for this router id', async () => {
  const { store, base, close } = await setup()
  try {
    const id = routerId(store)
    assert.equal((await fetch(`${base}/client/v1/home/${id}`)).status, 200)
    assert.equal((await fetch(`${base}/client/v1/home/${'0'.repeat(32)}`)).status, 404)
    const regions = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.deepEqual(regions.groups, DEFAULT_SHARE_REGIONS)
    assert.equal(regions.version, shareRegionsVersion(DEFAULT_SHARE_REGIONS))
    // 改过的地区分流:版本跟着变
    const custom = [{ ...structuredClone(DEFAULT_SHARE_REGIONS[2]) }]
    store.setProfile({ shareRegions: custom })
    const next = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.deepEqual(next.groups, custom)
    assert.notEqual(next.version, regions.version)
    // 规则集:只认 geosite- / geoip- 开头的名字,目录穿越和不存在的都 404
    const srs = await fetch(`${base}/client/v1/${id}/geodata/geosite-cn.srs`)
    assert.equal(srs.status, 200)
    assert.equal(Buffer.from(await srs.arrayBuffer()).toString(), 'SRS-test')
    assert.equal((await fetch(`${base}/client/v1/${id}/geodata/geoip-xx.srs`)).status, 404)
    assert.equal((await fetch(`${base}/client/v1/${id}/geodata/..%2F..%2Fetc%2Fpasswd`)).status, 404)
    assert.equal((await fetch(`${base}/client/v1/${'f'.repeat(32)}/geodata/geosite-cn.srs`)).status, 404)
  } finally { await close() }
})

test('info route gives what the share page needs to build App codes', async () => {
  const { store, base, close } = await setup()
  try {
    const info = await (await fetch(`${base}/api/openbox/client-app/info`)).json()
    assert.equal(info.routerId, routerId(store))
    assert.equal(typeof info.routerName, 'string')
    assert.ok(Number.isInteger(info.panelPort))
    assert.deepEqual(info.lanAddresses, [])
    assert.equal(info.shareRegionsCustomized, false)
    assert.deepEqual(info.shareRegions, DEFAULT_SHARE_REGIONS)
    assert.deepEqual(info.defaultShareRegions, DEFAULT_SHARE_REGIONS)
  } finally { await close() }
})

test('LAN addresses come from the LAN interfaces, IPv4 first', async () => {
  const addr4 = [
    '2: eth0    inet 203.0.113.9/24 brd 203.0.113.255 scope global eth0',
    '3: br-lan    inet 192.168.3.1/24 brd 192.168.3.255 scope global br-lan',
  ].join('\n')
  const addr6 = '3: br-lan    inet6 fd00:3::1/64 scope global'
  const ctx = {
    exec: async (cmd, args) => {
      if (cmd === 'ip') return { code: 0, stdout: args[0] === '-4' ? addr4 : addr6 }
      return { code: 1, stdout: '' }
    },
  }
  assert.deepEqual(await lanAddresses(ctx, 'openwrt'), ['192.168.3.1', 'fd00:3::1'])
  // Debian / Ubuntu:没有 netifd,按地址猜;内核的 tun 和容器网桥也是私网地址,不能当成局域网口(ubuntu23 实测过)
  const debian = {
    exec: async (cmd, args) => ({
      code: 0,
      stdout: args[0] === '-4'
        ? '2: eth0    inet 192.168.3.23/24 brd 192.168.3.255 scope global eth0\n5: openbox-tun    inet 172.19.0.1/30 scope global openbox-tun\n6: docker0    inet 172.17.0.1/16 scope global docker0'
        : '',
    }),
  }
  assert.deepEqual(await lanAddresses(debian, 'systemd'), ['192.168.3.23'])
  assert.deepEqual(await lanAddresses(null, 'openwrt'), [])
  // 读地址失败就是空,不让接口出错
  assert.deepEqual(await lanAddresses({ exec: async () => { throw new Error('no ip') } }, 'openwrt'), [])
})
