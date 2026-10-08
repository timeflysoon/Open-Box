import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_SHARE_REGIONS, SHARE_REGIONS_DEFAULT_FILE, collectShareRegionRuleUrls, effectiveShareRegions, normalizeShareGroup, shareRegionsForClient,
  shareRegionsVersion, validateShareRegions, withHomeLanRules,
} from './share-regions.mjs'
import { listTagForUrl } from './rule-list.mjs'

// 默认三组只有一份:客户端内置的 clients/core/regions-default.json。面板这份是拷贝(发布包里没有 clients/),一字不差
// 只打包面板的检出里没有 clients/(比如发版用的 worktree),那就没得比,跳过
const CLIENTS_DEFAULT = new URL('../../../clients/core/regions-default.json', import.meta.url)
test('panel default share regions are an exact copy of the clients default', { skip: fs.existsSync(CLIENTS_DEFAULT) ? false : '这个检出里没有 clients/' }, () => {
  const clients = CLIENTS_DEFAULT
  assert.equal(fs.readFileSync(SHARE_REGIONS_DEFAULT_FILE, 'utf8'), fs.readFileSync(clients, 'utf8'))
  assert.deepEqual(DEFAULT_SHARE_REGIONS.map((g) => g.id), ['cn', 'hkmo', 'other'])
})

test('default groups pass validation; empty list means back to defaults', () => {
  assert.equal(validateShareRegions(structuredClone(DEFAULT_SHARE_REGIONS)), null)
  assert.equal(validateShareRegions([]), null)
  assert.deepEqual(effectiveShareRegions({}), DEFAULT_SHARE_REGIONS)
  assert.deepEqual(effectiveShareRegions({ shareRegions: [] }), DEFAULT_SHARE_REGIONS)
  const custom = [{ ...structuredClone(DEFAULT_SHARE_REGIONS[2]) }]
  assert.deepEqual(effectiveShareRegions({ shareRegions: custom }), custom)
  assert.notEqual(shareRegionsVersion(custom), shareRegionsVersion(DEFAULT_SHARE_REGIONS))
})

test('validation rejects malformed groups', () => {
  const base = () => structuredClone(DEFAULT_SHARE_REGIONS)
  const cases = [
    ['not array', {}],
    ['two defaults', base().map((g) => ({ ...g, default: true }))],
    ['no default', base().map((g) => ({ ...g, default: false }))],
    ['duplicate id', base().map((g) => ({ ...g, id: 'x' }))],
    ['region in two groups', base().map((g) => ({ ...g, regions: ['CN'] }))],
    ['bad region code', base().map((g, i) => (i === 0 ? { ...g, regions: ['cn'] } : g))],
    ['bad catchAll', base().map((g, i) => (i === 0 ? { ...g, catchAll: 'block' } : g))],
    ['bad resolver', base().map((g, i) => (i === 0 ? { ...g, dns: { directResolver: 'dns.example' } } : g))],
    ['bad direct dns', base().map((g, i) => (i === 0 ? { ...g, dns: { ...g.dns, direct: 'dns.example' } } : g))],
    ['bad proxy port', base().map((g, i) => (i === 0 ? { ...g, dns: { ...g.dns, proxyPort: 70000 } } : g))],
    ['too many backups', base().map((g, i) => (i === 0 ? { ...g, dns: { ...g.dns, directExtras: ['1.0.0.1', '8.8.8.8', '9.9.9.9', '223.6.6.6'].map((server) => ({ server, protocol: 'udp', port: 53 })) } } : g))],
    ['duplicate upstream', base().map((g, i) => (i === 0 ? { ...g, dns: { ...g.dns, proxyExtras: [{ server: '1.1.1.1', protocol: 'udp', port: 53 }] } } : g))],
    ['system DNS on the proxy side in Mainland China', base().map((g, i) => (i === 0 ? { ...g, dns: { ...g.dns, proxy: 'wan' } } : g))],
    ['description too long', base().map((g, i) => (i === 0 ? { ...g, description: 'x'.repeat(121) } : g))],
    ['default not boolean', base().map((g, i) => (i === 0 ? { ...g, default: 'yes' } : g))],
    ['bad rule type', base().map((g, i) => (i === 0 ? { ...g, rules: [{ type: 'regex', value: '.*', action: 'direct' }] } : g))],
    ['bad cidr', base().map((g, i) => (i === 0 ? { ...g, rules: [{ type: 'ipcidr', value: '10.0.0.0/33', action: 'direct' }] } : g))],
    ['bad geo name', base().map((g, i) => (i === 0 ? { ...g, rules: [{ type: 'geosite', value: '../etc', action: 'direct' }] } : g))],
    ['no name', base().map((g, i) => (i === 0 ? { ...g, name: {} } : g))],
    ['blank name', base().map((g, i) => (i === 0 ? { ...g, name: '  ' } : g))],
    ['name too long', base().map((g, i) => (i === 0 ? { ...g, name: '名'.repeat(31) } : g))],
  ]
  for (const [label, value] of cases) assert.ok(validateShareRegions(value), label)
  assert.equal(validateShareRegions(base().map((g, i) => (i === 0 ? { ...g, rules: [{ type: 'ipcidr', value: '10.1.2.3', action: 'direct' }] } : g))), null)
})

