import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { configMetaPath } from '../system/deploy.mjs'
import { applyHotFlip, regenerateIfPlanChanged } from './deploy-runner.mjs'
import { flipBypassPath, flipFlagPath, flipTargetState, writeFlipFiles } from '../system/flip-files.mjs'
import { FLIP_FALLBACK_TAG, FLIP_FLAG_OFF, FLIP_FLAG_ON, flipFlagTag } from '../engine/flip.mjs'
import { bypassPlanKey, nativeBypassPlan, routingFingerprint } from '../engine/routing-model.mjs'

const paths = createPaths('/opt/open-box')
const CN = flipFlagTag({ id: 'cn' })
const G = flipFlagTag({ id: 'g' })
// 「国内」排最前(和正式 / 开发路由器一样):它前面没有走代理的站点集,geoip-cn 才进得了入口旁路
const routing = { fallbackDefault: 'direct', policies: [
  { id: 'cn', name: '国内', default: 'direct', rulesets: ['geoip-cn', 'geosite-cn'] },
  { id: 'g', name: 'Google', default: '香港-自动', rulesets: ['geosite-google'] },
] }
const groups = [{ id: 'grp', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }]
const members = ['直连', '香港-自动', '拒绝']
const builtin = { direct: '直连', block: '拒绝', directEnabled: true, blockEnabled: true }
// FakeIP 开着(默认值):走代理的域名拿占位地址,Google 这种按域名走代理的站点集才不挡「国内」的入口旁路——
// 有域名的访问只按域名判,没有 FakeIP 时它的域名解析出来的真实地址可能落在 geoip-cn 里,入口旁路会整个关掉
const profileOf = (over = {}) => ({ routing, clientRoutes: [], dns: { split: true, mode: 'hijack', fakeIpForProxy: true }, tun: { autoRedirect: true }, ...over })
const storeOf = (profile) => ({ getProfile: () => profile, getGroups: () => groups, getNodes: () => [], getSubscriptions: () => [] })
const geoSrs = `${paths.geoDir}/geoip-cn.srs`
// 内核解码 geoip-cn:纯 IP 的集合,核对能过
const decompileOk = { code: 0, stdout: '', stderr: '' }

// 部署时的样子:Google 走代理(ON)、国内直连(OFF、旁路放满)
const deployed = async (profile, { bypassMode = 'dynamic' } = {}) => {
  const nativeBypass = { enabled: true, sets: ['geoip-cn'], pending: [], reason: '' }
  const state = flipTargetState({ routing, members, builtin, selections: {}, nativeBypass })
  const plan = nativeBypassPlan(routing, { members, builtin, selections: {}, clientRoutes: [], fakeIp: true, dnsMode: 'hijack' })
  const meta = {
    dnsMode: 'hijack', generatedAt: '2026-09-19T00:00:00.000Z', routingHash: routingFingerprint(routing), dnsPolicyMembers: members, dnsPolicyClasses: { Google: 'proxy', 国内: 'direct', 其他: 'direct' },
    firstLayer: { dnsMode: 'hijack', dnsForward: 'all', nativeBypass: { ...nativeBypass, via: 'nft' }, nativeBypassPlanned: { sets: plan.sets, pending: [] }, nativeBypassPlanKey: bypassPlanKey(plan), policyClasses: state.classes, ipv6: 'off' },
    flip: { mode: 'hot', flags: state.flags, names: state.names, bypass: state.bypass, bypassMode },
  }
  const ctx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(meta), [geoSrs]: 'GEOIP-CN-BYTES', [paths.singbox]: 'x' }, defaultExec: decompileOk })
  // 解码出来的集合内容:mock 的 exec 不写文件,native-bypass 会读临时 JSON——直接预置
  ctx.files[`${paths.dataDir}/tmp/geoip-cn.dns-forward.json`] = JSON.stringify({ version: 3, rules: [{ ip_cidr: ['1.0.1.0/24'] }] })
  // 占位 .srs 是内核编出来的,mock 的 exec 同样不落文件:预置
  ctx.files[`${paths.dataDir}/flip/placeholder.srs`] = 'PLACEHOLDER-BYTES'
  await writeFlipFiles(ctx, paths, state, { dynamicBypass: bypassMode === 'dynamic' })
  ctx.writes.length = 0
  ctx.calls.length = 0
  return { ctx, meta, state }
}

