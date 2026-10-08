import assert from 'node:assert/strict'
import test from 'node:test'
import { cidrContains, parseCidr, parseIpAddr, readLocalSubnets, subtractCidrs, classifyByAddress, readLocalAddresses, isVirtualIface, lanSubnetsOf } from './local-subnets.mjs'
import { buildConfig } from '../engine/config.mjs'

test('parseCidr:按掩码取整,非法返回 null', () => {
  assert.deepEqual(parseCidr('192.168.3.77/24'), { family: 4, net: parseCidr('192.168.3.0/24').net, prefix: 24 })
  assert.equal(parseCidr('fd00::1/64').prefix, 64)
  assert.equal(parseCidr('300.1.1.1/8'), null)
  assert.equal(parseCidr('abc'), null)
})

test('subtractCidrs:10/8 挖掉 10.0.0.0/24 → 不再覆盖 10.0.0.x,仍覆盖 10.0.1.x 与 10.200.x',
  () => {
    const r = subtractCidrs(['10.0.0.0/8'], ['10.0.0.0/24'])
    assert.ok(!r.some((c) => cidrContains(c, '10.0.0.5')))
    assert.ok(r.some((c) => cidrContains(c, '10.0.1.9')))
    assert.ok(r.some((c) => cidrContains(c, '10.200.3.4')))
    assert.equal(r.length, 16)
    assert.ok(r.includes('10.128.0.0/9') && r.includes('10.0.1.0/24'))
  })

test('subtractCidrs:洞盖住整段就整段消失;不相交原样保留;v6 也能挖', () => {
  assert.deepEqual(subtractCidrs(['192.168.3.0/24'], ['192.168.0.0/16']), [])
  assert.deepEqual(subtractCidrs(['192.168.0.0/16'], ['10.0.0.0/8']), ['192.168.0.0/16'])
  const v6 = subtractCidrs(['fc00::/7'], ['fd00::/64', 'fdfe:dcba:9876::/126'])
  assert.ok(!v6.some((c) => cidrContains(c, 'fd00::1')))
  assert.ok(!v6.some((c) => cidrContains(c, 'fdfe:dcba:9876::2')))
  assert.ok(v6.some((c) => cidrContains(c, 'fd00:1::1')))
  assert.ok(v6.some((c) => cidrContains(c, 'fc00::1')))
})

test('parseIpAddr:取接口网段,跳过 lo / 点对点 /32 / 链路本地', () => {
  const v4 = [
    '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
    '13: br-lan    inet 192.168.3.1/24 brd 192.168.3.255 scope global br-lan\\       valid_lft forever preferred_lft forever',
    '20: pppoe-wan0    inet 10.65.167.78 peer 10.65.0.1/32 scope global pppoe-wan0\\       valid_lft forever preferred_lft forever',
    '9: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever',
    '31: tun0    inet 172.19.0.1/30 scope global tun0\\       valid_lft forever preferred_lft forever',
  ].join('\n')
  assert.deepEqual(parseIpAddr(v4), ['192.168.3.0/24', '172.17.0.0/16', '172.19.0.0/30'])
  const v6 = [
    '13: br-lan    inet6 fd00::be24:11ff:fe38:31cc/64 scope global dynamic mngtmpaddr\\       valid_lft forever',
    '13: br-lan    inet6 fe80::be24:11ff:fe38:31cc/64 scope link\\       valid_lft forever',
    '13: br-lan    inet6 240e:34c:16c:5150:be24:11ff:fe38:31cc/64 scope global dynamic\\       valid_lft 100',
  ].join('\n')
  assert.deepEqual(parseIpAddr(v6), ['fd00::/64', '240e:34c:16c:5150::/64'])
})

test('readLocalSubnets:命令失败或抛错 → 空数组,不影响部署', async () => {
  const ok = { exec: async (cmd, args) => ({ code: 0, stdout: args[0] === '-4' ? '13: br-lan    inet 10.0.0.1/24 brd 10.0.0.255 scope global br-lan\n' : '', stderr: '' }) }
  assert.deepEqual(await readLocalSubnets(ok), ['10.0.0.0/24'])
  const bad = { exec: async () => { throw new Error('no ip') } }
  assert.deepEqual(await readLocalSubnets(bad), [])
})

