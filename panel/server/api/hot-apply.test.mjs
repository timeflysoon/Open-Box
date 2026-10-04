import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { configMetaPath, deploySideInputs, hotFlipInputs } from '../system/deploy.mjs'
import { createStore } from '../store/openbox-store.mjs'
import { createNode } from '../engine/node-model.mjs'
import { filterKey, filterSettings } from '../engine/dns-filter.mjs'
import { configFromInputs, directHostDomains } from './deploy-runner.mjs'
import { applyHotOutbounds, canonical, createHotApplier, createRestartPending, planOutboundUpdate, restartReasons, withOutbounds } from './hot-apply.mjs'

const paths = createPaths('/opt/open-box')
const STATUS = `${paths.initd.core} status`

const node = (tag, password, server = 'x.example.com') => ({ ...createNode({ tag, type: 'shadowsocks', server, server_port: 8388, fields: { method: 'aes-256-gcm', password }, source: 'clash' }), subscriptionId: 's1' })
const memStore = () => {
  const m = new Map()
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}
const INPUTS = { systemDns: ['223.5.5.5'], localSubnets: ['192.168.1.0/24'], directHostCidrs: [], selections: {}, dnsUpstreamRoutes: [] }

// 部署一次:按此刻的库生成配置、连同元数据(和 system/deploy.mjs 写的同一套字段)放进 mock 文件系统
const deploy = (store, { running = true } = {}) => {
  const { config, failover } = configFromInputs(store, paths, INPUTS)
  const profile = store.getProfile()
  const meta = {
    generatedAt: '2026-09-30T00:00:00.000Z',
    buildInputs: { ...INPUTS, directHostDomains: directHostDomains(store), autoRedirectFallback: false, deploySide: deploySideInputs(profile) },
    failover,
    dnsFilter: { enabled: false, key: filterKey(filterSettings(profile)) },
    firstLayer: { inputs: hotFlipInputs(profile) },
  }
  const ctx = createMockContext({
    files: { [paths.configPath]: JSON.stringify(config), [configMetaPath(paths)]: JSON.stringify(meta) },
    execResults: { [STATUS]: running ? { code: 0, stdout: 'running' } : { code: 3, stdout: 'inactive' } },
  })
  return { ctx, config, meta }
}
const seeded = () => {
  const store = memStore()
  store.setSubscriptions([{ id: 's1', name: '机场', enabled: true }])
  store.setNodes([node('机场 | 香港-01', 'old'), node('机场 | 美国-01', 'same')])
  return store
}
const kernel = (status = 200, body = { created: [], replaced: [], removed: [] }) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { calls, fetchImpl }
}
const tagsOf = (list) => list.map((o) => o.tag)

test('planOutboundUpdate:节点换了密码 → 节点先建,拿着它的组、拿着组的站点集一起重建;selector 只有 default 不同不算变', () => {
  const store = seeded()
  const { config } = configFromInputs(store, paths, INPUTS)
  store.setNodes([node('机场 | 香港-01', 'new'), node('机场 | 美国-01', 'same')])
  const fresh = configFromInputs(store, paths, { ...INPUTS, selections: { '所有-手动': '机场 | 美国-01' } }).config
  const plan = planOutboundUpdate(config, fresh)
  assert.equal(plan.error, undefined)
  const tags = tagsOf(plan.outbounds)
  assert.equal(tags[0], '机场 | 香港-01', '被依赖的节点排最前')
  assert.ok(!tags.includes('机场 | 美国-01'), '没变的节点不动')
  for (const group of ['所有-自动', '所有-手动']) {
    assert.ok(tags.includes(group), `${group} 拿着换掉的节点,要重建`)
    assert.ok(tags.indexOf(group) > tags.indexOf('机场 | 香港-01'))
  }
  const fallback = fresh.route.final
  assert.ok(tags.includes(fallback) && tags.indexOf(fallback) > tags.indexOf('所有-自动'), '兜底站点集拿着节点组,排在组后面')
  assert.deepEqual(plan.remove, [])
  assert.deepEqual(plan.created, [])
  // 只换选择(FakeIP 开着时 selector 的 default 跟着选择写):什么都不用换
  const same = configFromInputs(store, paths, { ...INPUTS, selections: { [fallback]: '所有-手动' } }).config
  const noop = planOutboundUpdate(fresh, same)
  assert.equal(noop.outbounds.length + noop.endpoints.length + noop.remove.length, 0)
})