test('writeFlipFiles:部署时全套写好——开关按此刻的类别,旁路动态集「满」= 原集合的拷贝、「空」= 占位;纯 tun 不写旁路文件', async () => {
  const { ctx } = await deployed(profileOf())
  assert.equal(ctx.files[flipFlagPath(paths, G)], FLIP_FLAG_ON)
  assert.equal(ctx.files[flipFlagPath(paths, CN)], FLIP_FLAG_OFF)
  assert.equal(ctx.files[flipFlagPath(paths, FLIP_FALLBACK_TAG)], FLIP_FLAG_OFF)
  assert.equal(ctx.files[flipBypassPath(paths, 'geoip-cn')], 'GEOIP-CN-BYTES')
  const pure = await deployed(profileOf(), { bypassMode: 'static' })
  assert.equal(pure.ctx.files[flipBypassPath(paths, 'geoip-cn')], undefined)
  assert.equal(pure.ctx.files[flipFlagPath(paths, CN)], FLIP_FLAG_OFF)
})

// GitHub #224:核对说要扣掉几段的集合,不再用原文件的拷贝,而是把剩下的 CIDR 编成一份新 .srs
test('writeFlipFiles / applyFlipDiff:裁剪过的旁路集合按剩下的 CIDR 用内核编一份;翻面时同样是「满」但扣掉的段变了也重写;编不出来退回占位', async () => {
  const trimmed = { 'geoip-cn': { cidrs: ['1.0.1.0/24', '223.5.5.0/24'], removed: ['和前面「国外」重叠的 36.103.232.0…'], original: 3 } }
  const nativeBypass = { enabled: true, sets: ['geoip-cn'], trimmed, pending: [], reason: '' }
  const state = flipTargetState({ routing, members, builtin, selections: {}, nativeBypass })
  assert.equal(state.bypass['geoip-cn'], true)
  assert.match(state.bypassContent['geoip-cn'], /^sha:/)
  assert.deepEqual(state.bypassTrimmed['geoip-cn'], ['1.0.1.0/24', '223.5.5.0/24'])
  const ctx = createMockContext({ files: { [geoSrs]: 'GEOIP-CN-BYTES', [paths.singbox]: 'x', [`${paths.dataDir}/flip/placeholder.srs`]: 'PLACEHOLDER-BYTES' }, defaultExec: { code: 0, stdout: '', stderr: '' } })
  await writeFlipFiles(ctx, paths, state, { dynamicBypass: true })
  const compile = ctx.calls.find((c) => c.args?.[0] === 'rule-set' && c.args?.[1] === 'compile')
  assert.ok(compile, '裁剪过的集合要用内核 rule-set compile 编')
  // 先编到 .new 再原子换上(#382:内核边监视边重载,直接写正在用的文件会被读到半截)
  assert.equal(compile.args[3], `${flipBypassPath(paths, 'geoip-cn')}.new`)
  assert.ok(ctx.writes.some((w) => w.path === flipBypassPath(paths, 'geoip-cn') && w.copiedFrom === `${flipBypassPath(paths, 'geoip-cn')}.new`))
  const json = ctx.writes.find((w) => w.path === `${flipBypassPath(paths, 'geoip-cn')}.json`)
  assert.deepEqual(JSON.parse(json.content), { version: 3, rules: [{ ip_cidr: ['1.0.1.0/24', '223.5.5.0/24'] }] })
  assert.equal(ctx.files[`${flipBypassPath(paths, 'geoip-cn')}.json`], undefined, '临时 JSON 用完删掉')
  assert.notEqual(ctx.files[flipBypassPath(paths, 'geoip-cn')], 'GEOIP-CN-BYTES', '不是原文件的拷贝')

  // 翻面:扣掉的段变了(sha 不同)→ 重写;没变 → 不写
  const { applyFlipDiff } = await import('../system/flip-files.mjs')
  const prev = { flags: state.flags, bypass: state.bypass, bypassContent: state.bypassContent, need: state.need }
  ctx.calls.length = 0
  const same = await applyFlipDiff(ctx, paths, prev, state, { dynamicBypass: true })
  assert.deepEqual(same, { flags: [], bypass: [], need: [] })
  const next = flipTargetState({ routing, members, builtin, selections: {}, nativeBypass: { ...nativeBypass, trimmed: { 'geoip-cn': { cidrs: ['1.0.1.0/24'], removed: ['x'], original: 3 } } } })
  const changed = await applyFlipDiff(ctx, paths, prev, next, { dynamicBypass: true })
  assert.deepEqual(changed.bypass, ['geoip-cn'])
  assert.ok(ctx.calls.some((c) => c.args?.[1] === 'compile'))
  // 满(原拷贝)→ 裁剪过的 也算变
  const full = flipTargetState({ routing, members, builtin, selections: {}, nativeBypass: { ...nativeBypass, trimmed: {} } })
  assert.deepEqual((await applyFlipDiff(ctx, paths, { ...prev, bypassContent: {} }, full, { dynamicBypass: true })).bypass, [])
  assert.deepEqual((await applyFlipDiff(ctx, paths, full, state, { dynamicBypass: true })).bypass, ['geoip-cn'])

  // 纯 tun(静态写法):裁剪过、此刻旁路的集合同样编一份(配置里引用它,GitHub #225);need 侧一份都不写
  const pure = createMockContext({ files: { [geoSrs]: 'GEOIP-CN-BYTES', [paths.singbox]: 'x', [`${paths.dataDir}/flip/placeholder.srs`]: 'PLACEHOLDER-BYTES' }, defaultExec: { code: 0, stdout: '', stderr: '' } })
  await writeFlipFiles(pure, paths, state, { dynamicBypass: false })
  assert.equal(pure.calls.find((c) => c.args?.[1] === 'compile')?.args[3], `${flipBypassPath(paths, 'geoip-cn')}.new`)
  assert.ok(!pure.writes.some((w) => /obflip-need-/.test(w.path)), '纯 tun 没有白名单那一侧')
  const pureOff = flipTargetState({ routing, members, builtin, selections: {}, nativeBypass: { enabled: true, sets: [], trimmed, pending: [], reason: '' } })
  const pure2 = createMockContext({ files: { [geoSrs]: 'GEOIP-CN-BYTES', [paths.singbox]: 'x' }, defaultExec: { code: 0, stdout: '', stderr: '' } })
  await writeFlipFiles(pure2, paths, pureOff, { dynamicBypass: false })
  assert.equal(pure2.files[flipBypassPath(paths, 'geoip-cn')], undefined, '此刻不旁路的不写(配置也不引用)')

  // 编不出来:退回占位,错误抛出去
  const bad = createMockContext({ files: { [geoSrs]: 'GEOIP-CN-BYTES', [paths.singbox]: 'x', [`${paths.dataDir}/flip/placeholder.srs`]: 'PLACEHOLDER-BYTES' }, defaultExec: { code: 1, stdout: '', stderr: 'boom' } })
  await assert.rejects(() => writeFlipFiles(bad, paths, state, { dynamicBypass: true }), /编不出来/)
  // writeFlipFiles 自己会重写占位文件(真字节),退回的就是那一份
  assert.deepEqual(bad.files[flipBypassPath(paths, 'geoip-cn')], bad.files[`${paths.dataDir}/flip/placeholder.srs`])
})

