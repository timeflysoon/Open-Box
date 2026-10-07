import assert from 'node:assert/strict'
import test from 'node:test'
import { connectionOwner, findKernelRule, parseKernelRuleText, ruleOwner } from './rule-owner.mjs'

const builtin = { direct: '直连', block: '拒绝' }
const routing = {
  fallbackDefault: 'direct',
  custom: { name: '前置自定义', rules: [{ type: 'domainSuffix', value: 'baidu.com', outbound: 'direct' }, { type: 'port', value: '51820', outbound: 'direct' }] },
  policies: [
    { id: 'abroad', name: '国外', rulesets: ['geosite-gfw', 'geoip-cloudflare'], default: 'HK' },
    { id: 'cn', name: '国内', rulesets: ['geosite-cn', 'geoip-cn'], default: 'direct' },
  ],
}
const rules = [
  { action: 'sniff' },
  { inbound: ['dns-in'], action: 'hijack-dns' },
  { ip_cidr: ['172.19.0.0/30'], port: [53], action: 'route-options', override_address: '127.0.0.1' },
  { domain_suffix: ['baidu.com'], outbound: '直连' },
  { ip_is_private: true, outbound: '直连' },
  { domain: ['a.node.example', 'b.node.example', 'c.node.example', 'd.node.example'], ip_cidr: ['1.2.3.4/32'], outbound: '直连' },
  { source_ip_cidr: ['192.168.3.35/32'], outbound: '直连' },
  { rule_set: ['geosite-gfw', 'geoip-cloudflare'], outbound: '国外' },
  { rule_set: ['geosite-cn', 'geoip-cn'], outbound: '国内' },
]

test('parseKernelRuleText:单值 / 方括号列表 / 截断的列表 / 动作与出口', () => {
  const a = parseKernelRuleText('domain_suffix=baidu.com => route(直连)')
  assert.deepEqual([...a.items], [['domain_suffix', { values: ['baidu.com'], truncated: false }]])
  assert.equal(a.outbound, '直连')
  assert.equal(a.action, 'route')
  const b = parseKernelRuleText('domain=[a.node.example b.node.example c.node.example...] ip_cidr=1.2.3.4/32 => route(直连,udp_connect)')
  assert.deepEqual(b.items.get('domain'), { values: ['a.node.example', 'b.node.example', 'c.node.example'], truncated: true })
  assert.deepEqual(b.items.get('ip_cidr'), { values: ['1.2.3.4/32'], truncated: false })
  assert.equal(b.outbound, '直连')
  const c = parseKernelRuleText('rule_set=[geosite-gfw geoip-cloudflare] => route(国外)')
  assert.deepEqual(c.items.get('rule_set'), { values: ['geosite-gfw', 'geoip-cloudflare'], truncated: false })
  assert.equal(c.outbound, '国外')
  assert.equal(parseKernelRuleText('ip_cidr=172.19.0.0/30 => reject').action, 'reject')
  // 测试夹具里出现过的全角括号也认
  assert.equal(parseKernelRuleText('rule_set=[geoip-google] => route（国外）').outbound, '国外')
  assert.equal(parseKernelRuleText('').items.size, 0)
})

test('findKernelRule:按内容对回配置里的那一条,出口对不上的不算;截断的列表按前三个比', () => {
  assert.equal(findKernelRule(rules, 'domain_suffix=baidu.com => route(直连)').index, 3)
  assert.equal(findKernelRule(rules, 'domain=[a.node.example b.node.example c.node.example...] ip_cidr=1.2.3.4/32 => route(直连)').index, 5)
  assert.equal(findKernelRule(rules, 'rule_set=[geosite-gfw geoip-cloudflare] => route(国外)').index, 7)
  assert.equal(findKernelRule(rules, 'ip_is_private=true => route(直连)').index, 4)
  // 同样的条件、不同的出口:不是同一条
  assert.equal(findKernelRule(rules, 'domain_suffix=baidu.com => route(国外)').index, -1)
  // 少了一个条件项也不算
  assert.equal(findKernelRule(rules, 'domain=[a.node.example b.node.example c.node.example...] => route(直连)').index, -1)
  assert.equal(findKernelRule(rules, 'RuleSet(geosite-cn)').index, -1)
})