test('planOutboundUpdate:新增节点算 created,删掉的节点在组重建之后删;删掉的组里还有要删的成员,组先删', () => {
  const a = { type: 'shadowsocks', tag: 'A', server: 'a', server_port: 1, method: 'aes-256-gcm', password: 'p' }
  const b = { ...a, tag: 'B', server: 'b' }
  const c = { ...a, tag: 'C', server: 'c' }
  const deployed = { outbounds: [a, b, { type: 'urltest', tag: 'G', outbounds: ['A', 'B'] }, { type: 'selector', tag: 'H', outbounds: ['B'] }, { type: 'selector', tag: 'P', outbounds: ['G', 'H'] }] }
  const fresh = { outbounds: [a, c, { type: 'urltest', tag: 'G', outbounds: ['A', 'C'] }, { type: 'selector', tag: 'P', outbounds: ['G'] }] }
  const plan = planOutboundUpdate(deployed, fresh)
  assert.deepEqual(tagsOf(plan.outbounds), ['C', 'G', 'P'])
  assert.deepEqual(plan.created, ['C'])
  assert.deepEqual(plan.replaced, ['G', 'P'])
  assert.deepEqual(plan.remove, ['H', 'B'], 'H 拿着 B,先删 H')
})

test('planOutboundUpdate:链式代理的上游一起换时上游在前;同名从 endpoint 变成出站、endpoint 依赖这次要换的出站都交给重启', () => {
  const up = { type: 'shadowsocks', tag: 'UP', server: 'u', server_port: 1, method: 'aes-256-gcm', password: 'p' }
  const chain = { type: 'socks', tag: 'CHAIN', server: 'c', server_port: 2, detour: 'UP' }
  const plan = planOutboundUpdate({ outbounds: [up, chain] }, { outbounds: [{ ...chain, server_port: 3 }, { ...up, password: 'q' }] })
  assert.deepEqual(tagsOf(plan.outbounds), ['UP', 'CHAIN'])
  const wg = { type: 'wireguard', tag: 'W', address: ['10.0.0.2/32'], private_key: 'k', peers: [] }
  assert.match(planOutboundUpdate({ outbounds: [], endpoints: [wg] }, { outbounds: [{ ...up, tag: 'W' }] }).error, /endpoint 和普通出站之间/)
  assert.match(planOutboundUpdate({ outbounds: [up], endpoints: [wg] }, { outbounds: [{ ...up, password: 'z' }], endpoints: [{ ...wg, detour: 'UP' }] }).error, /endpoint「W」依赖/)
})

test('withOutbounds:只换出站 / endpoint,别的原样(键的先后照旧);新配置没有 endpoint 就去掉', () => {
  const deployed = { log: { level: 'warn' }, dns: { x: 1 }, outbounds: [{ tag: 'a' }], route: { final: 'a' }, endpoints: [{ tag: 'w' }] }
  const next = withOutbounds(deployed, { outbounds: [{ tag: 'b' }] })
  assert.deepEqual(Object.keys(next), ['log', 'dns', 'outbounds', 'route'])
  assert.deepEqual(next.outbounds, [{ tag: 'b' }])
  assert.equal(next.dns, deployed.dns)
  assert.deepEqual(withOutbounds({ outbounds: [] }, { outbounds: [], endpoints: [{ tag: 'w2' }] }).endpoints, [{ tag: 'w2' }])
})