test('classifyByAddress:Debian / Ubuntu 没有 netifd,按地址猜——私网 / ULA 是局域网口,公网是 WAN', () => {
  assert.equal(classifyByAddress('192.168.3.23'), 'lan')
  assert.equal(classifyByAddress('10.8.0.1'), 'lan')
  assert.equal(classifyByAddress('172.31.255.1'), 'lan')
  assert.equal(classifyByAddress('172.32.0.1'), 'wan')
  assert.equal(classifyByAddress('100.64.1.2'), 'wan')
  assert.equal(classifyByAddress('203.0.113.9'), 'wan')
  assert.equal(classifyByAddress('fd12::1'), 'lan')
  assert.equal(classifyByAddress('2408:8000::1'), 'wan')
})

test('readLocalAddresses:systemd 平台不问 ubus,按名字认不出的口按地址定角色;OpenWrt 行为不变', async () => {
  const addrs = '2: eth0    inet 192.168.3.23/24 brd 192.168.3.255 scope global eth0\n3: ppp0    inet 1.2.3.4/32 scope global ppp0\n'
  const calls = []
  const ctx = { exec: async (cmd, args) => { calls.push(cmd); return { code: 0, stdout: cmd === 'ip' && args[0] === '-4' ? addrs : '', stderr: '' } } }
  const sd = await readLocalAddresses(ctx, { platform: 'systemd' })
  assert.deepEqual(sd.map((a) => [a.iface, a.kind]), [['eth0', 'lan'], ['ppp0', 'wan']])
  assert.ok(!calls.includes('ubus'))
  const ow = await readLocalAddresses(ctx)
  assert.deepEqual(ow.map((a) => [a.iface, a.kind]), [['eth0', 'other'], ['ppp0', 'wan']])
  assert.ok(calls.includes('ubus'))
})

test('isVirtualIface:内核 tun、模拟终端 veth、容器 / 虚拟机网桥、VPN 隧道是虚拟口;物理口和用户自建的网桥不是', () => {
  for (const name of ['openbox-tun', 'obprobe0', 'obprobe1', 'docker0', 'docker_gwbridge', 'br-3f2a9c81d0e4', 'veth1a2b3c4', 'virbr0',
    'lxcbr0', 'lxdbr0', 'incusbr0', 'podman0', 'cni-podman0', 'cni0', 'tun0', 'tap0', 'wg0', 'tailscale0', 'zt5u4y6cf6']) {
    assert.equal(isVirtualIface(name), true, name)
  }
  for (const name of ['eth0', 'enp3s0', 'ens18', 'wlan0', 'wlp2s0', 'br0', 'br-lan', 'vmbr0', 'bond0', 'eth0.100']) {
    assert.equal(isVirtualIface(name), false, name)
  }
})

test('isVirtualIface:内核 tun 按生成配置里的接口名认', () => {
  const tun = buildConfig({ profile: { ipv6: false, dns: { mode: 'hijack' }, routing: { policies: [] } }, nodes: [], groups: [] }).inbounds.find((i) => i.type === 'tun')
  assert.equal(tun.interface_name, 'openbox-tun')
  assert.equal(isVirtualIface(tun.interface_name), true)
})

