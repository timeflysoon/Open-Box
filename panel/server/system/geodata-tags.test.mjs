import assert from 'node:assert/strict'
import test from 'node:test'
import { geoRulesetAvailable, normalizeRouting, setAvailableGeoTags } from '../engine/routing-model.mjs'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { geoTagsFromManifest, registerBundledGeoTags } from './geodata-tags.mjs'

test('从规则库清单里取 geosite / geoip 的规则集名(去掉 .srs);别的文件和坏清单不算', () => {
  assert.deepEqual(geoTagsFromManifest({ files: { 'geoip-cn.srs': 'a', 'geosite-github@ads.srs': 'b', 'LICENSE': 'c', 'geosite-x.json': 'd' } }), ['geoip-cn', 'geosite-github@ads'])
  assert.deepEqual(geoTagsFromManifest(null), [])
  assert.deepEqual(geoTagsFromManifest({ files: [] }), [])
})

test('按随包清单登记:登记后包里没有的 geo 规则集不算数,别的规则集(规则集链接 list-*)不受影响;读不到清单就不筛', async () => {
  const paths = createPaths('/opt/open-box')
  try {
    const ctx = createMockContext({ files: { [`${paths.geoDir}/manifest.json`]: JSON.stringify({ files: { 'geosite-cn.srs': 'x', 'geoip-cn.srs': 'y' } }) } })
    assert.equal(await registerBundledGeoTags(ctx, paths), 2)
    assert.equal(geoRulesetAvailable('geosite-cn'), true)
    assert.equal(geoRulesetAvailable('geosite-github@ads'), false)
    assert.equal(geoRulesetAvailable('list-0123abcd'), true)
    const logs = []
    assert.equal(await registerBundledGeoTags(createMockContext({ files: {} }), paths, { log: (m) => logs.push(m) }), 0)
    assert.equal(geoRulesetAvailable('geosite-github@ads'), true, '读不到清单:不筛')
    assert.match(logs[0], /读不到规则库清单/)
  } finally {
    setAvailableGeoTags(null)
  }
})

test('规整站点集:包里没有的规则集去掉并按「谁引用的」列出来;只剩它的站点集整个不进;停用的不列;没登记就原样', () => {
  const routing = {
    custom: { name: '前置', rules: [{ type: 'geoip', value: 'gone', outbound: 'direct' }, { type: 'ruleset', value: 'geosite-gone2', outbound: 'block' }, { type: 'domain', value: 'x.com', outbound: 'direct' }] },
    policies: [
      { id: 'a', name: 'A', default: 'proxy', rulesets: ['geosite-google', 'geosite-github@ads'], domain: ['y.com'] },
      { id: 'b', name: 'B', default: 'block', rulesets: ['geosite-whatsapp@ads'] },
      { id: 'c', name: 'C', enabled: false, default: 'block', rulesets: ['geosite-nope'] },
    ],
  }
  try {
    setAvailableGeoTags(['geosite-google', 'geoip-cn'])
    const conf = normalizeRouting(routing)
    // B 只剩缺的那一项、C 是停用的且也只引用了缺的:去掉之后都没条件了,不在列表里
    assert.deepEqual(conf.policies.map((p) => [p.name, p.rulesets]), [['A', ['geosite-google']]])
    assert.deepEqual(conf.custom.rules.map((r) => r.type), ['domain'])
    assert.deepEqual(conf.missingRulesets, [
      { tag: 'geoip-gone', owner: '前置' }, { tag: 'geosite-gone2', owner: '前置' },
      { tag: 'geosite-github@ads', owner: 'A' }, { tag: 'geosite-whatsapp@ads', owner: 'B' },
    ])
    setAvailableGeoTags(null)
    const raw = normalizeRouting(routing)
    assert.equal(raw.missingRulesets, undefined)
    assert.deepEqual(raw.policies.find((p) => p.name === 'A').rulesets, ['geosite-google', 'geosite-github@ads'])
    assert.equal(raw.custom.rules.length, 3)
  } finally {
    setAvailableGeoTags(null)
  }
})
