import assert from 'node:assert/strict'
import test from 'node:test'
import { emitOutbound } from './emit-outbound.mjs'
import { createNode } from './node-model.mjs'

test('shadowsocks emit', () => {
  const n = createNode({ tag: '美国-01', type: 'shadowsocks', server: 'a.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'pw' }, source: 'clash' })
  assert.deepEqual(emitOutbound(n), { type: 'shadowsocks', tag: '美国-01', server: 'a.com', server_port: 8388, method: 'aes-256-gcm', password: 'pw' })
  const withPlugin = createNode({ tag: '美国-02', type: 'shadowsocks', server: 'a.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'pw', plugin: 'obfs-local', plugin_opts: 'obfs=http;obfs-host=www.bing.com' }, source: 'clash' })
  assert.deepEqual(emitOutbound(withPlugin), { type: 'shadowsocks', tag: '美国-02', server: 'a.com', server_port: 8388, method: 'aes-256-gcm', password: 'pw', plugin: 'obfs-local', plugin_opts: 'obfs=http;obfs-host=www.bing.com' })
})

test('vmess emit 带 ws + tls', () => {
  const n = createNode({ tag: 'JP-01', type: 'vmess', server: 'a.com', server_port: 443, fields: { uuid: 'u', alter_id: 0, security: 'auto', transport: { type: 'ws', path: '/vm', headers: { Host: 'cdn.com' } }, tls: { enabled: true, server_name: 'a.com' } }, source: 'sharelink' })
  const o = emitOutbound(n)
  assert.equal(o.type, 'vmess'); assert.equal(o.uuid, 'u'); assert.equal(o.alter_id, 0); assert.equal(o.security, 'auto')
  assert.deepEqual(o.transport, { type: 'ws', path: '/vm', headers: { Host: 'cdn.com' } })
  // 证书校验一律跳过(见 emit-outbound.mjs 的说明)
  assert.deepEqual(o.tls, { enabled: true, server_name: 'a.com', insecure: true })
})

test('QUIC 出站（tuic / hysteria2）不写 utls:内核在这条路径上不支持,写了每次拨号直接失败', () => {
  const fields = (extra) => ({ password: 'pw', tls: { enabled: true, server_name: 'kami.im', alpn: ['h3'], utls: { enabled: true, fingerprint: 'chrome' } }, ...extra })
  const h = createNode({ tag: 'H', type: 'hysteria2', server: 'a.com', server_port: 8443, fields: fields(), source: 'sharelink' })
  assert.deepEqual(emitOutbound(h).tls, { enabled: true, server_name: 'kami.im', alpn: ['h3'], insecure: true })
  const t = createNode({ tag: 'T', type: 'tuic', server: 'a.com', server_port: 8443, fields: { uuid: 'u', password: 'pw', tls: { enabled: true, server_name: 'kami.im', utls: { enabled: true, fingerprint: 'chrome' } } }, source: 'sharelink' })
  assert.deepEqual(emitOutbound(t).tls, { enabled: true, server_name: 'kami.im', insecure: true })
  // 非 QUIC 的出站照旧带 utls
  const v = createNode({ tag: 'V', type: 'vless', server: 'a.com', server_port: 443, fields: { uuid: 'u', tls: { enabled: true, server_name: 'a.com', utls: { enabled: true, fingerprint: 'chrome' } } }, source: 'sharelink' })
  assert.deepEqual(emitOutbound(v).tls.utls, { enabled: true, fingerprint: 'chrome' })
})

test('证书校验一律跳过:链接里没写 insecure 也跳过（机场证书自签 / 过期 / 张冠李戴是常态）;REALITY 例外', () => {
  const v = createNode({ tag: 'V', type: 'trojan', server: 'a.com', server_port: 443, fields: { password: 'pw', tls: { enabled: true, server_name: 'a.com' } }, source: 'sharelink' })
  assert.equal(emitOutbound(v).tls.insecure, true)
  const r = createNode({ tag: 'R', type: 'vless', server: 'a.com', server_port: 443, fields: { uuid: 'u', tls: { enabled: true, server_name: 'a.com', reality: { enabled: true, public_key: 'PK', short_id: 'ab' } } }, source: 'sharelink' })
  assert.equal(emitOutbound(r).tls.insecure, undefined, 'REALITY 靠公钥验证,不该写 insecure')
})

test('vless reality emit 强制补 utls', () => {
  const n = createNode({ tag: 'R-01', type: 'vless', server: 'a.com', server_port: 443, fields: { uuid: 'u', flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: 'a.com', reality: { enabled: true, public_key: 'PK', short_id: 'ab' } } }, source: 'sharelink' })
  const o = emitOutbound(n)
  assert.equal(o.flow, 'xtls-rprx-vision')
  assert.equal(o.tls.reality.public_key, 'PK')
  assert.equal(o.tls.utls.enabled, true)          // 强制补
  assert.equal(o.tls.utls.fingerprint, 'chrome')
})

test('hysteria2 obfs / tuic emit', () => {
  const h = createNode({ tag: 'H', type: 'hysteria2', server: 'a.com', server_port: 8443, fields: { password: 'pw', tls: { enabled: true, server_name: 'a.com' }, obfs: { type: 'salamander', password: 'op' } }, source: 'sharelink' })
  assert.deepEqual(emitOutbound(h).obfs, { type: 'salamander', password: 'op' })
  const t = createNode({ tag: 'T', type: 'tuic', server: 'a.com', server_port: 443, fields: { uuid: 'u', password: 'pw', congestion_control: 'bbr', tls: { enabled: true, server_name: 'a.com', alpn: ['h3'] } }, source: 'sharelink' })
  const to = emitOutbound(t)
  assert.equal(to.congestion_control, 'bbr'); assert.deepEqual(to.tls.alpn, ['h3'])
})

test('wireguard 走 emitOutbound 抛错', () => {
  const w = createNode({ tag: 'W', type: 'wireguard', server: 'a.com', server_port: 51820, fields: { private_key: 'p', peer_public_key: 'q', local_address: ['10.0.0.2/32'] }, source: 'clash' })
  assert.throws(() => emitOutbound(w), /endpoint/)
})

test('socks emit:只出版本 / 账号 / 密码,没有 tls 与 transport', () => {
  const n = createNode({ tag: 'S', type: 'socks', server: '1.2.3.4', server_port: 1080, fields: { username: 'u', password: 'p' }, source: 'sharelink' })
  assert.deepEqual(emitOutbound(n), { type: 'socks', tag: 'S', server: '1.2.3.4', server_port: 1080, username: 'u', password: 'p' })

  // 无认证:不写空的 username / password
  const anon = createNode({ tag: 'A', type: 'socks', server: '1.2.3.4', server_port: 1080, fields: {}, source: 'sharelink' })
  assert.deepEqual(emitOutbound(anon), { type: 'socks', tag: 'A', server: '1.2.3.4', server_port: 1080 })

  // version 只有 4 / 4a 写出来,5 是内核默认值
  const v4 = createNode({ tag: 'V4', type: 'socks', server: '1.2.3.4', server_port: 1080, fields: { version: '4' }, source: 'sharelink' })
  assert.equal(emitOutbound(v4).version, '4')
  const v5 = createNode({ tag: 'V5', type: 'socks', server: '1.2.3.4', server_port: 1080, fields: { version: '5' }, source: 'sharelink' })
  assert.equal(emitOutbound(v5).version, undefined)
})

test('库里存的老节点:short_id "null" 不写、flow -udp443 归一成 vision（GitHub #19 #23）', () => {
  const n = createNode({ tag: 'R-old', type: 'vless', server: 'a.com', server_port: 443, fields: { uuid: 'u', flow: 'xtls-rprx-vision-udp443', tls: { enabled: true, server_name: 'a.com', reality: { enabled: true, public_key: 'PK', short_id: 'null' } } }, source: 'clash' })
  const o = emitOutbound(n)
  assert.equal(o.flow, 'xtls-rprx-vision')
  assert.equal(o.tls.reality.short_id, undefined)
  assert.equal(o.tls.reality.public_key, 'PK')
  const d = createNode({ tag: 'R-direct', type: 'vless', server: 'a.com', server_port: 443, fields: { uuid: 'u', flow: 'xtls-rprx-direct' }, source: 'clash' })
  assert.equal(emitOutbound(d).flow, undefined)
})

test('库里存的旧 unsafe 指纹在出站生成时归一为 chrome', () => {
  const n = createNode({ tag: 'U-old', type: 'trojan', server: 'a.com', server_port: 443, fields: { password: 'pw', tls: { enabled: true, server_name: 'a.com', utls: { enabled: true, fingerprint: 'unsafe' } } }, source: 'clash' })
  assert.equal(emitOutbound(n).tls.utls.fingerprint, 'chrome')
})

// GitHub #171:机场的 HY2 节点常靠端口跳跃,三种来源写法都要落到内核的 server_ports / hop_interval
test('hysteria2 端口跳跃:Clash 的 ports / 链接的 mport / 端口位直接写范围 → server_ports(每段 a:b)+ hop_interval;写坏的整个不带', async () => {
  const { parseClashProxies } = await import('./clash.mjs')
  const { parseShareLink } = await import('./sharelink.mjs')
  const { normalizeHopPorts, normalizeHopInterval } = await import('./node-fields.mjs')

  assert.deepEqual(normalizeHopPorts('20000-40000,50000'), ['20000:40000', '50000:50000'])
  assert.deepEqual(normalizeHopPorts(['2080:3000']), ['2080:3000'], '导入的 sing-box 出站已经是冒号写法')
  assert.deepEqual(normalizeHopPorts('443'), [], '只有一个端口不算跳跃')
  assert.deepEqual(normalizeHopPorts('20000-abc'), [])
  assert.deepEqual(normalizeHopPorts('40000-20000'), [])
  assert.deepEqual(normalizeHopPorts('1-70000'), [])
  assert.deepEqual(normalizeHopPorts(undefined), [])
  assert.equal(normalizeHopInterval(30), '30s')
  assert.equal(normalizeHopInterval('15s'), '15s')
  assert.equal(normalizeHopInterval(2), '', '官方下限 5 秒,太小就按内核默认')
  assert.equal(normalizeHopInterval('soon'), '')

  // Clash:带 port 和只写 ports 两种
  const { nodes } = parseClashProxies(`proxies:
  - { name: HY2-A, type: hysteria2, server: a.example.com, port: 443, ports: 20000-40000, hop-interval: 15, password: pw, sni: a.example.com }
  - { name: HY2-B, type: hysteria2, server: b.example.com, ports: "30000-31000,35000", password: pw }
  - { name: HY2-C, type: hysteria2, server: c.example.com, port: 8443, password: pw }
`)
  const [a, b, c] = nodes.map((n) => emitOutbound(n))
  assert.equal(a.server_port, 443)
  assert.deepEqual(a.server_ports, ['20000:40000'])
  assert.equal(a.hop_interval, '15s')
  assert.equal(b.server_port, 30000, '没写 port:拿范围的第一个端口当展示端口')
  assert.deepEqual(b.server_ports, ['30000:31000', '35000:35000'])
  assert.equal(b.hop_interval, undefined)
  assert.equal(c.server_ports, undefined)

  // 分享链接:mport 参数
  const m = emitOutbound(parseShareLink('hysteria2://pw@h.example.com:443?sni=h.example.com&mport=20000-40000&insecure=1#M'))
  assert.equal(m.server_port, 443)
  assert.deepEqual(m.server_ports, ['20000:40000'])
  assert.equal(m.tls.insecure, true)
  // 分享链接:官方写法,范围直接写在端口位置(带不带路径斜杠都认)
  const o1 = parseShareLink('hy2://pw@h.example.com:20000-40000/?sni=h.example.com#O1')
  assert.equal(o1.server, 'h.example.com')
  assert.equal(o1.server_port, 20000)
  assert.deepEqual(emitOutbound(o1).server_ports, ['20000:40000'])
  const o2 = emitOutbound(parseShareLink('hysteria2://pw@h.example.com:443,5000-6000?sni=h.example.com#O2'))
  assert.equal(o2.server_port, 443)
  assert.deepEqual(o2.server_ports, ['443:443', '5000:6000'])
  // 普通链接不受影响
  const plain = emitOutbound(parseShareLink('hysteria2://pw@h.example.com:8443?sni=h.example.com#P'))
  assert.equal(plain.server_port, 8443)
  assert.equal(plain.server_ports, undefined)

  // 导入的 sing-box 出站:字段原样带过来,写坏的不进配置
  const good = emitOutbound(createNode({ tag: 'S', type: 'hysteria2', server: 's.example.com', server_port: 443, fields: { password: 'pw', tls: { enabled: true }, server_ports: ['2080:3000'], hop_interval: '10s' }, source: 'singbox' }))
  assert.deepEqual(good.server_ports, ['2080:3000'])
  assert.equal(good.hop_interval, '10s')
  const bad = emitOutbound(createNode({ tag: 'S2', type: 'hysteria2', server: 's.example.com', server_port: 443, fields: { password: 'pw', tls: { enabled: true }, server_ports: ['oops'] }, source: 'singbox' }))
  assert.equal(bad.server_ports, undefined)
})
