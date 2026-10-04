import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRuleSetIndex, clearRuleSetIndexCache, ipIndexHas, loadRuleSetIndex, matchDomain, matchedDomainEntries, matchedIpEntries, sweepExpired, toJsRegex } from './ruleset-index.mjs'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'

const paths = createPaths('/opt/open-box')

test('IP 区间:v4 / v6 合并后二分查找,边界含两端;命中的原始网段列得出来', () => {
  const { ip } = buildRuleSetIndex({ version: 3, rules: [{ ip_cidr: ['104.16.0.0/13', '104.24.0.0/14', '1.1.1.0/24', '2606:4700::/32'] }, { ip_cidr: '172.64.0.0/13' }] })
  assert.equal(ip.v4.starts.length, 3, '104.16/13 和 104.24/14 相邻,合并成一段')
  for (const a of ['104.16.0.0', '104.21.9.27', '104.27.255.255', '1.1.1.1', '172.67.141.46', '2606:4700::1111']) assert.equal(ipIndexHas(ip, a), true, a)
  for (const a of ['104.15.255.255', '104.28.0.0', '1.1.2.1', '8.8.8.8', '2606:4701::1', 'not-an-ip']) assert.equal(ipIndexHas(ip, a), false, a)
  assert.deepEqual(matchedIpEntries(ip, '104.21.9.27'), [{ type: 'ip_cidr', value: '104.16.0.0/13' }])
  assert.deepEqual(matchedIpEntries(ip, '2606:4700::1111'), [{ type: 'ip_cidr', value: '2606:4700::/32' }])
})

// 下面这组期望值是对着 sing-box 1.14.0 的 `rule-set match` 实测出来的(同一份条目编成 .srs 逐个域名问内核)
test('域名匹配语义和内核一致:全等 / 后缀按标签边界 / 点开头只认子域 / 关键词子串 / 正则 / 不分大小写', () => {
  const { domain } = buildRuleSetIndex({ version: 3, rules: [{ domain: ['exact.example'], domain_suffix: ['plain.example', '.dot.example'], domain_keyword: ['kw-token'], domain_regex: ['^re[0-9]+\\.example$'] }] })
  const expected = {
    'exact.example': 'hit', 'a.exact.example': 'miss',
    'plain.example': 'hit', 'a.plain.example': 'hit', 'notplain.example': 'miss',
    'dot.example': 'miss', 'a.dot.example': 'hit',
    'xkw-tokenx.com': 'hit',
    're12.example': 'hit', 'are12.example': 'miss', 'RE12.example': 'hit',
  }
  for (const [host, want] of Object.entries(expected)) assert.equal(matchDomain(domain, host), want, host)
  assert.deepEqual(matchedDomainEntries(domain, 'a.plain.example'), [{ type: 'domain_suffix', value: 'plain.example' }])
  assert.deepEqual(matchedDomainEntries(domain, 'a.dot.example'), [{ type: 'domain_suffix', value: '.dot.example' }])
  assert.deepEqual(matchedDomainEntries(domain, 're12.example'), [{ type: 'domain_regex', value: '^re[0-9]+\\.example$' }])
})

test('toJsRegex:开头的 (?i)、(?P<name>…)、\\z 能换;别的内联标志 / POSIX 类 / \\p{…} 编不了返回 null', () => {
  assert.equal(toJsRegex('(?i)^ABC\\.example$').test('abc.example'), true)
  assert.equal(toJsRegex('^(?P<sub>[a-z]+)\\.example\\z').test('www.example'), true)
  for (const bad of ['(?s).*', 'a(?i:b)c', '[[:alpha:]]+', '\\p{Han}+', '(unclosed']) assert.equal(toJsRegex(bad), null, bad)
})

test('有 JS 编不了的正则:命中别的条目照样算命中,都没命中时报 unknown(交回内核),不冒充不命中', () => {
  const { domain } = buildRuleSetIndex({ rules: [{ domain_suffix: ['ok.example'], domain_regex: ['[[:alpha:]]+\\.weird$'] }] })
  assert.equal(domain.regexUnknown, true)
  assert.equal(matchDomain(domain, 'a.ok.example'), 'hit')
  assert.equal(matchDomain(domain, 'other.example'), 'unknown')
})