test('applyHotFlip:国内 直连 → 代理——先把旁路收成占位、再开开关;元数据跟到此刻,generatedAt 不动;不调内核重启', async () => {
  const profile = profileOf()
  const { ctx } = await deployed(profile)
  const logs = []
  const r = await applyHotFlip({ store: storeOf(profile), ctx, paths, selections: { 国内: '香港-自动' }, log: (m) => logs.push(m) })
  assert.equal(r.ok, true, r.reason)
  // 运行中的是没有 need 侧的老配置(元数据 flip 段没有 need):need 一份都不动
  assert.deepEqual(r.changed, { flags: [CN], bypass: ['geoip-cn'], need: [] })
  const order = ctx.writes.map((w) => w.path).filter((p) => p.includes('/flip/obflip-'))
  assert.deepEqual(order, [flipBypassPath(paths, 'geoip-cn'), flipFlagPath(paths, CN)], '直连 → 代理:旁路先收、开关后开')
  assert.equal(ctx.files[flipFlagPath(paths, CN)], FLIP_FLAG_ON)
  assert.notEqual(ctx.files[flipBypassPath(paths, 'geoip-cn')], 'GEOIP-CN-BYTES', '旁路换成了占位')
  assert.equal(ctx.files[flipFlagPath(paths, G)], FLIP_FLAG_ON, '没变的开关不碰')
  const meta = JSON.parse(ctx.files[configMetaPath(paths)])
  assert.equal(meta.flip.flags[CN], true)
  assert.equal(meta.flip.bypass['geoip-cn'], false)
  assert.equal(meta.firstLayer.policyClasses.国内, 'proxy')
  assert.equal(meta.dnsPolicyClasses.国内, 'proxy')
  assert.equal(meta.firstLayer.nativeBypass.enabled, false)
  assert.equal(meta.generatedAt, '2026-09-19T00:00:00.000Z', '故障转移管理器拿它当配置版本,热切换不能改')
  assert.ok(!ctx.calls.some((c) => /init\.d|restart/.test([c.cmd, ...c.args].join(' '))), '没有任何重启')
  assert.ok(logs.some((m) => /热切换.*「国内」→代理.*内核没有重启/.test(m)))

  // 再翻回来:代理 → 直连——先关开关、再放满旁路
  ctx.writes.length = 0
  const back = await applyHotFlip({ store: storeOf(profile), ctx, paths, selections: { 国内: '直连' }, log: () => {} })
  assert.equal(back.ok, true, back.reason)
  assert.deepEqual(ctx.writes.map((w) => w.path).filter((p) => p.includes('/flip/obflip-')), [flipFlagPath(paths, CN), flipBypassPath(paths, 'geoip-cn')])
  assert.equal(ctx.files[flipBypassPath(paths, 'geoip-cn')], 'GEOIP-CN-BYTES')
  assert.equal(JSON.parse(ctx.files[configMetaPath(paths)]).firstLayer.nativeBypass.enabled, true)
})

