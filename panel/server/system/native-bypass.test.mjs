import { rulesetPath } from './rulesets.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { cidrListsOverlap, rangesToCidrs, cidrsToRanges, reachesEndOfSpace, resolveNativeBypass, subtractRanges } from './native-bypass.mjs'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'

const paths = createPaths('/opt/open-box')
const withDecoded = (tags) => {
  const all = { [paths.singbox]: 'x' }
  for (const [tag, json] of Object.entries(tags)) {
    all[rulesetPath(paths, tag)] = 'srs'
    all[`${paths.dataDir}/tmp/${tag}.dns-forward.json`] = JSON.stringify(json)
  }
  return createMockContext({ files: all })
}
const cidrs = (...list) => ({ rules: [{ ip_cidr: list }] })

test('cidrListsOverlap / reachesEndOfSpace:两组网段有交集就报出来,v4 / v6 分开比;到地址空间末尾的区间按范围认', () => {
  assert.equal(cidrListsOverlap(['1.0.0.0/8', '10.0.0.0/8'], ['2.0.0.0/8', '172.16.0.0/12']), '')
  assert.match(cidrListsOverlap(['1.0.0.0/8', '10.0.0.0/8'], ['10.9.0.0/16']), /^10\.0\.0\.0… × 10\.9\.0\.0…$/)
  assert.match(cidrListsOverlap(['2001:db8::/32'], ['2001:db8:1::/48']), /×/)
  assert.equal(cidrListsOverlap(['2001:db8::/32'], ['1.0.0.0/8']), '')
  assert.equal(cidrListsOverlap(['bad'], ['1.0.0.0/8']), '')
  assert.equal(reachesEndOfSpace(['240.0.0.0/4']), '240.0.0.0/4')
  assert.equal(reachesEndOfSpace(['255.255.255.255/32']), '255.255.255.255/32')
  assert.equal(reachesEndOfSpace(['ff00::/8']), 'ff00::/8')
  assert.equal(reachesEndOfSpace(['224.0.0.0/4', 'fe80::/10', '10.0.0.0/8']), '')
})

test('区间运算:相减 / 区间转 CIDR', () => {
  const cut = subtractRanges(cidrsToRanges(['36.96.0.0/12', '1.0.0.0/8']), cidrsToRanges(['36.103.232.0/22']))
  assert.deepEqual(rangesToCidrs(cut.removed), ['36.103.232.0/22'])
  assert.deepEqual(rangesToCidrs(cut.kept), ['1.0.0.0/8', '36.96.0.0/14', '36.100.0.0/15', '36.102.0.0/16', '36.103.0.0/17', '36.103.128.0/18', '36.103.192.0/19', '36.103.224.0/21', '36.103.236.0/22', '36.103.240.0/20', '36.104.0.0/13'])
  assert.deepEqual(rangesToCidrs(subtractRanges(cidrsToRanges(['2001:db8::/32']), cidrsToRanges(['2001:db8::/33'])).kept), ['2001:db8:8000::/33'])
  // 相邻 / 重叠的候选先合并
  assert.deepEqual(rangesToCidrs(subtractRanges(cidrsToRanges(['10.0.0.0/25', '10.0.0.128/25']), []).kept), ['10.0.0.0/24'])
})

