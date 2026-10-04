import assert from 'node:assert/strict'
import test from 'node:test'
import { predictRoute } from './penetration.mjs'
import { decideDnsServer } from './route-test.mjs'
import { createStore } from '../store/openbox-store.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { configMetaPath } from '../system/deploy.mjs'
import { buildCurrentConfig } from './deploy-runner.mjs'
import { clearFlipStateCache } from '../system/flip-files.mjs'
import { FLIP_FALLBACK_TAG, flipFlagTag } from '../engine/flip.mjs'

// 热切换结构下「读规则」的两处:规则页的路由推算(predictRoute)和 DNS 判定(decideDnsServer)。
// 成对规则里挂着开关的那一支,此刻算不算数要看已部署的开关状态——以前遇到 logical 规则是静默跳过。
const paths = createPaths('/opt/open-box')
const X = flipFlagTag({ id: 'x' })
const memStore = () => {
  const m = new Map()
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}
const seeded = () => {
  const store = memStore()
  store.setGroups([{ id: 'grp', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }])
  store.setProfile({
    rejectQuic: true, ipv6: true, ipv6Proxy: 'ipv4',
    dns: { split: true, mode: 'hijack' }, tun: { autoRedirect: true },
    routing: { fallbackDefault: 'direct', policies: [{ id: 'x', name: '测试站', default: '香港-自动', domainSuffix: ['site.test'] }] },
  })
  return store
}
const metaWith = (flags) => JSON.stringify({ dnsMode: 'hijack', flip: { mode: 'hot', flags, names: {}, bypass: {}, bypassMode: 'dynamic' } })
const ctxWith = (store, flags) => {
  const { config } = buildCurrentConfig(store, [], { rulesetDir: paths.rulesetDir })
  clearFlipStateCache()
  return { config, ctx: createMockContext({ files: { [configMetaPath(paths)]: metaWith(flags), [paths.configPath]: JSON.stringify(config), [paths.singbox]: 'x' } }) }
}
const resolveTarget = async () => ({ addresses: ['203.0.113.10'] })

test('decideDnsServer:开关 ON 走代理侧解析器,OFF 落到紧跟着的直连支;兜底同理;序号是内核规则表里的真实序号', async () => {
  const store = seeded()
  const on = ctxWith(store, { [X]: true, [FLIP_FALLBACK_TAG]: false })
  const viaProxy = await decideDnsServer(on.ctx, paths, on.config, 'a.site.test')
  assert.equal(viaProxy.server.tag, 'dns-proxy')
  assert.equal(viaProxy.viaProxy, true)
  const raw = on.config.dns.rules[viaProxy.ruleIndex]
  assert.equal(raw.type, 'logical', '命中的是挂着开关的那条')
  assert.equal(raw.server, 'dns-proxy')

  const off = ctxWith(store, { [X]: false, [FLIP_FALLBACK_TAG]: false })
  const direct = await decideDnsServer(off.ctx, paths, off.config, 'a.site.test')
  assert.equal(direct.server.tag, 'dns-direct')
  assert.equal(direct.viaProxy, false)
  assert.equal(direct.ruleIndex, viaProxy.ruleIndex + 1, '直连支紧跟在代理支后面')

  // 兜底:OFF → 一条都没命中,final 是直连侧;ON → 命中兜底的代理支
  const miss = await decideDnsServer(off.ctx, paths, off.config, 'nomatch.test')
  assert.equal(miss.ruleIndex, null)
  assert.equal(miss.server.tag, 'dns-direct')
  const fb = ctxWith(store, { [X]: false, [FLIP_FALLBACK_TAG]: true })
  const viaFallback = await decideDnsServer(fb.ctx, paths, fb.config, 'nomatch.test')
  assert.equal(viaFallback.server.tag, 'dns-proxy')
  assert.equal(viaFallback.viaProxy, true)
  // 显式传开关表的调用方不读元数据
  const forced = await decideDnsServer(off.ctx, paths, off.config, 'a.site.test', { flipState: { [X]: true } })
  assert.equal(forced.server.tag, 'dns-proxy')
})

