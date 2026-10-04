import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConfig } from './config.mjs'
import { createNode } from './node-model.mjs'
import { noDomainGuard, normalizeRouting, splitNoDomainGuard } from './routing-model.mjs'
import { FLIP_FALLBACK_TAG, andRule, flattenFlipRule, flipBypassCandidates, flipFlagMap, flipFlagStates, flipFlagTag, isFlipTag } from './flip.mjs'

const nodes = [createNode({ tag: '香港-01', type: 'shadowsocks', server: 'a.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'pw' }, source: 'clash' })]
const groups = [{ id: 'g', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }]
const routing = {
  fallbackDefault: 'direct',
  policies: [
    { id: 'g', name: 'Google', default: '香港-自动', rulesets: ['geosite-google', 'geoip-google'], domainSuffix: ['gstatic.com'] },
    { id: 'cn', name: '国内', default: 'direct', rulesets: ['geoip-cn', 'geosite-cn'] },
    { id: 'ip', name: '纯IP', default: 'direct', ipCidr: ['203.0.113.0/24'] },
  ],
}
const profileOf = (over = {}) => ({
  ipv6: true, ipv6Proxy: 'ipv4', rejectQuic: true,
  dns: { split: true, mode: 'hijack', direct: '223.5.5.5', proxy: '1.1.1.1' },
  tun: { autoRedirect: true },
  routing, clashApiSecret: 's',
  ...over,
})
const build = (profile, selections = {}) => buildConfig({ nodes, userGroups: groups, localSubnets: ['192.168.1.0/24'], profile, selections, rulesetDir: '/opt/open-box/data/rulesets' })
const conf = normalizeRouting(routing)
const G = flipFlagTag({ id: 'g' })
const CN = flipFlagTag({ id: 'cn' })
const IP = flipFlagTag({ id: 'ip' })

test('开关 tag:按站点集 id 取,改名 / 调序不变;兜底固定;只含能进路径的字符', () => {
  assert.equal(flipFlagTag({ id: 'g', name: 'Google' }), flipFlagTag({ id: 'g', name: '谷歌' }))
  assert.notEqual(G, CN)
  assert.match(G, /^obflip-[0-9a-f]{12}$/)
  const map = flipFlagMap(conf)
  assert.deepEqual([...map.keys()], ['Google', '国内', '纯IP', '其他'])
  assert.equal(map.get('其他'), FLIP_FALLBACK_TAG)
  const reordered = flipFlagMap(normalizeRouting({ ...routing, policies: [...routing.policies].reverse() }))
  assert.equal(reordered.get('Google'), G)
  assert.ok(isFlipTag(G) && isFlipTag(FLIP_FALLBACK_TAG) && !isFlipTag('geoip-cn'))
  assert.deepEqual(flipFlagStates(conf, { Google: 'proxy', 国内: 'direct', 纯IP: 'block', 其他: 'direct' }), { [G]: true, [CN]: false, [IP]: true, [FLIP_FALLBACK_TAG]: false }, '不是直连(代理 / 拒绝)就是 ON')
  assert.deepEqual(flipBypassCandidates(conf), ['geoip-google', 'geoip-cn'])
})

test('热切换是唯一的结构:裸档案、带着老开关键的档案、FakeIP 开不开,生成的都是成对规则 + 开关规则集', () => {
  const fake = { split: true, mode: 'hijack', direct: '223.5.5.5', proxy: '1.1.1.1', fakeIpForProxy: true }
  // restartOnFlip / restartOnClassFlip 是 v0.1.207 ~ v0.1.209 的开关键:老备份、还没被 store 清掉的档案里可能带着,生成器不看
  for (const p of [profileOf(), profileOf({ restartOnFlip: true }), profileOf({ restartOnClassFlip: true }), profileOf({ dns: fake })]) {
    const c = build(p)
    assert.ok(c.route.rule_set.some((r) => r.tag === FLIP_FALLBACK_TAG && r.format === 'source'), '兜底的开关规则集登记了')
    assert.ok(c.dns.rules.some((r) => r.type === 'logical' && JSON.stringify(r).includes('obflip-')), 'DNS 是成对规则')
    assert.equal(c.dns.final, 'dns-direct')
  }
})

test('热切换 + FakeIP:占位地址那条和 AAAA 空应答一样挂在开关上,排在真实解析器前面;兜底同理;dns / route / 入站仍与此刻的选择无关', () => {
  const fake = { split: true, mode: 'hijack', direct: '223.5.5.5', proxy: '1.1.1.1', fakeIpForProxy: true }
  // 交给节点(ipv6Proxy=node):没有 AAAA 空应答,占位连 AAAA 一起给
  const node = build(profileOf({ ipv6Proxy: 'node', dns: fake })).dns
  const at = node.rules.findIndex((r) => r.type === 'logical' && r.rules.some((x) => x.rule_set && x.rule_set[0] === CN))
  assert.deepEqual(node.rules.slice(at, at + 3), [
    andRule([{ rule_set: ['geosite-cn'] }, { rule_set: [CN] }, { query_type: ['A', 'AAAA'] }], { server: 'dns-fakeip' }),
    andRule([{ rule_set: ['geosite-cn'] }, { rule_set: [CN] }], { server: 'dns-proxy' }),
    { rule_set: ['geosite-cn'], server: 'dns-direct' },
  ])
  assert.deepEqual(node.rules.slice(-2), [
    andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, { query_type: ['A', 'AAAA'] }], { server: 'dns-fakeip' }),
    { rule_set: [FLIP_FALLBACK_TAG], server: 'dns-proxy' },
  ])
  assert.equal(node.final, 'dns-direct')
  assert.ok(node.servers.some((s) => s.type === 'fakeip'))
  // 代理 v6 降为 IPv4:AAAA 空应答 → 占位(只管 A)→ 真实解析器,顺序和老结构一样
  const v4 = build(profileOf({ dns: fake })).dns
  const g = v4.rules.findIndex((r) => r.type === 'logical' && r.rules.some((x) => x.rule_set && x.rule_set[0] === G))
  assert.deepEqual(v4.rules.slice(g, g + 4).map((r) => [r.rules ? r.rules.at(-1).query_type || null : null, r.server || r.action]), [[['AAAA'], 'predefined'], [['A'], 'dns-fakeip'], [null, 'dns-proxy'], [null, 'dns-direct']])
  assert.deepEqual(v4.rules.slice(-3).map((r) => r.server || r.action), ['predefined', 'dns-fakeip', 'dns-proxy'])
  // 与选择无关(出站里的 selector 默认值在 FakeIP 下会随选择烘进去,那是另一回事,不比)
  const a = build(profileOf({ dns: fake }), {})
  const b = build(profileOf({ dns: fake }), { Google: '直连', 国内: '香港-自动', 其他: '香港-自动' })
  assert.deepEqual(b.dns, a.dns)
  assert.deepEqual(b.route, a.route)
  assert.deepEqual(b.inbounds, a.inbounds)
})

test('热切换:生成的配置与此刻的选择无关——直连 / 代理怎么选,dns / route / 入站都逐字节相同', () => {
  const a = build(profileOf(), {})
  const b = build(profileOf(), { Google: '直连', 国内: '香港-自动', 纯IP: '香港-自动', 其他: '香港-自动' })
  assert.deepEqual(b.dns, a.dns)
  assert.deepEqual(b.route, a.route)
  assert.deepEqual(b.inbounds, a.inbounds)
})

test('热切换 · DNS:每个有域名条件的站点集两支都写(包了开关的 AAAA 空应答 + 代理侧解析器在前,直连支紧跟);代理侧只有一组解析器;兜底成对、final 指直连侧', () => {
  const { dns } = build(profileOf())
  // 此刻走直连的「国内」也写着代理那一支:和别的站点集共用代理侧那一组解析器,不再各开一台
  assert.ok(!dns.servers.some((s) => /^dns-policy-/.test(s.tag)))
  assert.equal(dns.servers.filter((s) => s.tag === 'dns-proxy').length, 1)
  const at = dns.rules.findIndex((r) => r.type === 'logical' && r.rules.some((x) => x.rule_set && x.rule_set[0] === G))
  // Google:规则集 + 域名后缀拆成两半,每一半三条
  assert.deepEqual(dns.rules.slice(at, at + 6), [
    andRule([{ rule_set: ['geosite-google'] }, { rule_set: [G] }, { query_type: ['AAAA'] }], { action: 'predefined', rcode: 'NOERROR' }),
    andRule([{ rule_set: ['geosite-google'] }, { rule_set: [G] }], { server: 'dns-proxy' }),
    { rule_set: ['geosite-google'], server: 'dns-direct' },
    andRule([{ domain_suffix: ['gstatic.com'] }, { rule_set: [G] }, { query_type: ['AAAA'] }], { action: 'predefined', rcode: 'NOERROR' }),
    andRule([{ domain_suffix: ['gstatic.com'] }, { rule_set: [G] }], { server: 'dns-proxy' }),
    { domain_suffix: ['gstatic.com'], server: 'dns-direct' },
  ])
  assert.deepEqual(dns.rules.slice(at + 6, at + 9), [
    andRule([{ rule_set: ['geosite-cn'] }, { rule_set: [CN] }, { query_type: ['AAAA'] }], { action: 'predefined', rcode: 'NOERROR' }),
    andRule([{ rule_set: ['geosite-cn'] }, { rule_set: [CN] }], { server: 'dns-proxy' }),
    { rule_set: ['geosite-cn'], server: 'dns-direct' },
  ])
  // 纯 IP 站点集没有域名条件:DNS 里没有它。兜底排在最后
  assert.ok(!JSON.stringify(dns.rules).includes(IP))
  assert.deepEqual(dns.rules.slice(-2), [
    andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, { query_type: ['AAAA'] }], { action: 'predefined', rcode: 'NOERROR' }),
    { rule_set: [FLIP_FALLBACK_TAG], server: 'dns-proxy' },
  ])
  assert.equal(dns.final, 'dns-direct')
  // 没开「代理 v6 降为 IPv4」:没有 AAAA 那一条
  const plain = build(profileOf({ ipv6Proxy: 'node' })).dns
  assert.ok(!plain.rules.some((r) => r.type === 'logical' && r.action === 'predefined' && JSON.stringify(r).includes('obflip')))
  assert.deepEqual(plain.rules.at(-1), { rule_set: [FLIP_FALLBACK_TAG], server: 'dns-proxy' })
})