test('applyHotFlip:在代理线路之间换(类别没变)什么都不写;档案里新加了站点集还没部署时不热切换', async () => {
  const profile = profileOf()
  const { ctx } = await deployed(profile)
  const same = await applyHotFlip({ store: storeOf(profile), ctx, paths, selections: { Google: '香港-自动' }, log: () => {} })
  assert.deepEqual(same.changed, { flags: [], bypass: [] })
  assert.equal(ctx.writes.length, 0)
  assert.equal(ctx.calls.length, 0, '连内核解码都没起')
  // 档案里多了一个站点集(还没重启内核):运行中的规则是按老设置生成的,不热切换、一个文件都不写
  // (经面板切换的会回到老路径重新部署,新站点集随之生效)
  const edited = profileOf({ routing: { ...routing, policies: [...routing.policies, { id: 'new', name: '新加的', default: '香港-自动', domainSuffix: ['x.test'] }] } })
  const r = await applyHotFlip({ store: storeOf(edited), ctx, paths, selections: { 国内: '香港-自动' }, log: () => {} })
  assert.equal(r.ok, false)
  assert.match(r.reason, /分流设置改过,还没重启内核/)
  assert.equal(ctx.writes.length, 0)
})

test('applyHotFlip 的回退条件:运行中的是老版本生成的老结构 / 读不到元数据 / 纯 tun 下旁路变了 → 交还给调用方去重启', async () => {
  const profile = profileOf()
  const { ctx, meta } = await deployed(profile)
  // 运行中的配置是老结构(元数据没有 flip 段):从带开关的老版本升上来、还没重新部署过
  const old = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify({ ...meta, flip: undefined }) } })
  assert.match((await applyHotFlip({ store: storeOf(profile), ctx: old, paths, selections: { 国内: '香港-自动' } })).reason, /不是热切换结构/)
  // 档案里还留着老开关键(store 清理之前的瞬间、或测试用的裸 store):不看它,照样热切换
  assert.equal((await applyHotFlip({ store: storeOf(profileOf({ restartOnFlip: true })), ctx, paths, selections: {} })).ok, true)
  assert.match((await applyHotFlip({ store: storeOf(profile), ctx: createMockContext({}), paths, selections: {} })).reason, /读不到部署元数据/)
  // 纯 tun:旁路是老的静态写法,国内翻到代理 → 旁路指纹变了,换不了
  const pure = await deployed(profile, { bypassMode: 'static' })
  const r = await applyHotFlip({ store: storeOf(profile), ctx: pure.ctx, paths, selections: { 国内: '香港-自动' } })
  assert.equal(r.ok, false)
  assert.match(r.reason, /纯 tun/)
  assert.equal(pure.ctx.files[flipFlagPath(paths, CN)], FLIP_FLAG_OFF, '回退时一个文件都没动')
  // 纯 tun 但旁路不受影响(Google 翻到直连,它没有 geoip):照样热切换
  const ok = await applyHotFlip({ store: storeOf(profile), ctx: pure.ctx, paths, selections: { Google: '直连' } })
  assert.equal(ok.ok, true, ok.reason)
  assert.equal(pure.ctx.files[flipFlagPath(paths, G)], FLIP_FLAG_OFF)
})