test('restartReasons:出站之外的差别才算要重启——分流、DNS 设置、入口放行端口、域名过滤设置各归一类', () => {
  const store = seeded()
  const { config, meta } = deploy(store)
  const profile = store.getProfile()
  assert.deepEqual(restartReasons({ deployed: config, fresh: config, meta, profile }), [])
  store.setNodes([node('机场 | 香港-01', 'new')])
  const nodesOnly = configFromInputs(store, paths, INPUTS).config
  assert.deepEqual(restartReasons({ deployed: config, fresh: nodesOnly, meta, profile }), [], '只有节点变了不算')
  store.setProfile({ rejectQuic: !profile.rejectQuic })
  const quic = configFromInputs(store, paths, INPUTS).config
  assert.ok(restartReasons({ deployed: config, fresh: quic, meta, profile: store.getProfile() }).includes('route'))
  store.setProfile({ rejectQuic: profile.rejectQuic, bypassPorts: '2233' })
  assert.deepEqual(restartReasons({ deployed: config, fresh: config, meta, profile: store.getProfile() }), ['system'], '入口放行端口只写进 nft,不进配置')
  store.setProfile({ bypassPorts: profile.bypassPorts || '', dns: { filter: { enabled: true, lists: [] } } })
  assert.ok(restartReasons({ deployed: config, fresh: config, meta, profile: store.getProfile() }).includes('dns'))
})