test('resolveNativeBypass:每份候选集合先做内容校验——到地址空间末尾的区间收回一个地址再旁路(不按名字)、逻辑 / 取反、解不开 → 不旁路并说明', async () => {
  const plan = { enabled: true, sets: ['geoip-cn', 'geoip-private'], pending: [], fakeIp: false, reason: '' }
  const r = await resolveNativeBypass(withDecoded({
    'geoip-cn': cidrs('1.0.1.0/24', '223.5.5.0/24'),
    'geoip-private': cidrs('10.0.0.0/8', '240.0.0.0/4'),
  }), paths, plan)
  assert.deepEqual(r.sets, ['geoip-cn', 'geoip-private'])
  assert.equal(r.enabled, true)
  // 240.0.0.0/4 到地址空间末尾:终点收回一个地址,剩下的编成裁剪过的集合(sing-tun 编不进含末尾的区间)
  assert.match(r.reason, /集合「geoip-private」扣掉 到地址空间末尾的区间（240\.0\.0\.0\/4）的最后一个地址 后入口旁路/)
  assert.deepEqual(r.checked.map((c) => [c.sets[0], c.ok, c.trimmed]), [['geoip-cn', true, false], ['geoip-private', true, true]])
  assert.deepEqual(r.trimmed['geoip-private'].cidrs.slice(0, 3), ['10.0.0.0/8', '240.0.0.0/5', '248.0.0.0/6'])
  assert.ok(!r.trimmed['geoip-private'].cidrs.some((c) => c === '240.0.0.0/4' || c.endsWith('255.255.255.255/32')))
  assert.equal(r.trimmed['geoip-cn'], undefined, '没扣过的集合原样用')
  // 同样的内容换个名字,结论一样:按范围判,不按名字
  const renamed = await resolveNativeBypass(withDecoded({ 'geoip-whatever': cidrs('10.0.0.0/8', '240.0.0.0/4') }), paths, { ...plan, sets: ['geoip-whatever'] })
  assert.equal(renamed.enabled, true)
  assert.ok(renamed.trimmed['geoip-whatever'])
  const logical = await resolveNativeBypass(withDecoded({ 'geoip-x': { rules: [{ type: 'logical', mode: 'and', rules: [] }] } }), paths, { ...plan, sets: ['geoip-x'] })
  assert.equal(logical.enabled, false)
  assert.match(logical.reason, /逻辑/)
  const missing = await resolveNativeBypass(createMockContext({ files: { [paths.singbox]: 'x' } }), paths, plan)
  assert.equal(missing.enabled, false)
  assert.match(missing.reason, /集合「geoip-cn」/)
  // 没有候选原样返回
  assert.deepEqual(await resolveNativeBypass(createMockContext({}), paths, { enabled: false, sets: [], pending: [], reason: 'x' }), { enabled: false, sets: [], trimmed: {}, pending: [], fakeIp: false, checked: [], reason: 'x' })
})

test('resolveNativeBypass:pending 的候选集合和前面带 IP 条件的规则解码后没有交集 → 原样进旁路;有交集 → 扣掉重叠段再旁路并说明;全扣光 → 不开;规则集链接 → 说不清就不开', async () => {
  const plan = {
    enabled: false, sets: [], fakeIp: false, reason: '',
    pending: [{ policy: '用户直连集合', sets: ['geoip-user'], against: [{ name: '随便叫什么', geoip: ['geoip-anything'], cidrs: ['1.2.3.0/24'] }] }],
  }
  const ok = await resolveNativeBypass(withDecoded({
    'geoip-user': cidrs('1.0.1.0/24', '223.5.5.0/24'),
    'geoip-anything': cidrs('91.108.4.0/22', '149.154.160.0/20'),
  }), paths, plan)
  assert.deepEqual(ok, { enabled: true, sets: ['geoip-user'], trimmed: {}, pending: [], fakeIp: false, checked: [{ policy: '用户直连集合', sets: ['geoip-user'], ok: true, trimmed: false, reason: '' }], reason: '' })

  // 1.2.0.0/16 和前面的 1.2.3.0/24 重叠:扣掉那一段,剩下的照旁路(前面那条要的地址照旧进内核)
  const hit = await resolveNativeBypass(withDecoded({
    'geoip-user': cidrs('1.0.1.0/24', '1.2.0.0/16'),
    'geoip-anything': cidrs('91.108.4.0/22'),
  }), paths, plan)
  assert.equal(hit.enabled, true)
  assert.match(hit.reason, /站点集「用户直连集合」集合「geoip-user」扣掉 和前面「随便叫什么」重叠的 1\.2\.3\.0… 后入口旁路/)
  const kept = hit.trimmed['geoip-user'].cidrs
  assert.ok(kept.includes('1.0.1.0/24') && kept.includes('1.2.0.0/23') && kept.includes('1.2.4.0/22') && !kept.some((c) => c.startsWith('1.2.3.')))
  assert.deepEqual(hit.trimmed['geoip-user'].removed, ['和前面「随便叫什么」重叠的 1.2.3.0…'])

  // 复审 T2 的第二步:核对对象多了一条(前置乙 9.9.9.0/24 切到代理),候选集合内容就是 9.9.9.0/24 → 扣光了,关掉
  const t2 = await resolveNativeBypass(withDecoded({ 'geoip-audit': cidrs('9.9.9.0/24') }), paths, {
    ...plan, pending: [{ policy: '后置直连', sets: ['geoip-audit'], against: [{ name: '前置甲', geoip: [], cidrs: ['1.2.3.0/24'] }, { name: '前置乙', geoip: [], cidrs: ['9.9.9.0/24'] }] }],
  })
  assert.equal(t2.enabled, false)
  assert.match(t2.reason, /前置乙.*一个地址都不剩/)
  const t2before = await resolveNativeBypass(withDecoded({ 'geoip-audit': cidrs('9.9.9.0/24') }), paths, {
    ...plan, pending: [{ policy: '后置直连', sets: ['geoip-audit'], against: [{ name: '前置甲', geoip: [], cidrs: ['1.2.3.0/24'] }] }],
  })
  assert.equal(t2before.enabled, true)

  const list = await resolveNativeBypass(withDecoded({ 'geoip-user': cidrs('1.0.1.0/24') }), paths, {
    ...plan, pending: [{ policy: '用户直连集合', sets: ['geoip-user'], against: [{ name: 'X', geoip: [], cidrs: [], lists: ['list-abc'] }] }],
  })
  assert.equal(list.enabled, false)
  assert.match(list.reason, /规则集链接「list-abc」/)

  // 已经成立的集合 + 核对通过的集合合并
  const merged = await resolveNativeBypass(withDecoded({ 'geoip-user': cidrs('1.0.1.0/24'), 'geoip-anything': cidrs('91.108.4.0/22'), 'geoip-hk': cidrs('8.8.8.0/24') }), paths, { ...plan, sets: ['geoip-hk'], enabled: true })
  assert.deepEqual(merged.sets, ['geoip-hk', 'geoip-user'])
})