test('热切换 · 路由:出口是站点集的规则前恒定插「同条件 + 开关 + 附加条件」的拒绝(此刻直连的也插);兜底两条挂兜底开关;出口是节点组的终端分流照老样子', () => {
  const profile = profileOf({ clientRoutes: [{ id: 'c1', enabled: true, sources: ['192.168.1.9'], outbound: '香港-自动' }, { id: 'c2', enabled: true, sources: ['192.168.1.10'], outbound: '国内' }] })
  const { route } = build(profile)
  const rules = route.rules
  const cn = rules.findIndex((r) => r.outbound === '国内' && r.rule_set)
  // 看域名的一份在前,看 IP 的一份(带「连接没有域名」的前提)紧跟着,各自前面插两条挂开关的拒绝
  assert.deepEqual(rules.slice(cn - 2, cn + 4), [
    andRule([{ rule_set: ['geosite-cn'] }, { rule_set: [CN] }, { ip_version: 6 }], { action: 'reject' }),
    andRule([{ rule_set: ['geosite-cn'] }, { rule_set: [CN] }, { network: 'udp', port: 443 }], { action: 'reject' }),
    { rule_set: ['geosite-cn'], outbound: '国内' },
    andRule([{ rule_set: ['geoip-cn'] }, noDomainGuard(), { rule_set: [CN] }, { ip_version: 6 }], { action: 'reject' }),
    andRule([{ rule_set: ['geoip-cn'] }, noDomainGuard(), { rule_set: [CN] }, { network: 'udp', port: 443 }], { action: 'reject' }),
    andRule([{ rule_set: ['geoip-cn'] }, noDomainGuard()], { outbound: '国内' }),
  ])
  const ip = rules.findIndex((r) => r.outbound === '纯IP')
  assert.deepEqual(rules[ip - 1], andRule([{ ip_cidr: ['203.0.113.0/24'] }, noDomainGuard(), { rule_set: [IP] }, { network: 'udp', port: 443 }], { action: 'reject' }))
  // 终端分流:出口是节点组 → 类别不会变,老写法;出口是站点集 → 挂开关
  const c1 = rules.findIndex((r) => r.source_ip_cidr && r.outbound === '香港-自动')
  assert.deepEqual(rules[c1 - 1], { source_ip_cidr: ['192.168.1.9/32'], network: 'udp', port: 443, action: 'reject' })
  const c2 = rules.findIndex((r) => r.source_ip_cidr && r.outbound === '国内')
  assert.deepEqual(rules[c2 - 1], andRule([{ source_ip_cidr: ['192.168.1.10/32'] }, { rule_set: [CN] }, { network: 'udp', port: 443 }], { action: 'reject' }))
  assert.deepEqual(rules.slice(-2), [
    andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, { ip_version: 6 }], { action: 'reject' }),
    andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, { network: 'udp', port: 443 }], { action: 'reject' }),
  ])
  // v6 降级和屏蔽 QUIC 都没开:路由里的 logical 只剩带「连接没有域名」前提的 IP 规则,里面没有开关;开关只在 DNS 里用,
  // 开关规则集条目照样全在。首包预判的放行(订阅和节点站点直连那条,action bypass)不挂开关,不在这里比
  const bare = build(profileOf({ ipv6Proxy: 'node', rejectQuic: false }))
  const logical = bare.route.rules.filter((r) => r.type === 'logical' && r.action !== 'bypass')
  assert.ok(bare.route.rules.some((r) => r.action === 'bypass' && JSON.stringify(r).includes('obnode-direct-ip') && !JSON.stringify(r).includes('obflip-')))
  assert.ok(logical.length > 0 && logical.every((r) => splitNoDomainGuard(r).noDomain && !JSON.stringify(r).includes('obflip-')))
  const flags = bare.route.rule_set.filter((r) => isFlipTag(r.tag) && r.format === 'source')
  assert.deepEqual(flags.map((r) => [r.tag, r.path]), [G, CN, IP, FLIP_FALLBACK_TAG].map((t) => [t, `/opt/open-box/data/flip/${t}.json`]))
})

