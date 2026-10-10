import assert from 'node:assert/strict'
import test from 'node:test'
import { createNode, NODE_TYPES, isNodeType, normalizeRealityPublicKey } from './node-model.mjs'

test('createNode 规范化端口为整数并回填 originalTag', () => {
  const n = createNode({ tag: '美国 01', type: 'shadowsocks', server: 'a.com', server_port: '443', source: 'clash' })
  assert.equal(n.server_port, 443)
  assert.equal(n.originalTag, '美国 01')
  assert.deepEqual(n.fields, {})
})

test('createNode 保留显式 originalTag 与 fields', () => {
  const n = createNode({ tag: 'x', originalTag: 'orig', type: 'vmess', server: 'a', server_port: 1, fields: { uuid: 'u' }, source: 'sharelink' })
  assert.equal(n.originalTag, 'orig')
  assert.equal(n.fields.uuid, 'u')
})

test('createNode 不校验节点名称,原样保留特殊字符和标量名称', () => {
  const tag = 'Disaster Backup² HK 2x / [备用]（测试）'
  const n = createNode({ tag, type: 'trojan', server: 'a.com', server_port: 443, source: 'clash' })
  assert.equal(n.tag, tag)
  assert.equal(n.originalTag, tag)

  const numeric = createNode({ tag: 123, originalTag: false, type: 'trojan', server: 'b.com', server_port: 443, source: 'clash' })
  assert.equal(numeric.tag, '123')
  assert.equal(numeric.originalTag, 'false')
})

test('createNode 缺 server 抛错', () => {
  assert.throws(() => createNode({ tag: 'x', type: 'trojan', server_port: 1, source: 'clash' }), /server/)
})

test('createNode 非法端口抛错', () => {
  assert.throws(() => createNode({ tag: 'x', type: 'trojan', server: 'a', server_port: 'abc', source: 'clash' }), /port/)
})

test('NODE_TYPES 覆盖十协议,isNodeType 判定', () => {
  assert.deepEqual([...NODE_TYPES].sort(), ['anytls','http','hysteria2','shadowsocks','socks','trojan','tuic','vless','vmess','wireguard'])
  // http 是第十个:住宅代理商给的 HTTP / HTTPS 代理账号(链式代理用)
  assert.equal(isNodeType('http'), true)
  assert.equal(isNodeType('vless'), true)
  // anytls 是第八个:真机上遇到过整个订阅 35 个节点全是 anytls 的机场,不支持就是 0 个节点
  assert.equal(isNodeType('anytls'), true)
  // socks 是第九个:局域网里已有的 socks5 代理(另一台路由器、本机软件)也能当出口用
  assert.equal(isNodeType('socks'), true)
  // 换一个确实不支持的类型继续守住"未知类型判 false"这条
  assert.equal(isNodeType('ssh'), false)
})

// GitHub #518:REALITY 公钥写坏的节点内核一读就整个起不来,建节点时就挡掉(解析订阅时记进「跳过」)
test('createNode:REALITY 公钥要是 32 字节的 base64url;标准 base64 写法换过来,写坏 / 没写的抛 invalid-field', () => {
  const reality = (publicKey) => ({ tls: { enabled: true, server_name: 'a.com', reality: { enabled: true, ...(publicKey === undefined ? {} : { public_key: publicKey }) } } })
  const make = (publicKey) => createNode({ tag: 'R', type: 'vless', server: 'a.com', server_port: 443, fields: { uuid: 'u', ...reality(publicKey) }, source: 'clash' })
  assert.equal(make('WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo').fields.tls.reality.public_key, 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo')
  assert.equal(make('+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/s=').fields.tls.reality.public_key, '-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_s', '+ / 和末尾的 = 换成 base64url')
  for (const [bad, detail] of [['111111111111111111111111111111111111111', 'invalid reality public_key'], ['dfsdfI', 'invalid reality public_key'], ['WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo!', 'invalid reality public_key'], [undefined, 'missing reality public_key']]) {
    assert.throws(() => make(bad), (err) => err.code === 'invalid-field' && err.detail === detail, String(bad))
  }
  // 没开 TLS 的不管(生成出站时根本不带 reality)
  assert.doesNotThrow(() => createNode({ tag: 'T', type: 'vless', server: 'a.com', server_port: 443, fields: { uuid: 'u', tls: { enabled: false, reality: { enabled: true, public_key: 'x' } } }, source: 'clash' }))
  assert.equal(normalizeRealityPublicKey(' WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo '), 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo')
  assert.equal(normalizeRealityPublicKey(''), null)
})

