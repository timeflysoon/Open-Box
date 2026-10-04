import assert from 'node:assert/strict'
import test from 'node:test'
import { routeForUpstream, routeProxyDnsUpstreams } from './dns-upstream-route.mjs'
import { createStore } from '../store/openbox-store.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'

// 代理 DNS 上游按目标分流判线路:用的就是规则页的推算(api/penetration.mjs 的 predictRoute),同一张规则表、同一套判法
const paths = createPaths('/opt/open-box')
const memStore = () => {
  const m = new Map()
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}
const NODES = [{ tag: 'HK-01', type: 'shadowsocks', server: 'hk.example.com', server_port: 443, fields: { method: 'aes-256-gcm', password: 'x' } }]
const storeWith = (routing, dns = {}) => {
  const store = memStore()
  store.setProfile({ directForNodes: false, dns: { split: true, mode: 'hijack', direct: '9.9.9.9', proxy: '1.1.1.1', ...dns }, routing })
  store.setGroups([{ id: 'hk', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }])
  store.setNodes(NODES)
  return store
}
// 内核里各组此刻选的
const clashNow = (map) => async (url) => {
  const tag = decodeURIComponent(String(url).split('/proxies/')[1] || '')
  return { ok: true, status: 200, json: async () => (map[tag] ? { now: map[tag] } : {}) }
}

test('上游地址命中前置自定义分流的 IP 行:出口就是那一行的出口,链路按内核此刻的选择下钻', async () => {
  const store = storeWith({ policies: [], fallbackDefault: 'direct', custom: { name: '前置自定义', rules: [{ type: 'ipCidr', value: '1.1.1.0/24', outbound: '香港-自动' }] } })
  const deps = { store, ctx: createMockContext({}), paths, fetchImpl: clashNow({ '香港-自动': 'HK-01', 其他: '直连' }) }
  const r = await routeForUpstream(deps, { server: '1.1.1.1', port: 53, protocol: 'tcp' })
  assert.equal(r.error, undefined, JSON.stringify(r))
  assert.equal(r.outbound, '香港-自动')
  assert.equal(r.reject, false)
  assert.deepEqual(r.owner, { kind: 'custom', name: '前置自定义' })
  assert.deepEqual(r.chain, ['香港-自动', 'HK-01'])
  // 什么都没命中:兜底「其他」
  const miss = await routeForUpstream(deps, { server: '8.8.8.8', port: 53, protocol: 'udp' })
  assert.equal(miss.outbound, '其他')
  assert.equal(miss.ruleIndex, null)
})

test('上游地址被目标分流拒绝:reject,出口留空', async () => {
  const store = storeWith({ policies: [], fallbackDefault: 'direct', custom: { rules: [{ type: 'ipCidr', value: '1.1.1.1/32', outbound: 'block' }] } })
  const r = await routeForUpstream({ store, ctx: createMockContext({}), paths, fetchImpl: clashNow({}) }, { server: '1.1.1.1', port: 53, protocol: 'tcp' })
  assert.equal(r.reject, true)
  assert.equal(r.outbound, '')
})

test('只管 UDP / 只管 TCP 的规则按上游选的协议判;主上游和备用上游各判一次', async () => {
  const store = storeWith(
    { policies: [], fallbackDefault: 'direct', custom: { rules: [{ type: 'port', value: '53', network: 'udp', outbound: '香港-自动' }] } },
    { proxyProtocol: 'udp', proxyExtras: [{ server: '8.8.8.8', protocol: 'tcp' }] },
  )
  const list = await routeProxyDnsUpstreams({ store, ctx: createMockContext({}), paths, fetchImpl: clashNow({ '香港-自动': 'HK-01' }) }, store.getProfile())
  assert.deepEqual(list.map((r) => [r.server, r.protocol, r.port]), [['1.1.1.1', 'udp', 53], ['8.8.8.8', 'tcp', 53]])
  assert.ok(list.every((r) => !r.error), JSON.stringify(list))
})