test('热切换 · 入口旁路:有 nft 重定向时是静态候选表(每个 geoip 一份动态集),与类别无关;纯 tun 维持老的静态写法', () => {
  const hot = build(profileOf())
  assert.deepEqual(hot.inbounds[0].route_exclude_address_set, ['obflip-byp-geoip-google', 'obflip-byp-geoip-cn'])
  assert.deepEqual(hot.route.rule_set.filter((r) => r.tag.startsWith('obflip-byp-')), [
    { type: 'local', tag: 'obflip-byp-geoip-google', format: 'binary', path: '/opt/open-box/data/flip/obflip-byp-geoip-google.srs' },
    { type: 'local', tag: 'obflip-byp-geoip-cn', format: 'binary', path: '/opt/open-box/data/flip/obflip-byp-geoip-cn.srs' },
  ])
  // 站点集自己的规则仍引用原来的 geoip-*
  assert.ok(hot.route.rules.map((r) => splitNoDomainGuard(r).rule).some((r) => r.outbound === '国内' && (r.rule_set || []).includes('geoip-cn')))
  const pureTun = build(profileOf({ tun: { autoRedirect: false } }))
  assert.ok(!JSON.stringify(pureTun.inbounds[0]).includes('obflip-byp-'))
  assert.ok(!pureTun.route.rule_set.some((r) => r.tag.startsWith('obflip-byp-')))
})

