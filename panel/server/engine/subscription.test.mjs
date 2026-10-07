import assert from 'node:assert/strict'
import test from 'node:test'
import { detectSubscriptionFormat, parseSubscription } from './subscription.mjs'
import { describeEmptyResult } from './subscription-fetch.mjs'

test('detectSubscriptionFormat', () => {
  assert.equal(detectSubscriptionFormat('proxies:\n  - name: a\n    type: ss'), 'clash')
  assert.equal(detectSubscriptionFormat('{"outbounds":[]}'), 'singbox')
  assert.equal(detectSubscriptionFormat('ss://abc#x\nvmess://def'), 'sharelink')
})

test('parseSubscription base64 信封解包 + sharelink 按行', () => {
  const raw = 'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@example.com:8388#HK\nvmess://' +
    Buffer.from(JSON.stringify({ ps: 'US', add: 'us.com', port: '443', id: 'u', aid: '0', net: 'tcp' })).toString('base64')
  const envelope = Buffer.from(raw).toString('base64')
  const { nodes, format } = parseSubscription(envelope)
  assert.equal(format, 'sharelink')
  assert.deepEqual(nodes.map((n) => n.originalTag).sort(), ['HK', 'US'])
})

test('parseSubscription 直接 Clash 文本', () => {
  const { nodes, format } = parseSubscription('proxies:\n  - {name: A, type: ss, server: a.com, port: 8388, cipher: aes-256-gcm, password: pw}')
  assert.equal(format, 'clash')
  assert.equal(nodes[0].originalTag, 'A')
})

test('parseSubscription 无法识别的 sharelink 行计入 skipped', () => {
  const { nodes, skipped, format } = parseSubscription('ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@example.com:8388#HK\ngarbage-line')
  assert.equal(format, 'sharelink')
  assert.equal(nodes.length, 1)
  assert.equal(skipped.length, 1)
})

test('detectSubscriptionFormat/parseSubscription 首行为注释时仍识别 sharelink（修复8）', () => {
  const text = '# remark\nss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@example.com:8388#HK'
  assert.equal(detectSubscriptionFormat(text), 'sharelink')
  const { nodes, format } = parseSubscription(text)
  assert.equal(format, 'sharelink')
  assert.equal(nodes.length, 1)
})

// 节点全被跳过时,提示按「协议 + 原因」说清楚(GitHub #432 #374):以前只列协议名,XHTTP 的 VLESS 提示成「不受支持:vless」、
// 分享链接只有「不受支持:sharelink」
test('分享链接解析不了的记下协议和原因,提示里写明', () => {
  const vmessKcp = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'K', add: 'k.example.com', port: '443', id: '11111111-1111-1111-1111-111111111111', net: 'kcp' })).toString('base64')
  const text = [
    'vless://11111111-1111-1111-1111-111111111111@x.example.com:5443?security=reality&type=xhttp&mode=auto#X1',
    'vless://11111111-1111-1111-1111-111111111111@x.example.com:5444?security=reality&type=xhttp#X2',
    vmessKcp,
    'ssr://abcdef',
    'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@example.com:8388?plugin=shadow-tls%3Bhost%3Dx#STLS',
    'trojan://',
  ].join('\n')
  const parsed = parseSubscription(text)
  assert.equal(parsed.format, 'sharelink')
  assert.equal(parsed.nodes.length, 0)
  assert.deepEqual(parsed.skipped.map(({ type, reason, detail }) => [type, reason, detail]), [
    ['vless', 'unsupported-transport', 'unsupported transport: xhttp'],
    ['vless', 'unsupported-transport', 'unsupported transport: xhttp'],
    ['vmess', 'unsupported-transport', 'unsupported transport: kcp'],
    ['ssr', 'unsupported-type', undefined],
    ['ss', 'unsupported-plugin', 'shadow-tls'],
    ['trojan', 'invalid', undefined],
  ])
  assert.equal(
    describeEmptyResult(parsed),
    '订阅解析成功（sharelink 格式）,但节点都用不了:2 个 vless（XHTTP 传输,内核没有这种传输）、1 个 vmess（KCP 传输,内核没有这种传输）、' +
      '1 个 ssr（不支持这种协议）、1 个 ss（shadow-tls 插件不支持）、1 个 trojan（链接或字段写法不对）。',
  )
})

test('Clash 订阅里 XHTTP 传输的 vless 全被跳过时,提示写明是传输不支持', () => {
  const yaml = ['proxies:', ...[1, 2, 3].map((i) => `  - { name: V${i}, type: vless, server: v.example.com, port: 443, uuid: 11111111-1111-1111-1111-111111111111, network: xhttp, tls: true }`)].join('\n')
  const parsed = parseSubscription(yaml)
  assert.equal(parsed.nodes.length, 0)
  assert.equal(describeEmptyResult(parsed), '订阅解析成功（clash 格式）,但节点都用不了:3 个 vless（XHTTP 传输,内核没有这种传输）。')
})
