import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { DEFAULT_SHARE_REGIONS, SHARE_REGIONS_DEFAULT_FILE, effectiveShareRegions, shareRegionsVersion, validateShareRegions } from './share-regions.mjs'

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
  assert.equal(effectiveShareRegions({}), DEFAULT_SHARE_REGIONS)
  assert.equal(effectiveShareRegions({ shareRegions: [] }), DEFAULT_SHARE_REGIONS)
  const custom = [{ ...structuredClone(DEFAULT_SHARE_REGIONS[2]) }]
  assert.equal(effectiveShareRegions({ shareRegions: custom }), custom)
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
    ['bad rule type', base().map((g, i) => (i === 0 ? { ...g, rules: [{ type: 'regex', value: '.*', action: 'direct' }] } : g))],
    ['bad cidr', base().map((g, i) => (i === 0 ? { ...g, rules: [{ type: 'ipcidr', value: '10.0.0.0/33', action: 'direct' }] } : g))],
    ['bad geo name', base().map((g, i) => (i === 0 ? { ...g, rules: [{ type: 'geosite', value: '../etc', action: 'direct' }] } : g))],
    ['no name', base().map((g, i) => (i === 0 ? { ...g, name: {} } : g))],
  ]
  for (const [label, value] of cases) assert.ok(validateShareRegions(value), label)
  assert.equal(validateShareRegions(base().map((g, i) => (i === 0 ? { ...g, rules: [{ type: 'ipcidr', value: '10.1.2.3', action: 'direct' }] } : g))), null)
})