test('flattenFlipRule:开关 OFF 的代理支跳过;ON 的展平成普通规则;不含开关的规则(含域名过滤那种 logical)原样', () => {
  const pair = andRule([{ rule_set: ['geosite-google'] }, { rule_set: [G] }, { query_type: ['AAAA'] }], { action: 'predefined', rcode: 'NOERROR' })
  assert.equal(flattenFlipRule(pair, { [G]: false }), null)
  assert.equal(flattenFlipRule(pair, {}), null, '查不到的开关按 OFF 算')
  assert.deepEqual(flattenFlipRule(pair, { [G]: true }), { rule_set: ['geosite-google'], query_type: ['AAAA'], action: 'predefined', rcode: 'NOERROR' })
  assert.deepEqual(flattenFlipRule(andRule([{ source_ip_cidr: ['10.0.0.9/32'] }, { rule_set: [CN] }, { network: 'udp', port: 443 }], { action: 'reject' }), { [CN]: true }), { source_ip_cidr: ['10.0.0.9/32'], network: 'udp', port: 443, action: 'reject' })
  // 兜底代理支是单独一条
  assert.equal(flattenFlipRule({ rule_set: [FLIP_FALLBACK_TAG], server: 'dns-proxy' }, {}), null)
  assert.deepEqual(flattenFlipRule({ rule_set: [FLIP_FALLBACK_TAG], server: 'dns-proxy' }, { [FLIP_FALLBACK_TAG]: true }), { server: 'dns-proxy' })
  const plain = { rule_set: ['geosite-cn'], server: 'dns-direct' }
  assert.equal(flattenFlipRule(plain, {}), plain)
  const filter = andRule([{ rule_set: ['dns-filter-block-1'] }, { rule_set: ['dns-filter-allow-1'], invert: true }], { action: 'predefined', rcode: 'NXDOMAIN' })
  assert.equal(flattenFlipRule(filter, {}), filter)
})

