import assert from 'node:assert/strict'
import test from 'node:test'
import { createKernelStaleNodes, diffKernelNodes } from './kernel-stale.mjs'
import { createNode } from '../engine/node-model.mjs'
import { emitOutbound } from '../engine/emit-outbound.mjs'
import { planNodeDns, withNodeResolver } from '../engine/node-dns.mjs'
import { createStore } from '../store/openbox-store.mjs'

// 库里的节点带 subscriptionId(刷新订阅时补上的,createNode 本身不带)
const node = (tag, password, sub = 's1') => ({ ...createNode({ tag, type: 'shadowsocks', server: 'x.example.com', server_port: 8388, fields: { method: 'aes-256-gcm', password }, source: 'clash' }), subscriptionId: sub })

test('内核旧节点:部署配置里的出站和按面板此刻节点生成的逐个比——密码变了、内核里没有的都算,按订阅计数', () => {
  const deployed = [node('多宝 | 美国-01', 'old'), node('多宝 | 香港-01', 'same'), node('Nice | 日本-01', 'n')]
  const config = { outbounds: [{ type: 'selector', tag: '所有-手动', outbounds: [] }, ...deployed.map(emitOutbound)] }
  const nodes = [node('多宝 | 美国-01', 'new'), node('多宝 | 香港-01', 'same'), node('多宝 | 新加坡-01', 'x'), node('Nice | 日本-01', 'n', 's2')]
  const { staleTags, bySubscription } = diffKernelNodes({ config, nodes, subscriptions: [] })
  assert.deepEqual([...staleTags].sort(), ['多宝 | 新加坡-01', '多宝 | 美国-01'])
  assert.deepEqual(bySubscription, { s1: 2 })
})

test('内核旧节点:订阅配了专用解析器时按部署那样带上 domain_resolver 再比,不会误报', () => {
  const subs = [{ id: 's1', nodeDns: { url: 'https://1.1.1.1/dns-query' } }]
  const n = node('A', 'p')
  const plain = diffKernelNodes({ config: { outbounds: [emitOutbound(n)] }, nodes: [n], subscriptions: subs })
  assert.equal(plain.staleTags.size, 1, '部署配置里没带解析器 = 和此刻生成的不一样')
  const deployed = withNodeResolver(emitOutbound(n), planNodeDns(subs).bySubscription.get('s1'))
  assert.equal(diffKernelNodes({ config: { outbounds: [deployed] }, nodes: [n], subscriptions: subs }).staleTags.size, 0, '和部署一样带上解析器就对得上')
})

test('内核旧节点:还没部署过(没有 config.json)就没有「旧」;结果按 ttl 缓存,isStale 同步可用', async () => {
  const mem = new Map()
  const store = createStore({ get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v), del: (k) => mem.delete(k) })
  store.setSubscriptions([{ id: 's1', name: '多宝', enabled: true }])
  store.setNodes([node('A', 'new')])
  let file = null
  let t = 1000
  const ctx = { readFile: async () => { if (file === null) throw new Error('ENOENT'); return file } }
  const stale = createKernelStaleNodes({ ctx, paths: { configPath: '/x/config.json' }, store, ttlMs: 10_000, now: () => t })
  assert.deepEqual((await stale.get()).bySubscription, {})
  file = JSON.stringify({ outbounds: [emitOutbound(node('A', 'old'))] })
  assert.deepEqual((await stale.get()).bySubscription, {}, 'ttl 内用缓存')
  assert.deepEqual((await stale.refresh()).bySubscription, { s1: 1 })
  assert.equal(stale.isStale('A'), true)
  assert.equal(stale.isStale('B'), false)
  t += 20_000
  assert.equal(stale.isStale('A'), true, '过期了先用手头那份,后台刷新')
})