test('resolveNativeBypass + FakeIP:前面走代理的规则集链接——IP 那份扣掉重叠段,纯域名的名单不挡,老版式没拆的整份解码只取 ip_cidr(#302)', async () => {
  const state = {
    'list-abc': { url: 'https://example.com/a.list', split: 2, counts: { domain_suffix: 3, ip_cidr: 2 } },
    'list-dom': { url: 'https://example.com/d.list', split: 2, counts: { domain: 5 } },
  }
  const ctxWith = (tags) => {
    const files = { [paths.singbox]: 'x', [`${paths.dataDir}/rule-lists.json`]: JSON.stringify(state) }
    for (const [tag, json] of Object.entries(tags)) {
      files[rulesetPath(paths, tag)] = 'srs'
      files[`${paths.dataDir}/tmp/${tag}.dns-forward.json`] = JSON.stringify(json)
    }
    return createMockContext({ files })
  }
  const plan = (lists) => ({ enabled: false, sets: [], fakeIp: true, reason: '', pending: [{ policy: '国内', sets: ['geoip-cn'], against: [{ name: 'Test', geoip: [], cidrs: [], lists }] }] })
  // 有 IP 那份:和 geoip-cn 重叠的 1.0.1.0/25 扣掉,其余照旁路
  const withIp = await resolveNativeBypass(ctxWith({ 'geoip-cn': cidrs('1.0.1.0/24', '223.5.5.0/24'), 'list-abc-ip': cidrs('74.125.250.0/24', '1.0.1.0/25') }), paths, plan(['list-abc']))
  assert.equal(withIp.enabled, true)
  assert.deepEqual(withIp.sets, ['geoip-cn'])
  assert.ok(withIp.trimmed['geoip-cn'].cidrs.includes('1.0.1.128/25') && withIp.trimmed['geoip-cn'].cidrs.includes('223.5.5.0/24'))
  assert.ok(!withIp.trimmed['geoip-cn'].cidrs.includes('1.0.1.0/24'))
  // 纯域名的名单(没有 IP 那份):不挡,geoip-cn 原样旁路
  const domOnly = await resolveNativeBypass(ctxWith({ 'geoip-cn': cidrs('1.0.1.0/24', '223.5.5.0/24') }), paths, plan(['list-dom']))
  assert.equal(domOnly.enabled, true)
  assert.equal(domOnly.trimmed['geoip-cn'], undefined)
  // 老版式(状态表里没有 split):整份解码,域名条件不管(拿占位地址),只扣 ip_cidr
  const legacy = await resolveNativeBypass(ctxWith({
    'geoip-cn': cidrs('1.0.1.0/24', '223.5.5.0/24'),
    'list-old': { rules: [{ domain_suffix: ['google.com'] }, { ip_cidr: ['223.5.5.0/24'] }] },
  }), paths, plan(['list-old']))
  assert.equal(legacy.enabled, true)
  assert.deepEqual(legacy.trimmed['geoip-cn'].cidrs, ['1.0.1.0/24'])
  // 名单里有逻辑规则:范围说不清,不旁路并说明
  const logical = await resolveNativeBypass(ctxWith({ 'geoip-cn': cidrs('1.0.1.0/24'), 'list-old': { rules: [{ type: 'logical', mode: 'or', rules: [] }] } }), paths, plan(['list-old']))
  assert.equal(logical.enabled, false)
  assert.match(logical.reason, /规则集链接「list-old」含逻辑/)
})

