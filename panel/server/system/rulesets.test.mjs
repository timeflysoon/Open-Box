import assert from 'node:assert/strict'
import test from 'node:test'
import { compileRuleSetAtomic, ensureRulesets, rulesetKind, rulesetPath } from './rulesets.mjs'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'

const paths = createPaths('/opt/open-box')
const configWith = tags => ({ route: { rule_set: tags.map(tag => ({ type: 'local', tag, path: `${paths.rulesetDir}/${tag}.srs` })) } })

test('Geo 使用随包路径，自定义名单仍使用可写目录，拒绝路径穿越', () => {
  for (const tag of ['geosite-cn', 'geoip-cn', 'geosite-geolocation-!cn', 'geosite-google@cn']) {
    assert.ok(rulesetKind(tag))
    assert.equal(rulesetPath(paths, tag), `${paths.geoDir}/${tag}.srs`)
  }
  assert.equal(rulesetKind('list-test'), null)
  assert.equal(rulesetPath(paths, 'list-test'), `${paths.rulesetDir}/list-test.srs`)
  for (const tag of ['geosite-../../etc/passwd', 'geoip-', 'geosite-/etc', 'dns-filter-bad']) assert.equal(rulesetKind(tag), null)
  assert.throws(() => rulesetPath(paths, '../a'))
})

test('全新安装和旧来源迁移均直接使用随包 Geo，不下载、不写文件', async () => {
  for (const marker of ['', 'sagernet', 'metacubex']) {
    const ctx = createMockContext({ files: {
      [`${paths.geoDir}/geosite-cn.srs`]: Buffer.from('SRS-new'),
      [`${paths.geoDir}/geoip-cn.srs`]: Buffer.from('SRS-ip'),
      [`${paths.rulesetDir}/geosite-cn.srs`]: Buffer.from('stale'),
      [`${paths.rulesetDir}/.source`]: marker,
    } })
    const config = configWith(['geosite-cn', 'geoip-cn'])
    assert.equal((await ensureRulesets(ctx, config, { paths })).ok, true)
    assert.ok(config.route.rule_set.every(e => e.path.startsWith(paths.geoDir + '/')))
    assert.equal(ctx.writes.length, 0)
  }
})

test('DNS 过滤和自定义名单本地产物不被当作 Geo，也不改其路径', async () => {
  const tags = ['dns-filter-allow-26efdcf0c0739bae', 'dns-filter-allowImportant-0123456789abcdef',
    'dns-filter-user-allow-0123456789abcdef', 'dns-filter-anti-ad-block-0123456789abcdef',
    'dns-filter-anti-ad-important-0123456789abcdef', 'list-0123456789abcdef']
  const config = configWith(tags.slice(0, -1))
  const before = structuredClone(config)
  const ctx = createMockContext()
  assert.equal((await ensureRulesets(ctx, config)).ok, true)
  assert.deepEqual(config, before)
  assert.equal(ctx.writes.length, 0)
})

test('缺少随包文件时拒绝使用旧缓存，错误标签也不能静默放过', async () => {
  const ctx = createMockContext({ files: { [`${paths.rulesetDir}/geosite-cn.srs`]: 'old' } })
  const missing = await ensureRulesets(ctx, configWith(['geosite-cn']))
  assert.equal(missing.ok, false)
  assert.match(missing.message, /安装包缺少规则集 geosite-cn/)
  for (const tag of ['dns-filter-not-a-compiled-tag', 'geosite-../../etc/passwd', 'whatever']) {
    assert.equal((await ensureRulesets(ctx, configWith([tag]))).ok, false)
  }
  assert.equal(ctx.writes.length, 0)
})

// #382:内核对本地规则集边监视边重载,直接 compile --output 到正在用的文件会被读到半截。先编到 .new,成功才原子换上
test('compileRuleSetAtomic:先编到 .new、成功才换上并删临时文件;编不过目标文件原样不动', async () => {
  const out = `${paths.rulesetDir}/obflip-byp-geoip-cn.srs`
  const ctx = createMockContext({ files: { [out]: 'old', '/tmp/src.json': '{}' } })
  const r = await compileRuleSetAtomic(ctx, paths.singbox, '/tmp/src.json', out)
  assert.equal(r.code, 0)
  assert.deepEqual(ctx.calls.map((c) => c.args), [['rule-set', 'compile', '--output', `${out}.new`, '/tmp/src.json']])
  assert.equal(ctx.files[out], 'compiled:/tmp/src.json')
  assert.ok(ctx.writes.some((w) => w.path === out && w.copiedFrom === `${out}.new`))
  assert.equal(`${out}.new` in ctx.files, false)

  const bad = createMockContext({
    files: { [out]: 'old', '/tmp/src.json': '{}' },
    execResults: { [`${paths.singbox} rule-set compile --output ${out}.new /tmp/src.json`]: { code: 1, stderr: 'bad cidr' } },
  })
  const failed = await compileRuleSetAtomic(bad, paths.singbox, '/tmp/src.json', out)
  assert.equal(failed.code, 1)
  assert.equal(bad.files[out], 'old')
  assert.equal(`${out}.new` in bad.files, false)
})