test('regenerateIfPlanChanged:翻面先走热切换、不部署;走不通才回到重新部署 + 重启的路径', async () => {
  const profile = profileOf()
  const { ctx, meta } = await deployed(profile)
  const deployedCalls = []
  const deploy = async (args) => { deployedCalls.push(args); return { ok: true, stage: 'running', message: '' } }
  const exclusive = async (_store, fn) => fn()
  const hot = await regenerateIfPlanChanged({ store: storeOf(profile), ctx, paths, selections: { 国内: '香港-自动' }, deploy, exclusive })
  assert.equal(hot.hot, true)
  assert.equal(hot.regenerated, false)
  assert.equal(deployedCalls.length, 0, '热切换成功:不部署、不重启')
  // 运行中的还是老结构:回到老判断,类别翻了 → 部署(部署出来的就是热切换结构)
  const oldCtx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify({ ...meta, flip: undefined }) } })
  const logs = []
  const fell = await regenerateIfPlanChanged({ store: storeOf(profile), ctx: oldCtx, paths, selections: { 国内: '香港-自动' }, deploy, exclusive, log: (m) => logs.push(m) })
  assert.equal(fell.regenerated, true)
  assert.equal(deployedCalls.length, 1)
  assert.ok(logs.some((m) => /热切换走不通.*改走重启/.test(m)))
})

test('每分钟对账:只在内核在跑时比一次,只改写开关、绝不触发部署', async () => {
  const { runScheduledTasks } = await import('../system/scheduler.mjs')
  const profile = profileOf({ updates: {} })
  const { ctx } = await deployed(profile)
  ctx.files[paths.scheduleStatePath] = '{}'
  const store = { ...storeOf(profile), getClashSecret: () => 's', setSelectionsSnapshot: () => {}, getSelectionsSnapshot: () => ({}), setProfile: () => {} }
  // 内核里「国内」已经被别的客户端切到了代理
  const fetchImpl = async () => new Response(JSON.stringify({ proxies: { 国内: { now: '香港-自动' }, Google: { now: '香港-自动' }, 其他: { now: '直连' } } }), { headers: { 'content-type': 'application/json' } })
  let deployCalls = 0
  await runScheduledTasks({ store, ctx, paths, fetchImpl, runDeploy: async () => { deployCalls += 1; return { ok: true } }, exclusive: async (_s, fn) => fn() })
  assert.equal(ctx.files[flipFlagPath(paths, CN)], FLIP_FLAG_ON, '开关跟上了')
  assert.equal(deployCalls, 0)
  // 内核没在跑(读不到选择):不比、不写
  const idle = await deployed(profile)
  idle.ctx.files[paths.scheduleStatePath] = '{}'
  await runScheduledTasks({ store, ctx: idle.ctx, paths, fetchImpl: async () => { throw new Error('ECONNREFUSED') }, runDeploy: async () => ({ ok: true }), exclusive: async (_s, fn) => fn() })
  assert.equal(idle.ctx.writes.filter((w) => w.path.includes('/flip/')).length, 0)
})

test('部署后立刻对账:开关按重启前的选择写,内核起来后恢复出来的选择不一样时,马上按真实选择改写(不再触发部署)', async () => {
  const { runDeploy } = await import('./deploy-runner.mjs')
  const { createStore } = await import('../store/openbox-store.mjs')
  const m = new Map()
  const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
  store.setGroups(groups)
  // DNS 禁用模式下 FakeIP 不作数:按域名走代理的站点集会让入口旁路整个关掉,翻它就牵动旁路。这里的 Google 只写 IP 段
  const ipGoogle = { ...routing, policies: [routing.policies[0], { id: 'g', name: 'Google', default: '香港-自动', ipCidr: ['203.0.113.0/24'] }] }
  store.setProfile({ ...profileOf(), routing: ipGoogle, dns: { split: true, mode: 'off' }, tun: { autoRedirect: false } })
  // 规则集文件都当作随包带着
  const geo = Object.fromEntries(['geoip-cn', 'geosite-cn', 'geosite-google'].map((t) => [`${paths.geoDir}/${t}.srs`, 'SRS']))
  const ctx = createMockContext({ files: { [paths.singbox]: 'x', '/dev/net/tun': '', '/etc/resolv.conf': 'nameserver 223.5.5.5\n', ...geo }, execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } } })
  // 第一次读选择(部署开始时,内核还是旧的):Google = 直连;之后(新内核起来):Google = 香港-自动。
  // 这里是纯 tun(旁路是静态写法),拿不牵动入口旁路的 Google 来翻;牵动旁路的那种在纯 tun 下按设计回到重启
  let reads = 0
  const fetchImpl = async (url) => {
    if (!String(url).endsWith('/proxies')) return new Response('{}', { status: 404 })
    reads += 1
    const now = reads === 1 ? '直连' : '香港-自动'
    return new Response(JSON.stringify({ proxies: { 国内: { now: '直连' }, Google: { now }, 其他: { now: '直连' } } }), { headers: { 'content-type': 'application/json' } })
  }
  const r = await runDeploy({ store, ctx, paths, fetchImpl, lateWatch: false })
  assert.equal(r.ok, true, `${r.stage}: ${r.message}`)
  assert.ok(reads >= 2, '内核起来之后又读了一次选择')
  assert.equal(ctx.files[flipFlagPath(paths, G)], FLIP_FLAG_ON, '开关按新内核真实的选择改过来了')
  assert.equal(ctx.files[flipFlagPath(paths, CN)], FLIP_FLAG_OFF)
})