test('resolveNativeBypass + FakeIP 试验:候选集合和占位地址池有交集就扣掉占位地址池再旁路（占位地址要进内核走域名规则）;真实 IP 基准下不看这个', async () => {
  const plan = { enabled: true, sets: ['geoip-user'], pending: [], fakeIp: true, reason: '' }
  const ctx = () => withDecoded({ 'geoip-user': cidrs('1.0.1.0/24', '198.19.0.0/16', 'fc00::/18') })
  const fake = await resolveNativeBypass(ctx(), paths, plan)
  assert.equal(fake.enabled, true)
  assert.match(fake.reason, /扣掉 FakeIP 占位地址池 后入口旁路/)
  assert.deepEqual(fake.trimmed['geoip-user'].cidrs, ['1.0.1.0/24'])
  const real = await resolveNativeBypass(ctx(), paths, { ...plan, fakeIp: false })
  assert.equal(real.enabled, true)
  assert.equal(real.trimmed['geoip-user'], undefined)
})

// GitHub #224:默认分流「国内」= geoip-cn + geoip-private,前面「国外」引用的 geoip-cloudfront 和 geoip-cn 有一段重叠
// (CloudFront 中国节点),geoip-private 又含 224.0.0.0/3。以前 geoip-private 一挡整个站点集都不旁路;现在各扣各的
test('#224:一份集合不合格不牵连同一站点集的兄弟集合;重叠只扣重叠段', async () => {
  const plan = {
    enabled: false, sets: [], fakeIp: true, reason: '',
    pending: [{ policy: '国内', sets: ['geoip-cn', 'geoip-private'], against: [{ name: '国外', geoip: ['geoip-cloudfront'], cidrs: [] }] }],
  }
  const r = await resolveNativeBypass(withDecoded({
    'geoip-cn': cidrs('1.0.1.0/24', '36.96.0.0/12', '223.5.5.0/24'),
    'geoip-private': cidrs('10.0.0.0/8', '224.0.0.0/3'),
    'geoip-cloudfront': cidrs('36.103.232.0/22', '13.32.0.0/15'),
  }), paths, plan)
  assert.equal(r.enabled, true)
  assert.deepEqual(r.sets, ['geoip-cn', 'geoip-private'])
  const cn = r.trimmed['geoip-cn'].cidrs
  assert.ok(cn.includes('1.0.1.0/24') && cn.includes('223.5.5.0/24') && cn.includes('36.96.0.0/14') && !cn.includes('36.96.0.0/12'))
  assert.ok(!cn.some((c) => c.startsWith('36.103.232.') || c.startsWith('36.103.233.') || c.startsWith('36.103.234.') || c.startsWith('36.103.235.')), 'CloudFront 那一段扣掉了')
  assert.match(r.reason, /集合「geoip-cn」扣掉 和前面「国外」重叠的 36\.103\.232\.0… 后入口旁路/)
  assert.match(r.reason, /集合「geoip-private」扣掉 到地址空间末尾的区间（224\.0\.0\.0\/3）的最后一个地址 后入口旁路/)
})