test('ruleOwner:站点集 / 前置自定义 / 内置规则分类', () => {
  assert.deepEqual(ruleOwner(rules[7], routing, builtin), { kind: 'policy', name: '国外' })
  assert.deepEqual(ruleOwner(rules[3], routing, builtin), { kind: 'custom', name: '前置自定义' })
  assert.deepEqual(ruleOwner({ port: [51820], outbound: '直连' }, routing, builtin), { kind: 'custom', name: '前置自定义' })
  assert.deepEqual(ruleOwner(rules[4], routing, builtin), { kind: 'builtin', name: 'private' })
  // NTP 对时直连(GitHub #156):内置的 UDP 123 直连;出口不是直连的同形规则不算它
  assert.deepEqual(ruleOwner({ network: 'udp', port: [123], outbound: '直连' }, routing, builtin), { kind: 'builtin', name: 'ntp' })
  assert.deepEqual(ruleOwner({ network: 'udp', port: [123], outbound: 'HK' }, routing, builtin), { kind: 'builtin', name: 'other' })
  assert.deepEqual(ruleOwner(rules[5], routing, builtin), { kind: 'builtin', name: 'nodes' })
  // 部署的配置里订阅和节点站点直连引用两份规则集(engine/direct-hosts.mjs)
  assert.deepEqual(ruleOwner({ rule_set: ['obnode-direct', 'obnode-direct-ip'], outbound: builtin.direct }, routing, builtin), { kind: 'builtin', name: 'nodes' })
  assert.deepEqual(ruleOwner(rules[6], routing, builtin), { kind: 'builtin', name: 'clients' })
  assert.deepEqual(ruleOwner(rules[1], routing, builtin), { kind: 'builtin', name: 'kernel' })
  assert.deepEqual(ruleOwner(rules[2], routing, builtin), { kind: 'builtin', name: 'kernel' })
  assert.equal(ruleOwner(null, routing, builtin), null)
})

test('connectionOwner:链路根是站点集就是它;否则按规则原文对回去;对不上返回 null', () => {
  assert.deepEqual(connectionOwner({ chains: ['国外', '香港-故转', 'VW | 香港-01'], rule: 'rule_set=[geosite-gfw geoip-cloudflare] => route(国外)', routeRules: rules, routing, builtin }), { kind: 'policy', name: '国外' })
  assert.deepEqual(connectionOwner({ chains: ['直连'], rule: 'domain_suffix=baidu.com => route(直连)', routeRules: rules, routing, builtin }), { kind: 'custom', name: '前置自定义', index: 3 })
  assert.deepEqual(connectionOwner({ chains: ['直连'], rule: 'ip_is_private=true => route(直连)', routeRules: rules, routing, builtin }), { kind: 'builtin', name: 'private', index: 4 })
  assert.deepEqual(connectionOwner({ chains: ['直连'], rule: 'network=udp port=123 => route(直连)', routeRules: [...rules, { network: 'udp', port: [123], outbound: '直连' }], routing, builtin }), { kind: 'builtin', name: 'ntp', index: rules.length })
  assert.equal(connectionOwner({ chains: ['直连'], rule: 'RuleSet(geosite-cn)', routeRules: rules, routing, builtin }), null)
  assert.equal(connectionOwner({ chains: [], rule: '', routeRules: rules, routing, builtin }), null)
})

test('真实路由:终端分流规则挂着「入站不是共享网络」(engine/client-routes.mjs),原文和配置都去掉它再对,归「终端分流」', () => {
  const routeRules = [
    { domain_suffix: ['google.com'], outbound: '谷歌' },
    { type: 'logical', mode: 'and', rules: [{ source_ip_cidr: ['192.168.3.18/32'] }, { inbound: ['share-home'], invert: true }], outbound: '直连' },
  ]
  const found = findKernelRule(routeRules, 'source_ip_cidr=192.168.3.18/32 && !(inbound=share-home) => route(直连)')
  assert.equal(found.index, 1)
  const owner = connectionOwner({ chains: ['直连'], rule: 'source_ip_cidr=192.168.3.18/32 && !(inbound=share-home) => route(直连)', routeRules, routing: {}, builtin: { direct: '直连', block: '拒绝' } })
  assert.deepEqual(owner, { kind: 'builtin', name: 'clients', index: 1 })
})