test('形状:逻辑 / 取反 / 带端口等附加条件的集合不支持(null);域名条目多过上限时只留 IP 那一半', () => {
  assert.equal(buildRuleSetIndex({ rules: [{ type: 'logical', mode: 'and', rules: [] }] }), null)
  assert.equal(buildRuleSetIndex({ rules: [{ ip_cidr: ['10.0.0.0/8'], invert: true }] }), null)
  assert.equal(buildRuleSetIndex({ rules: [{ domain_suffix: ['a.com'], port: [443] }] }), null)
  const big = buildRuleSetIndex({ rules: [{ domain_suffix: ['a.com', 'b.com', 'c.com'], ip_cidr: ['10.0.0.0/8'] }] }, { maxDomainEntries: 2 })
  assert.equal(big.domain, null)
  assert.equal(ipIndexHas(big.ip, '10.1.2.3'), true)
  assert.equal(matchDomain(big.domain, 'a.com'), 'unknown')
})

test('loadRuleSetIndex:解码一次后走缓存,不再起内核进程;过期才重新解码;解不开 / 文件不在返回 null', async () => {
  clearRuleSetIndexCache()
  const srs = '/opt/open-box/panel/server/resources/geodata/geoip-x.srs'
  const jsonPath = `${paths.dataDir}/tmp/geoip-x.index.json`
  const ctx = createMockContext({ files: { [paths.singbox]: 'binary', [srs]: 'srs' } })
  const files = ctx.files
  // mock 的 exec 不会真写文件:每次解码前把"内核写出来的 JSON"放好(读完会删)
  const put = () => { files[jsonPath] = JSON.stringify({ version: 3, rules: [{ ip_cidr: ['198.51.100.0/24'], domain_suffix: ['x.example'] }] }) }
  const t = 1_000_000
  put()
  const a = await loadRuleSetIndex(ctx, paths, 'geoip-x', srs, { now: () => t })
  assert.equal(ipIndexHas(a.ip, '198.51.100.7'), true)
  assert.equal(matchDomain(a.domain, 'www.x.example'), 'hit')
  assert.equal(ctx.calls.length, 1)
  assert.equal(jsonPath in files, false, '临时文件读完就删')
  await loadRuleSetIndex(ctx, paths, 'geoip-x', srs, { now: () => t + 60_000 })
  assert.equal(ctx.calls.length, 1, '缓存期内不再解码')
  put()
  await loadRuleSetIndex(ctx, paths, 'geoip-x', srs, { now: () => t + 11 * 60_000 })
  assert.equal(ctx.calls.length, 2, '过期后重新解码')
  clearRuleSetIndexCache()
  assert.equal(await loadRuleSetIndex(ctx, paths, 'geoip-x', srs, { now: () => t }), null, '内核没写出 JSON → null,调用方退回内核判')
  const before = ctx.calls.length
  assert.equal(await loadRuleSetIndex(ctx, paths, 'geoip-y', '/nope.srs', { now: () => t }), null)
  assert.equal(ctx.calls.length, before, '文件不在就不起进程')
})

test('过期的索引会被清掉,不等下次访问(查过一次就没人再用的集合不一直占内存)', async () => {
  clearRuleSetIndexCache()
  const srs = '/opt/open-box/panel/server/resources/geodata/geoip-z.srs'
  const ctx = createMockContext({ files: { [paths.singbox]: 'binary', [srs]: 'srs', [`${paths.dataDir}/tmp/geoip-z.index.json`]: JSON.stringify({ rules: [{ ip_cidr: ['203.0.113.0/24'] }] }) } })
  const t = 5_000_000
  await loadRuleSetIndex(ctx, paths, 'geoip-z', srs, { now: () => t })
  assert.equal(sweepExpired(t + 9 * 60_000), 1, '没到期,留着')
  assert.equal(sweepExpired(t + 10 * 60_000), 0, '到期清掉')
  clearRuleSetIndexCache()
})