test('readLocalAddresses:systemd 平台上虚拟口不按地址猜——内核自己的 tun(172.19.0.1 / ULA)不算局域网口,进不了入口白名单的 lanIfaces', async () => {
  const v4 = [
    '2: eth0    inet 192.168.3.23/24 brd 192.168.3.255 scope global noprefixroute eth0\\       valid_lft forever preferred_lft forever',
    '31: openbox-tun    inet 172.19.0.1/30 brd 172.19.0.3 scope global openbox-tun\\       valid_lft forever preferred_lft forever',
    '4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever',
    '5: br-3f2a9c81d0e4    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-3f2a9c81d0e4\\       valid_lft forever preferred_lft forever',
    '6: wg0    inet 10.8.0.1/24 scope global wg0\\       valid_lft forever preferred_lft forever',
    '7: tailscale0    inet 100.101.102.103/32 scope global tailscale0\\       valid_lft forever preferred_lft forever',
    '8: br0    inet 10.0.0.2/24 brd 10.0.0.255 scope global br0\\       valid_lft forever preferred_lft forever',
  ].join('\n')
  const v6 = [
    '2: eth0    inet6 fd00:3::23/64 scope global dynamic noprefixroute \\       valid_lft 86000sec preferred_lft 14000sec',
    '31: openbox-tun    inet6 fdfe:dcba:9876::1/126 scope global \\       valid_lft forever preferred_lft forever',
  ].join('\n')
  const ctx = { exec: async (cmd, args) => (cmd === 'ip' ? { code: 0, stdout: args[0] === '-4' ? v4 : v6, stderr: '' } : { code: 1, stdout: '', stderr: '' }) }
  const sd = await readLocalAddresses(ctx, { platform: 'systemd' })
  assert.deepEqual(sd.map((a) => [a.iface, a.address, a.kind]), [
    ['eth0', '192.168.3.23', 'lan'],
    ['openbox-tun', '172.19.0.1', 'other'],
    ['docker0', '172.17.0.1', 'other'],
    ['br-3f2a9c81d0e4', '172.18.0.1', 'other'],
    ['wg0', '10.8.0.1', 'other'],
    ['tailscale0', '100.101.102.103', 'other'],
    ['br0', '10.0.0.2', 'lan'],
    ['eth0', 'fd00:3::23', 'lan'],
    ['openbox-tun', 'fdfe:dcba:9876::1', 'other'],
  ])
  // system/deploy.mjs 就是这样取入口白名单的局域网口
  assert.deepEqual([...new Set(sd.filter((a) => a.kind === 'lan').map((a) => a.iface))], ['eth0', 'br0'])
  // OpenWrt 上它们本来就认不成局域网口(问不到 netifd 时按设备名猜),行为不变
  const ow = await readLocalAddresses(ctx)
  assert.ok(ow.every((a) => a.kind === 'other'), JSON.stringify(ow))
})

test('lanSubnetsOf:局域网口的 IPv4 私网网段按网络地址写、去重;WAN、虚拟口、点对点、公网、IPv6 不算', async () => {
  const v4 = [
    '2: eth0    inet 203.0.113.9/24 brd 203.0.113.255 scope global eth0',
    '3: br-lan    inet 192.168.3.1/24 brd 192.168.3.255 scope global br-lan',
    '3: br-lan    inet 192.168.3.2/24 scope global secondary br-lan',
    '4: br-iot    inet 10.10.0.1/16 scope global br-iot',
    '5: openbox-tun    inet 172.19.0.1/30 scope global openbox-tun',
    '6: pppoe-wan    inet 100.64.3.4/32 scope global pppoe-wan',
  ].join('\n')
  const v6 = '3: br-lan    inet6 fd00:3::1/64 scope global'
  const ubus = JSON.stringify({ interface: [{ interface: 'wan', l3_device: 'eth0' }, { interface: 'lan', l3_device: 'br-lan' }, { interface: 'lan_iot', l3_device: 'br-iot' }] })
  const ctx = { exec: async (cmd, args) => (cmd === 'ip' ? { code: 0, stdout: args[0] === '-4' ? v4 : v6 } : { code: 0, stdout: ubus }) }
  assert.deepEqual(lanSubnetsOf(await readLocalAddresses(ctx)), ['192.168.3.0/24', '10.10.0.0/16'])
  // Debian / Ubuntu:按地址猜出来的局域网口照样算,内核 tun、容器网桥不算
  const debian = { exec: async (cmd, args) => ({ code: 0, stdout: args[0] === '-4' ? '2: ens18    inet 192.168.3.23/24 scope global ens18\n5: openbox-tun    inet 172.19.0.1/30 scope global openbox-tun\n6: docker0    inet 172.17.0.1/16 scope global docker0' : '' }) }
  assert.deepEqual(lanSubnetsOf(await readLocalAddresses(debian, { platform: 'systemd' })), ['192.168.3.0/24'])
  assert.deepEqual(lanSubnetsOf([{ kind: 'lan', address: '192.168.1.5', prefix: 32 }, { kind: 'lan', address: '8.8.8.8', prefix: 24 }, { kind: 'lan', address: '192.168.1.5' }]), [])
  assert.deepEqual(lanSubnetsOf(null), [])
})