test('一组:名字一个字符串 + 说明;DNS 和路由器的 DNS 上游同一个形状,默认值按这一组有没有中国大陆', () => {
  const [cn, hkmo, other] = DEFAULT_SHARE_REGIONS
  assert.equal(cn.name, '中国大陆')
  assert.ok(cn.description)
  assert.deepEqual(cn.dns, { direct: 'wan', directProtocol: 'udp', directPort: 53, directExtras: [], proxy: '1.1.1.1', proxyProtocol: 'tcp', proxyPort: 53, proxyExtras: [] })
  for (const g of [hkmo, other]) assert.equal(g.dns.proxy, 'wan', g.id)
  // 中国大陆之外的组代理侧可以用系统 DNS;备用上游照收
  const ok = structuredClone(DEFAULT_SHARE_REGIONS)
  ok[2].dns.directExtras = [{ server: '1.1.1.1', protocol: 'tcp', port: 53 }]
  assert.equal(validateShareRegions(ok), null)
})

test('老写法照收:多语种名字取简体 → 繁体 → 英文,directResolver 换成直连上游,代理侧按地区给默认', () => {
  const legacy = { id: 'x', name: { 'zh-TW': '中國大陸', en: 'Mainland' }, regions: ['CN'], rules: [], catchAll: 'proxy', dns: { directResolver: '223.5.5.5' } }
  const g = normalizeShareGroup(legacy)
  assert.equal(g.name, '中國大陸')
  assert.equal(g.description, '')
  assert.deepEqual(g.dns, { direct: '223.5.5.5', directProtocol: 'udp', directPort: 53, directExtras: [], proxy: '1.1.1.1', proxyProtocol: 'tcp', proxyPort: 53, proxyExtras: [] })
  assert.equal(normalizeShareGroup({ ...legacy, regions: [], dns: { directResolver: '' } }).dns.proxy, 'wan')
  const other = { id: 'o', name: { en: 'Else' }, regions: [], default: true, rules: [], catchAll: 'direct', dns: { directResolver: '' } }
  assert.equal(validateShareRegions([legacy, other]), null)
  assert.equal(effectiveShareRegions({ shareRegions: [legacy, other] })[1].name, 'Else')
})

test('「在这些地区之外」:至少一个地区;可以列别的组的地区;算不算中国大陆看有没有列中国', () => {
  const base = () => structuredClone(DEFAULT_SHARE_REGIONS)
  // 其他地区 = 中国、香港、澳门之外:和前两组的地区不冲突;列了中国就不算中国大陆,代理侧可以用系统 DNS
  const ok = base()
  ok[2] = { ...ok[2], regions: ['CN', 'HK', 'MO'], regionMatch: 'outside' }
  assert.equal(validateShareRegions(ok), null)
  assert.equal(normalizeShareGroup(ok[2]).regionMatch, 'outside')
  assert.equal('regionMatch' in normalizeShareGroup(base()[0]), false)
  // 没列中国:会用在中国大陆,代理侧不能用系统 DNS;默认值也按中国大陆给
  const noCn = base()
  noCn[2] = { ...noCn[2], regions: ['HK'], regionMatch: 'outside' }
  assert.match(validateShareRegions(noCn), /cannot use the system DNS/)
  assert.equal(normalizeShareGroup({ ...noCn[2], dns: undefined }).dns.proxy, '1.1.1.1')
  // 一个地区都没有不行;取值只认 inside / outside
  const empty = base()
  empty[2] = { ...empty[2], regions: [], regionMatch: 'outside' }
  assert.match(validateShareRegions(empty), /needs at least one region/)
  const bad = base()
  bad[2] = { ...bad[2], regionMatch: 'except' }
  assert.match(validateShareRegions(bad), /regionMatch/)
})

// 用户 2026-10-05:地区分流的规则和目标分流对齐,多了域名关键词和规则集链接
test('域名关键词、规则集链接:能存;格式不对的拦下', () => {
  const withRules = (rules) => DEFAULT_SHARE_REGIONS.map((g, i) => (i === 0 ? { ...structuredClone(g), rules } : structuredClone(g)))
  assert.equal(validateShareRegions(withRules([
    { type: 'domainKeyword', value: 'openai', action: 'proxy' },
    { type: 'ruleUrl', value: 'https://lists.example.com/ai.list', action: 'proxy' },
  ])), null)
  for (const bad of [
    { type: 'domainKeyword', value: 'open ai', action: 'proxy' },
    { type: 'ruleUrl', value: 'ftp://lists.example.com/ai.list', action: 'proxy' },
    { type: 'ruleUrl', value: `https://lists.example.com/${'a'.repeat(2050)}`, action: 'proxy' },
  ]) {
    assert.match(validateShareRegions(withRules([bad])), /invalid/, JSON.stringify(bad))
  }
})