test('U2:候选集合按内容认——纯目标 IP 才能入口旁路;带 port / source_ip_cidr / 域名 / 其它条件的整份走兼容路径并说明;集合名字可改,不按名字判;不牵连别的集合', async () => {
  const plan = { enabled: true, sets: ['geoip-pure', 'geoip-port-restricted', 'geoip-source-restricted', 'geoip-mixed', 'geoip-empty'], pending: [], fakeIp: false, reason: '' }
  const r = await resolveNativeBypass(withDecoded({
    'geoip-pure': cidrs('198.51.100.0/24'),
    'geoip-port-restricted': { rules: [{ ip_cidr: ['198.51.100.0/24'], port: [443] }] },
    'geoip-source-restricted': { rules: [{ ip_cidr: ['198.51.100.0/24'], source_ip_cidr: ['192.0.2.9/32'] }] },
    'geoip-mixed': { rules: [{ ip_cidr: ['198.51.100.0/24'] }, { domain_suffix: ['x.test'], network: ['tcp'] }] },
    'geoip-empty': { rules: [{ domain_suffix: ['only-domain.test'] }] },
  }), paths, plan)
  assert.deepEqual(r.sets, ['geoip-pure'])
  assert.equal(r.enabled, true)
  const byTag = Object.fromEntries(r.checked.map((c) => [c.sets[0], c]))
  assert.equal(byTag['geoip-pure'].ok, true)
  assert.match(byTag['geoip-port-restricted'].reason, /不是纯目标 IP 规则（含 port 条件）/)
  assert.match(byTag['geoip-source-restricted'].reason, /含 source_ip_cidr 条件/)
  assert.match(byTag['geoip-mixed'].reason, /domain_suffix \/ network/)
  assert.match(byTag['geoip-empty'].reason, /不是纯目标 IP 规则/)
  // 同样的内容换个名字结论不变
  const renamed = await resolveNativeBypass(withDecoded({ 'whatever-set': { rules: [{ ip_cidr: ['198.51.100.0/24'], port: [443] }] } }), paths, { ...plan, sets: ['whatever-set'] })
  assert.equal(renamed.enabled, false)
  assert.match(renamed.reason, /含 port 条件/)
})

test('U2:较早规则的集合也按内容认——里面有域名条件就是域名规则（挡住）;只带端口 / 来源的仍按它的 IP 段核对重叠', async () => {
  const pend = (against) => ({ enabled: false, sets: [], fakeIp: false, reason: '', pending: [{ policy: '直连集合', sets: ['geoip-user'], against: [{ name: '前面的', geoip: [against], cidrs: [] }] }] })
  const ctx = () => withDecoded({
    'geoip-user': cidrs('1.0.1.0/24'),
    'geoip-with-domain': { rules: [{ ip_cidr: ['91.108.4.0/22'], domain_suffix: ['x.test'] }] },
    'geoip-port-only': { rules: [{ ip_cidr: ['91.108.4.0/22'], port: [443] }] },
    'geoip-port-overlap': { rules: [{ ip_cidr: ['1.0.1.0/26'], port: [443] }] },
  })
  const dom = await resolveNativeBypass(ctx(), paths, pend('geoip-with-domain'))
  assert.equal(dom.enabled, false)
  assert.match(dom.reason, /含域名条件（domain_suffix）/)
  const port = await resolveNativeBypass(ctx(), paths, pend('geoip-port-only'))
  assert.equal(port.enabled, true)
  // 只在 443 端口走代理的 1.0.1.0/26:入口分不出端口,保守地整段扣掉,其余照旁路
  const portOverlap = await resolveNativeBypass(ctx(), paths, pend('geoip-port-overlap'))
  assert.equal(portOverlap.enabled, true)
  assert.match(portOverlap.reason, /扣掉 和前面「前面的」重叠的 1\.0\.1\.0… 后入口旁路/)
  assert.deepEqual(portOverlap.trimmed['geoip-user'].cidrs, ['1.0.1.64/26', '1.0.1.128/25'])
})