test('档案:没有「切换重启内核」这个键;老版本留下的两个开关键(restartOnClassFlip / restartOnFlip)读写时删掉,不管存的是什么都生成热切换结构', async () => {
  const { createStore, DEFAULT_PROFILE } = await import('../store/openbox-store.mjs')
  const { buildCurrentConfig } = await import('../api/deploy-runner.mjs')
  assert.equal('restartOnFlip' in DEFAULT_PROFILE, false)
  const mem = new Map()
  const store = createStore({ get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v), del: (k) => mem.delete(k) })
  store.setGroups(groups)
  store.setProfile({ routing })
  assert.equal('restartOnFlip' in store.getProfile(), false)
  // v0.1.208 / v0.1.209 里打开过开关(= 要重启)的用户、v0.1.207 默认值被一起落库的用户:读出来键就没了
  mem.set('openbox/profile', JSON.stringify({ ...JSON.parse(mem.get('openbox/profile')), restartOnClassFlip: true, restartOnFlip: true }))
  const upgraded = store.getProfile()
  assert.equal('restartOnClassFlip' in upgraded, false)
  assert.equal('restartOnFlip' in upgraded, false)
  assert.equal(JSON.parse(mem.get('openbox/profile')).restartOnFlip, undefined, '清理结果写回了库')
  const { config } = buildCurrentConfig(store, [], { rulesetDir: '/opt/open-box/data/rulesets' })
  assert.ok(config.dns.rules.some((r) => r.type === 'logical' && JSON.stringify(r).includes('obflip-')), '生成热切换结构')
  // 老版本导出的备份 / 老前端带着这个键来保存:校验放行,落库时照样删掉
  store.setProfile({ restartOnFlip: true })
  assert.equal('restartOnFlip' in store.getProfile(), false)
})