test('分流设置改过(界面里改了站点集 / 刚导入备份)还没重启内核:不热切换,交还给调用方;只是默认出口跟着选择变了不算改过', async () => {
  const profile = profileOf()
  const { ctx } = await deployed(profile)
  // 选择即默认:代理页切一下,档案里的默认出口就变——指纹不变,照常热切换
  const persisted = profileOf({ routing: { ...routing, fallbackDefault: '香港-自动', policies: routing.policies.map((p) => (p.id === 'g' ? { ...p, default: '直连' } : p)) } })
  assert.equal(routingFingerprint(persisted.routing), routingFingerprint(routing))
  const ok = await applyHotFlip({ store: storeOf(persisted), ctx, paths, selections: { 国内: '香港-自动' } })
  assert.equal(ok.ok, true, ok.reason)
  // 导入了一份站点集 id 相同、名字和规则不同的备份:内核里查不到新名字的选择,照档案默认值去改开关就错了
  const imported = profileOf({ routing: { fallbackDefault: 'direct', policies: [{ id: 'cn', name: '大陆', default: '香港-自动', rulesets: ['geoip-cn'] }] } })
  assert.notEqual(routingFingerprint(imported.routing), routingFingerprint(routing))
  const before = ctx.files[flipFlagPath(paths, CN)]
  ctx.writes.length = 0
  const refused = await applyHotFlip({ store: storeOf(imported), ctx, paths, selections: { 国内: '香港-自动' } })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /分流设置改过,还没重启内核/)
  assert.equal(ctx.files[flipFlagPath(paths, CN)], before)
  assert.equal(ctx.writes.length, 0, '一个文件都没动')
})

// ---------- 入口白名单(entryModePlan + need 侧动态集) ----------
const { FLIP_NEED_ALL, FLIP_NEED_FAKEIP, FLIP_NEED_CIDR, flipNeedTag } = await import('../engine/flip.mjs')
const { flipNeedPath } = await import('../system/flip-files.mjs')
// 兜底直连 + FakeIP 开 + 国内在后 —— 报告人 #224 那种配置;Google 走代理引用 geoip-google
const wlRouting = { fallbackDefault: 'direct', policies: [
  { id: 'g', name: 'Google', default: '香港-自动', rulesets: ['geosite-google', 'geoip-google'] },
  { id: 'cn', name: '国内', default: 'direct', rulesets: ['geoip-cn', 'geosite-cn'] },
] }
const wlProfile = () => ({ routing: wlRouting, clientRoutes: [], dns: { split: true, mode: 'hijack', fakeIpForProxy: true }, tun: { autoRedirect: true } })
const { currentEntryMode } = await import('./deploy-runner.mjs')

test('入口白名单:兜底直连 + FakeIP 开 → whitelist;进内核名单 = FakeIP 池 + 走代理的 geoip;all 只剩 ::/0;兜底切代理 → blacklist,all 变成全部', () => {
  const store = storeOf(wlProfile())
  const wl = currentEntryMode(store, {})
  assert.equal(wl.mode, 'whitelist')
  assert.deepEqual(wl.needSets, ['geoip-google'])
  const state = flipTargetState({ routing: wlRouting, members, builtin, selections: {}, nativeBypass: { enabled: true, sets: ['geoip-cn'], pending: [], reason: '' }, entryMode: wl })
  assert.equal(state.entryMode, 'whitelist')
  assert.equal(state.need[flipNeedTag('geoip-google')], 'full')
  assert.equal(state.need[flipNeedTag('geoip-cn')], 'placeholder')
  assert.match(state.need[FLIP_NEED_FAKEIP], /^cidr:/)
  assert.deepEqual(state.needCidrs[FLIP_NEED_FAKEIP], ['198.19.0.0/16', 'fc00::/18'])
  assert.deepEqual(state.needCidrs[FLIP_NEED_ALL], ['::/0'], '白名单:v6 照旧全进内核,v4 默认放行')
  assert.equal(state.need[FLIP_NEED_CIDR], 'placeholder')
  // 兜底切到代理 → 黑名单:all 变成全部,其余不变
  const bl = currentEntryMode(store, { 其他: '香港-自动', '香港-自动': 'HK-01' })
  assert.equal(bl.mode, 'blacklist')
  assert.match(bl.reason, /兜底「其他」走代理/)
  const blState = flipTargetState({ routing: wlRouting, members, builtin, selections: { 其他: '香港-自动', '香港-自动': 'HK-01' }, nativeBypass: { enabled: true, sets: ['geoip-cn'], pending: [], reason: '' }, entryMode: bl })
  assert.deepEqual(blState.needCidrs[FLIP_NEED_ALL], ['0.0.0.0/0', '::/0'])
  assert.equal(blState.need[flipNeedTag('geoip-google')], 'full', '黑名单时 need 侧仍跟着类别走,切回白名单只换 all 那一份')
  // 没 FakeIP → 黑名单
  assert.equal(currentEntryMode(storeOf({ ...wlProfile(), dns: { split: true, mode: 'hijack', fakeIpForProxy: false } }), {}).mode, 'blacklist')
  // 纯 tun → 黑名单
  assert.match(currentEntryMode(storeOf({ ...wlProfile(), tun: { autoRedirect: false } }), {}).reason, /纯 tun/)
})