test('predictRoute:挂着开关的拒绝规则按开关状态算——ON 时 v6 目标命中拒绝,OFF 时落到站点集本身;只管 UDP 的 QUIC 拒绝不会冒充成 TCP 443 的命中', async () => {
  const store = seeded()
  const deps = (ctx) => ({ store, ctx, paths, fetchImpl: async () => { throw new Error('no clash') }, resolveTarget })
  // 开关 ON + v6 目标:命中「同条件 + 开关 + ip_version 6」那条拒绝,回给前端的是展平后的规则
  const on = ctxWith(store, { [X]: true })
  const v6 = await predictRoute(deps(on.ctx), { target: 'a.site.test', port: 443, ipVersion: 6 })
  assert.equal(v6.status, 200)
  assert.equal(v6.body.matched.action, 'reject')
  assert.deepEqual(v6.body.matched.rule, { domain_suffix: ['site.test'], ip_version: 6, action: 'reject' })
  // 同样的开关状态,v4 的 TCP 443:QUIC 那条只管 UDP,不算命中;落到站点集
  const v4 = await predictRoute(deps(on.ctx), { target: 'a.site.test', port: 443, ipVersion: 4 })
  assert.equal(v4.body.matched.outbound, '测试站')
  assert.deepEqual(v4.body.matched.rule, { domain_suffix: ['site.test'], outbound: '测试站' })
  // 开关 OFF(站点集此刻直连):v6 也不拒,直接落到站点集
  const off = ctxWith(store, { [X]: false })
  const v6Direct = await predictRoute(deps(off.ctx), { target: 'a.site.test', port: 443, ipVersion: 6 })
  assert.equal(v6Direct.body.matched.outbound, '测试站')
  assert.notEqual(v6Direct.body.matched.action, 'reject')
  // 运行中的还不是热切换结构(元数据没有 flip 段):按档案默认出口算——默认走香港-自动 = ON
  clearFlipStateCache()
  const stale = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify({ dnsMode: 'hijack' }), [paths.singbox]: 'x' } })
  const guessed = await predictRoute(deps(stale), { target: 'a.site.test', port: 443, ipVersion: 6 })
  assert.equal(guessed.body.matched.action, 'reject')
})

test('decideDnsServer · 热切换 + FakeIP:开关 ON 时先记下占位规则、真解析器是代理侧那一组;OFF 时既没有占位也不走代理;兜底同理', async () => {
  const store = seeded()
  store.setProfile({ ipv6Proxy: 'node', dns: { split: true, mode: 'hijack', fakeIpForProxy: true } })
  const on = ctxWith(store, { [X]: true, [FLIP_FALLBACK_TAG]: true })
  const hit = await decideDnsServer(on.ctx, paths, on.config, 'a.site.test')
  assert.equal(hit.server.tag, 'dns-proxy')
  assert.equal(typeof hit.fakeIpRule, 'number', '占位地址那条记下来了')
  assert.equal(on.config.dns.rules[hit.fakeIpRule].server, 'dns-fakeip')
  const fb = await decideDnsServer(on.ctx, paths, on.config, 'nomatch.test')
  assert.equal(fb.server.tag, 'dns-proxy')
  assert.equal(typeof fb.fakeIpRule, 'number')
  const off = ctxWith(store, { [X]: false, [FLIP_FALLBACK_TAG]: false })
  const direct = await decideDnsServer(off.ctx, paths, off.config, 'a.site.test')
  assert.equal(direct.server.tag, 'dns-direct')
  assert.equal(direct.fakeIpRule, undefined, '翻到直连:A 查询回真实地址,没有占位')
  const miss = await decideDnsServer(off.ctx, paths, off.config, 'nomatch.test')
  assert.equal(miss.server.tag, 'dns-direct')
  assert.equal(miss.fakeIpRule, undefined)
})
