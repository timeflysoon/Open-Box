import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildFilterConfig, chunkRules, contentKey, DNS_FILTER_DEFAULT, DNS_FILTER_SET_ENTRIES, ruleHasRegex, filterForwardPlan, filterKey, filterSettings, parseDnsFilter, validateDnsFilter } from './dns-filter.mjs'

test('DNS filtering defaults off; empty list stays empty; forward changes only while enabled', () => {
  assert.equal(DNS_FILTER_DEFAULT.enabled, false)
  assert.equal(DNS_FILTER_DEFAULT.autoUpdate.enabled, false)
  assert.equal(DNS_FILTER_DEFAULT.lists[0].url, 'https://anti-ad.net/easylist.txt')
  assert.deepEqual(filterSettings({ dns: { filter: { enabled: true, autoUpdate: { days: 7 } } } }).autoUpdate, { enabled: false, days: 7, hour: 4 })
  assert.equal(filterSettings({ dns: { filter: { autoUpdate: { enabled: true } } } }).autoUpdate.enabled, true)
  const plan = { mode: 'domains', domains: ['proxy.test'] }
  assert.equal(filterForwardPlan({}, plan), plan)
  assert.equal(filterForwardPlan({ dns: { filter: { enabled: true } } }, plan).mode, 'all')
  assert.deepEqual(buildFilterConfig({}, null), { rules: [], sets: [] })
  assert.equal(validateDnsFilter({ enabled: false, lists: [], allowDomains: [] }), null)
})

test('DNS syntax preserves allow, important, query types, denyallow, wildcard and exact hosts', () => {
  const result = parseDnsFilter('! title\n||ads.example.com^\n@@||safe.ads.example.com^\n0.0.0.0 exact.example.com\n||*.wild.example.com^$dnstype=A|AAAA\n/^ad[0-9]+\\.example\\.com$/$denyallow=ad1.example.com\n||critical.example.com^$important\nexample.com##.banner\n||unknown.example.com^$third-party')
  assert.equal(result.count, 6)
  assert.equal(result.unsupported, 2)
  assert.deepEqual(result.rules.allow, [{ domain_suffix: ['safe.ads.example.com'] }])
  assert.equal(result.rules.blockImportant.length, 1)
  assert.ok(JSON.stringify(result.rules.block).includes('"query_type":["A","AAAA"]'))
  assert.ok(JSON.stringify(result.rules.block).includes('"invert":true'))
})

test('filter configuration keeps exceptions global across lists and user allow above important', () => {
  const settings = { enabled: true, lists: [], allowDomains: [] }
  const artifact = { key: filterKey(settings), sets: [], allow: ['normal-exception'], allowImportant: ['important-exception'], userAllow: ['user'], blocks: [{ tag: 'ordinary', important: false }, { tag: 'important', important: true }] }
  const config = buildFilterConfig({ dns: { filter: settings } }, artifact)
  assert.deepEqual(config.rules[0].rules[0], { rule_set: ['important'] })
  assert.deepEqual(config.rules[0].rules[1].rule_set, ['user', 'important-exception'])
  assert.deepEqual(config.rules[1].rules[1].rule_set, ['user', 'important-exception', 'normal-exception'])
  assert.equal(config.rules[0].rcode, 'NXDOMAIN')
  assert.throws(() => buildFilterConfig({ dns: { filter: settings } }), /尚未准备/)
})

test('filter configuration validates IDs, URL schemes, duplicate lists and domain boundaries', () => {
  for (const change of [{ lists: [{ id: '../a', enabled: true, name: 'bad', url: 'https://example.com' }] }, { lists: [{ id: 'a', enabled: true, name: 'bad', url: 'file:///etc/passwd' }] }, { allowDomains: ['*example.com'] }, { enabled: 'yes' }]) {
    assert.ok(validateDnsFilter({ ...structuredClone(DNS_FILTER_DEFAULT), ...change }))
  }
  assert.ok(validateDnsFilter({ ...structuredClone(DNS_FILTER_DEFAULT), autoUpdate: { enabled: 'yes' } }))
  assert.ok(validateDnsFilter({ ...structuredClone(DNS_FILTER_DEFAULT), autoUpdate: { days: 0 } }))
})

test('big rule sets are chunked by entry count; each piece keeps the extra conditions; regex detection sees through logical rules', () => {
  assert.equal(DNS_FILTER_SET_ENTRIES, 25000)
  assert.deepEqual(chunkRules([]), [])
  const body = [...Array(7)].map((_, i) => `||s${i}.test^`).concat(['/^r[0-9]\\.test$/', '||a.test^$dnstype=A', '||b.test^$dnstype=A', '|exact.test^']).join('\n')
  const { rules } = parseDnsFilter(body)
  // 精确 1 条 + 后缀 7 条 + 正则 1 条在同一条规则里(9 条),两条 dnstype=A 在一条逻辑规则里
  const chunks = chunkRules(rules.block, 3)
  const entries = (rule) => (rule.type === 'logical' ? rule.rules[0] : rule)
  assert.deepEqual(chunks.map((c) => c.map((r) => Object.values(entries(r)).flat().length)), [[3], [3], [3], [2]])
  const first = chunks[0][0], last = chunks[2][0]
  assert.deepEqual(first, { domain: ['exact.test'], domain_suffix: ['s0.test', 's1.test'] })
  assert.deepEqual(last, { domain_suffix: ['s5.test', 's6.test'], domain_regex: ['^r[0-9]\\.test$'] })
  const typed = chunks[3][0]
  assert.equal(typed.type, 'logical')
  assert.deepEqual(typed.rules[1], { query_type: ['A'] })
  assert.deepEqual(chunkRules(rules.block, 100), [rules.block])
  // 小规则在前、大规则在后:大规则先把当前这份填满,不会留下一份只装几条的集合
  assert.deepEqual(chunkRules([{ domain: ['a.test'] }, { domain_suffix: ['b1', 'b2', 'b3', 'b4', 'b5'] }], 3), [[{ domain: ['a.test'] }, { domain_suffix: ['b1', 'b2'] }], [{ domain_suffix: ['b3', 'b4', 'b5'] }]])
  // 切出来的所有条目合起来和原来一样多
  const total = (list) => list.flat().reduce((n, r) => n + Object.values(entries(r)).flat().length, 0)
  assert.equal(total(chunks), total([rules.block]))
  assert.equal(ruleHasRegex(first), false)
  assert.equal(ruleHasRegex(last), true)
  assert.equal(ruleHasRegex({ type: 'logical', mode: 'and', rules: [{ domain_regex: ['x'] }, { query_type: ['A'] }] }), true)
})

test('content keys hash the text itself; filterKey on a string must not spread it into indexed keys', () => {
  assert.equal(contentKey('abc'), createHash('sha256').update('abc').digest('hex').slice(0, 16))
  assert.equal(filterKey('abc'), contentKey('abc'))
  assert.notEqual(filterKey('abc'), contentKey(JSON.stringify({ 0: 'a', 1: 'b', 2: 'c' })))
  const started = Date.now()
  filterKey('x'.repeat(2 * 1024 * 1024))
  assert.ok(Date.now() - started < 500, '2 MB 正文取键应当毫秒级')
  assert.equal(filterKey({ autoUpdate: { enabled: true }, lists: [] }), filterKey({ autoUpdate: { enabled: false }, lists: [] }))
})