test('入口白名单:部署时 need 侧全套写好(固定三份编、候选按类别拷贝 / 占位);翻面按内容比,只换变了的,先写进内核名单再撤旁路', async () => {
  const store = storeOf(wlProfile())
  const entryMode = currentEntryMode(store, {})
  const nativeBypass = { enabled: true, sets: ['geoip-cn'], pending: [], reason: '' }
  const state = flipTargetState({ routing: wlRouting, members, builtin, selections: {}, nativeBypass, entryMode })
  const ctx = createMockContext({ files: { [geoSrs]: 'GEOIP-CN-BYTES', [`${paths.geoDir}/geoip-google.srs`]: 'GEOIP-GOOGLE-BYTES', [paths.singbox]: 'x', [`${paths.dataDir}/flip/placeholder.srs`]: 'PLACEHOLDER-BYTES' }, defaultExec: { code: 0, stdout: '', stderr: '' } })
  await writeFlipFiles(ctx, paths, state, { dynamicBypass: true })
  const compiled = ctx.calls.filter((c) => c.args?.[1] === 'compile').map((c) => c.args[3].replace(/\.new$/, ''))
  assert.ok(compiled.includes(flipNeedPath(paths, FLIP_NEED_ALL)) && compiled.includes(flipNeedPath(paths, FLIP_NEED_FAKEIP)), 'all / fakeip 两份是编出来的')
  assert.equal(ctx.files[flipNeedPath(paths, flipNeedTag('geoip-google'))], 'GEOIP-GOOGLE-BYTES', '走代理的 geoip → 原集合拷贝')
  assert.deepEqual(ctx.files[flipNeedPath(paths, flipNeedTag('geoip-cn'))], ctx.files[`${paths.dataDir}/flip/placeholder.srs`], '直连的 geoip → 占位')
  assert.equal(ctx.files[flipBypassPath(paths, 'geoip-cn')], 'GEOIP-CN-BYTES')
  // 纯 tun 不写 need 侧
  const pure = createMockContext({ files: { [geoSrs]: 'x', [paths.singbox]: 'x' } })
  await writeFlipFiles(pure, paths, state, { dynamicBypass: false })
  assert.ok(!Object.keys(pure.files).some((p) => p.includes('obflip-need-')))

  // 翻面:国内 直连 → 代理。need-geoip-cn 变满、bypass-geoip-cn 变空;顺序:先进内核名单,再撤旁路,再开开关
  const { applyFlipDiff } = await import('../system/flip-files.mjs')
  const sel = { 国内: '香港-自动', '香港-自动': 'HK-01' }
  const next = flipTargetState({ routing: wlRouting, members, builtin, selections: sel, nativeBypass: { enabled: false, sets: [], pending: [], reason: '' }, entryMode: currentEntryMode(store, sel) })
  ctx.writes.length = 0
  const changed = await applyFlipDiff(ctx, paths, state, next, { dynamicBypass: true })
  assert.deepEqual(changed.need, [flipNeedTag('geoip-cn')])
  assert.deepEqual(changed.bypass, ['geoip-cn'])
  const order = ctx.writes.map((w) => w.path).filter((p) => /obflip-(need-geoip-cn|byp-geoip-cn)\.srs$|obflip-[0-9a-f]{12}\.json$/.test(p))
  assert.deepEqual(order, [flipNeedPath(paths, flipNeedTag('geoip-cn')), flipBypassPath(paths, 'geoip-cn'), flipFlagPath(paths, CN)])
  // 兜底切代理:只换 all 那一份(编成全部),模式变黑名单
  const sel2 = { 其他: '香港-自动', '香港-自动': 'HK-01' }
  const black = flipTargetState({ routing: wlRouting, members, builtin, selections: sel2, nativeBypass, entryMode: currentEntryMode(store, sel2) })
  ctx.calls.length = 0
  const sw = await applyFlipDiff(ctx, paths, state, black, { dynamicBypass: true })
  assert.deepEqual(sw.need, [FLIP_NEED_ALL])
  assert.deepEqual(sw.bypass, [])
  const allJson = ctx.writes.find((w) => w.path === `${flipNeedPath(paths, FLIP_NEED_ALL)}.json`)
  assert.deepEqual(JSON.parse(allJson.content).rules[0].ip_cidr, ['0.0.0.0/0', '::/0'])
})