test('默认值照正式路由器 192.168.3.1:中国大陆一组最前面是 browserleaks 三条、googleapis.cn / google.cn 走代理,排在 geosite cn 前面', () => {
  // googleapis.cn / google.cn 在 geosite-cn 里(会被判成直连),路由器上它们先命中 Google 站点集走代理:手机交回路由器才一致
  const proxied = ['browserleaks.com', 'browserleaks.org', 'browserleaks.net', 'googleapis.cn', 'google.cn']
  assert.deepEqual(DEFAULT_SHARE_REGIONS[0].rules.slice(0, 5), proxied.map((value) => ({ type: 'domainSuffix', value, action: 'proxy' })))
  assert.deepEqual(DEFAULT_SHARE_REGIONS[0].rules[5], { type: 'geosite', value: 'cn', action: 'direct' })
})

test('发给 App:老 App 删掉新类型;rules=2 全给,规则集链接带 sets;链接去重收集', () => {
  const url = 'https://lists.example.com/ai.list'
  const groups = [{ ...structuredClone(DEFAULT_SHARE_REGIONS[2]), rules: [
    { type: 'domainKeyword', value: 'openai', action: 'proxy' },
    { type: 'ruleUrl', value: url, action: 'proxy' },
    { type: 'ruleUrl', value: url, action: 'direct' },
    { type: 'geosite', value: 'cn', action: 'proxy' },
  ] }]
  assert.deepEqual(shareRegionsForClient(groups)[0].rules, [{ type: 'geosite', value: 'cn', action: 'proxy' }])
  const sets = [{ tag: listTagForUrl(url), kind: 'domain', sha256: 'ab' }]
  const fresh = shareRegionsForClient(groups, { rulesVersion: 2, setsFor: (u) => (u === url ? sets : []) })[0].rules
  assert.deepEqual(fresh.map((r) => r.type), ['domainKeyword', 'ruleUrl', 'ruleUrl', 'geosite'])
  assert.deepEqual(fresh[1].sets, sets)
  assert.equal('sets' in fresh[0], false)
  assert.deepEqual(collectShareRegionRuleUrls(groups), [{ url, tag: listTagForUrl(url), optional: true }])
  assert.deepEqual(collectShareRegionRuleUrls(DEFAULT_SHARE_REGIONS), [])
})

// 家里局域网(用户 2026-10-08「应该同步加到地区分流里面,这样同步一下就可以了」):发给 App 的每组最前面自动带「局域网网段 → 回路由器」
test('withHomeLanRules:每组最前面带上局域网网段 → 回路由器;同一网段这一组写过的(不管走哪边、写法不同)不再加;没有网段原样返回', () => {
  const out = withHomeLanRules(DEFAULT_SHARE_REGIONS, ['192.168.5.0/24', '10.0.0.0/24', '192.168.5.0/24'])
  for (const [i, g] of out.entries()) {
    assert.deepEqual(g.rules.slice(0, 2), [
      { type: 'ipcidr', value: '192.168.5.0/24', action: 'proxy' },
      { type: 'ipcidr', value: '10.0.0.0/24', action: 'proxy' },
    ])
    assert.deepEqual(g.rules.slice(2), DEFAULT_SHARE_REGIONS[i].rules)
  }
  // 档案里的那份不动(只在发出去时加)
  assert.ok(DEFAULT_SHARE_REGIONS.every((g) => !g.rules.some((r) => r.type === 'ipcidr')))
  const mine = [{ ...DEFAULT_SHARE_REGIONS[1], rules: [{ type: 'ipcidr', value: '192.168.5.9/24', action: 'direct' }] }]
  assert.deepEqual(withHomeLanRules(mine, ['192.168.5.0/24', '10.0.0.0/24'])[0].rules, [
    { type: 'ipcidr', value: '10.0.0.0/24', action: 'proxy' },
    { type: 'ipcidr', value: '192.168.5.9/24', action: 'direct' },
  ])
  assert.equal(withHomeLanRules(DEFAULT_SHARE_REGIONS, []), DEFAULT_SHARE_REGIONS)
  assert.equal(withHomeLanRules(DEFAULT_SHARE_REGIONS, undefined), DEFAULT_SHARE_REGIONS)
  // 加出来的照样过地区分流的校验(App 端的 ipcidr 也认)
  assert.equal(validateShareRegions(out), null)
})