test('applyHotOutbounds:换了密码的节点连同组交给内核在线换,成功后运行中的配置写成新出站,元数据记时间;故障转移映射没变不换 generatedAt', async () => {
  const store = seeded()
  const { ctx } = deploy(store)
  store.setNodes([node('机场 | 香港-01', 'new'), node('机场 | 美国-01', 'same')])
  const { calls, fetchImpl } = kernel()
  const result = await applyHotOutbounds({ store, ctx, paths, fetchImpl, now: () => new Date('2026-09-30T08:00:00.000Z') })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:9095/openbox/outbounds')
  assert.equal(calls[0].init.method, 'PUT')
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${store.getClashSecret()}`)
  assert.equal(calls[0].body.outbounds[0].tag, '机场 | 香港-01')
  assert.equal(calls[0].body.outbounds[0].password, 'new')
  assert.deepEqual(calls[0].body.remove, [])
  const written = JSON.parse(ctx.files[paths.configPath])
  assert.equal(written.outbounds.find((o) => o.tag === '机场 | 香港-01').password, 'new')
  const meta = JSON.parse(ctx.files[configMetaPath(paths)])
  assert.equal(meta.hotAppliedAt, '2026-09-30T08:00:00.000Z')
  assert.equal(meta.generatedAt, '2026-09-30T00:00:00.000Z')
  assert.ok(ctx.calls.some((c) => c.args[0] === 'check'), '换之前 sing-box check 过整份')
  assert.equal(ctx.calls.some((c) => c.args.includes('restart')), false, '不重启内核')
  // 再来一次:运行中的已经是新的,什么都不发
  const again = await applyHotOutbounds({ store, ctx, paths, fetchImpl })
  assert.deepEqual({ ok: again.ok, changed: again.changed }, { ok: true, changed: 0 })
  assert.equal(calls.length, 1)
})

test('applyHotOutbounds:内核没在跑 / 老内核没有接口 / 内核核对不过 / 校验不过——都不动配置文件', async () => {
  const store = seeded()
  const stopped = deploy(store, { running: false })
  store.setNodes([node('机场 | 香港-01', 'new')])
  assert.equal((await applyHotOutbounds({ store, ctx: stopped.ctx, paths, fetchImpl: kernel().fetchImpl })).skipped, 'not-running')

  for (const [status, reason] of [[404, 'kernel-old'], [409, 'kernel-error'], [500, 'kernel-error']]) {
    const s = seeded()
    const { ctx, config } = deploy(s)
    s.setNodes([node('机场 | 香港-01', 'new')])
    const r = await applyHotOutbounds({ store: s, ctx, paths, fetchImpl: kernel(status, { message: 'group[x] holds y' }).fetchImpl })
    assert.equal(r.ok, false)
    assert.equal(r.reason, reason)
    assert.deepEqual(JSON.parse(ctx.files[paths.configPath]), config, `${status}:配置文件不动`)
  }

  const s = seeded()
  const { ctx, config } = deploy(s)
  s.setNodes([node('机场 | 香港-01', 'new')])
  ctx.execResults = undefined
  const failCheck = createMockContext({ files: ctx.files, execResults: { [STATUS]: { code: 0, stdout: 'running' } }, defaultExec: { code: 1, stderr: 'FATAL: bad' } })
  const k = kernel()
  const r = await applyHotOutbounds({ store: s, ctx: failCheck, paths, fetchImpl: k.fetchImpl })
  assert.equal(r.reason, 'validate')
  assert.equal(k.calls.length, 0, '校验不过不找内核')
  assert.deepEqual(JSON.parse(failCheck.files[paths.configPath]), config)
})

test('applyHotOutbounds:老元数据(没有 buildInputs)不在线换,等重启;故障转移组加了页签、映射变了就换 generatedAt', async () => {
  const store = seeded()
  const { ctx, meta } = deploy(store)
  const old = { ...meta }
  delete old.buildInputs
  const oldCtx = createMockContext({ files: { ...ctx.files, [configMetaPath(paths)]: JSON.stringify(old) }, execResults: { [STATUS]: { code: 0, stdout: 'running' } } })
  store.setNodes([node('机场 | 香港-01', 'new')])
  assert.equal((await applyHotOutbounds({ store, ctx: oldCtx, paths, fetchImpl: kernel().fetchImpl })).reason, 'old-meta')

  const fo = seeded()
  fo.setGroups([...fo.getGroups(), { id: 'f1', name: '故转', type: 'failover', lanes: [{ id: 't1', name: '主', members: ['机场 | 香港-01'] }, { id: 't2', name: '备', members: ['机场 | 美国-01'] }] }])
  const d = deploy(fo)
  fo.setNodes([node('机场 | 香港-01', 'old'), node('机场 | 美国-01', 'same'), node('机场 | 日本-01', 'j')])
  fo.setGroups(fo.getGroups().map((g) => (g.id === 'f1' ? { ...g, lanes: [...g.lanes, { id: 't3', name: '三', members: ['机场 | 日本-01'] }] } : g)))
  const r = await applyHotOutbounds({ store: fo, ctx: d.ctx, paths, fetchImpl: kernel().fetchImpl, now: () => new Date('2026-09-30T09:00:00.000Z') })
  assert.equal(r.ok, true, JSON.stringify(r))
  const meta2 = JSON.parse(d.ctx.files[configMetaPath(paths)])
  assert.equal(meta2.generatedAt, '2026-09-30T09:00:00.000Z', '故障转移映射变了,管理器按新版本重载')
  assert.notEqual(canonical(meta2.failover), canonical(d.meta.failover))
})

test('createHotApplier:连着几次改动攒成一轮;排着 / 跑着时 busy;runNow 立刻跑并等结果;stop 之后不再响应改动', async () => {
  const store = memStore()
  let runs = 0
  let release
  const apply = async () => {
    runs += 1
    await new Promise((resolve) => { release = resolve })
    return { ok: true, changed: 1 }
  }
  const exclusive = (_store, fn) => fn()
  const applier = createHotApplier({ store, ctx: null, paths, debounceMs: 20, exclusive, apply })
  applier.start()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(runs, 1, '起来先对一轮账')
  assert.equal(applier.busy(), true)
  release()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(applier.busy(), false)
  store.setNodes([node('A', 'x')])
  store.setGroups(store.getGroups())
  assert.equal(applier.busy(), true, '改动排着')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(runs, 2, '两次改动攒成一轮')
  release()
  const now = applier.runNow()
  await new Promise((r) => setTimeout(r, 5))
  release()
  assert.deepEqual(await now, { ok: true, changed: 1 })
  applier.stop()
  store.setNodes([])
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(runs, 3)
})

test('createRestartPending:没改动不提示;只改了节点——在线更新排着时不提示,没换进去才提示 nodes;入口放行端口改了提示 system', async () => {
  const store = seeded()
  const { ctx } = deploy(store)
  let busy = false
  const hotApplier = { busy: () => busy }
  const pending = createRestartPending({ store, ctx, paths, hotApplier })
  assert.deepEqual(await pending.get(), { pending: false, reasons: [] })
  store.setNodes([node('机场 | 香港-01', 'new'), node('机场 | 美国-01', 'same')])
  busy = true
  assert.deepEqual(await pending.get(), { pending: false, reasons: [] }, '在线更新排着,不算要重启')
  busy = false
  assert.deepEqual(await pending.get(), { pending: true, reasons: ['nodes'] }, '没换进去')
  store.setNodes([node('机场 | 香港-01', 'old'), node('机场 | 美国-01', 'same')])
  store.setProfile({ bypassPorts: '2233' })
  assert.deepEqual(await pending.get(), { pending: true, reasons: ['system'] })
  // 结果缓存到下一次改动 / 部署;部署写了新的元数据就重算
  const before = await pending.get()
  assert.equal(await pending.get(), before)
})

test('订阅和节点站点直连:节点换了服务器域名 → 只重新解析、改写规则集文件(内核自己重新加载);域名没变不解析;文件内容没变不写', async () => {
  const store = seeded()
  store.setProfile({ dns: { direct: '119.29.29.29' } })
  const { ctx, config } = deploy(store)
  assert.ok(config.route.rule_set.some((r) => r.tag === 'obnode-direct'), '部署的配置引用规则集')
  const lookups = []
  const asked = []
  const resolveHosts = async (domains, opts) => { lookups.push([...domains]); asked.push(opts.servers); return domains.includes('new.example.com') ? ['198.51.100.7/32'] : [] }
  const { calls, fetchImpl } = kernel()
  // 节点定义也变了(服务器换了):出站在线换 + 规则集文件改写
  store.setNodes([node('机场 | 香港-01', 'old', 'new.example.com'), node('机场 | 美国-01', 'same')])
  const r = await applyHotOutbounds({ store, ctx, paths, fetchImpl, resolveHosts })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(lookups, [['new.example.com', 'x.example.com']])
  assert.deepEqual(asked, [['119.29.29.29']], '问直连 DNS,不是部署时读到的系统上游 DNS')
  assert.equal(calls.length, 1)
  assert.deepEqual(r.nodeDirect, ['obnode-direct', 'obnode-direct-ip'])
  const domains = JSON.parse(ctx.files[`${paths.rulesetDir}/obnode-direct.json`])
  assert.deepEqual(domains, { version: 3, rules: [{ domain: ['new.example.com', 'x.example.com'] }] })
  assert.deepEqual(JSON.parse(ctx.files[`${paths.rulesetDir}/obnode-direct-ip.json`]), { version: 3, rules: [{ ip_cidr: ['198.51.100.7/32'] }] })
  const meta = JSON.parse(ctx.files[configMetaPath(paths)])
  assert.deepEqual(meta.buildInputs.directHostDomains, ['new.example.com', 'x.example.com'])
  assert.deepEqual(meta.buildInputs.directHostCidrs, ['198.51.100.7/32'])
  // 什么都没变:不解析、不写文件、不找内核
  ctx.writes.length = 0
  const again = await applyHotOutbounds({ store, ctx, paths, fetchImpl, resolveHosts })
  assert.deepEqual({ ok: again.ok, changed: again.changed }, { ok: true, changed: 0 })
  assert.equal(lookups.length, 1)
  assert.equal(ctx.writes.length, 0)
  assert.equal(calls.length, 1)
  // 订阅地址的主机名也在域名那份里:只改订阅地址(节点没变)也在线更新文件,不找内核
  store.setSubscriptions([{ id: 's1', name: '机场', enabled: true, url: 'https://sub.example.com/x' }])
  const sub = await applyHotOutbounds({ store, ctx, paths, fetchImpl, resolveHosts })
  assert.equal(sub.ok, true)
  assert.equal(sub.changed, 0)
  assert.deepEqual(sub.nodeDirect, ['obnode-direct'])
  assert.equal(calls.length, 1, '出站没变不找内核')
  assert.ok(JSON.parse(ctx.files[`${paths.rulesetDir}/obnode-direct.json`]).rules[0].domain.includes('sub.example.com'))
  // 待重启判断:这些都不算要重启
  assert.deepEqual(await createRestartPending({ store, ctx, paths }).get(), { pending: false, reasons: [] })
})