// 设置保存了还没重启内核(审查第四项):运行中的 DNS / 路由还是按老设置生成的。翻面要按部署时记下的设置算入口,
// 不能把一半新设置提前写进入口文件——比如刚打开 FakeIP 还没重启,入口却切成白名单,代理站点集的真实 IP 在入口被放走
test('设置保存了还没重启(刚打开 FakeIP):翻面按部署时的设置算入口,不会提前切成白名单', async () => {
  const { hotFlipInputs } = await import('../system/deploy.mjs')
  const deployedProfile = { ...wlProfile(), dns: { split: true, mode: 'hijack', fakeIpForProxy: false } }
  const entryMode = currentEntryMode(storeOf(deployedProfile), {})
  assert.equal(entryMode.mode, 'blacklist', '部署时 FakeIP 关着:黑名单入口')
  const nativeBypass = { enabled: true, sets: ['geoip-cn'], pending: [], reason: '' }
  const state = flipTargetState({ routing: wlRouting, members, builtin, selections: {}, nativeBypass, entryMode })
  const plan = nativeBypassPlan(wlRouting, { members, builtin, selections: {}, clientRoutes: [], fakeIp: false, dnsMode: 'hijack' })
  const meta = {
    dnsMode: 'hijack', generatedAt: '2026-09-30T00:00:00.000Z', routingHash: routingFingerprint(wlRouting), dnsPolicyMembers: members, dnsPolicyClasses: { Google: 'proxy', 国内: 'direct', 其他: 'direct' },
    firstLayer: { dnsMode: 'hijack', dnsForward: 'all', nativeBypass: { ...nativeBypass, via: 'nft' }, nativeBypassPlanned: { sets: plan.sets, pending: [] }, nativeBypassPlanKey: bypassPlanKey(plan), policyClasses: state.classes, ipv6: 'off', inputs: hotFlipInputs(deployedProfile) },
    flip: { mode: 'hot', flags: state.flags, names: state.names, bypass: state.bypass, bypassContent: state.bypassContent, bypassMode: 'dynamic', need: state.need, entryMode: state.entryMode },
  }
  const ctx = createMockContext({ files: { [configMetaPath(paths)]: JSON.stringify(meta), [geoSrs]: 'GEOIP-CN-BYTES', [`${paths.geoDir}/geoip-google.srs`]: 'GEOIP-GOOGLE-BYTES', [paths.singbox]: 'x', [`${paths.dataDir}/flip/placeholder.srs`]: 'PLACEHOLDER-BYTES' }, defaultExec: decompileOk })
  ctx.files[`${paths.dataDir}/tmp/geoip-cn.dns-forward.json`] = JSON.stringify({ version: 3, rules: [{ ip_cidr: ['1.0.1.0/24'] }] })
  await writeFlipFiles(ctx, paths, state, { dynamicBypass: true })
  ctx.writes.length = 0
  // 用户在设置里打开了 FakeIP(保存了,没重启),然后在代理页把国内切到代理
  const r = await applyHotFlip({ store: storeOf(wlProfile()), ctx, paths, selections: { 国内: '香港-自动', '香港-自动': 'HK-01' }, log: () => {} })
  assert.equal(r.ok, true, r.reason)
  assert.ok(r.changed.flags.length > 0, '开关照常翻')
  const after = JSON.parse(ctx.files[configMetaPath(paths)])
  assert.equal(after.flip.entryMode, 'blacklist', '入口仍按部署时(FakeIP 关)算')
  assert.ok(!ctx.writes.some((w) => w.path.startsWith(flipNeedPath(paths, FLIP_NEED_ALL))), 'need-all 不改写成白名单的 ::/0')
  // 同样的翻面,部署时就开着 FakeIP(元数据里记的是开)→ 白名单照常
  assert.equal(currentEntryMode(storeOf(wlProfile()), {}).mode, 'whitelist')
})
