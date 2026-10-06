import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { ensureRuleLists, fetchRuleList, listStatePath, refreshRuleList } from './rule-lists.mjs'
import { listTagForUrl } from '../engine/rule-list.mjs'

const paths = createPaths('/opt/open-box')
const URL_A = 'https://example.com/list/Check.list'
const TAG_A = listTagForUrl(URL_A)
const routing = (urls) => ({ policies: [{ id: 'p1', name: '测试', ruleUrls: urls, default: 'direct' }] })
const okFetch = (body) => async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => (typeof body === 'string' ? Buffer.from(body) : body),
})

test('第一次部署:拉回来、域名和 IP 各编成一份 .srs、记下时间和形状', async () => {
  const ctx = createMockContext({ files: { [paths.singbox]: 'x' } })
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), { fetchImpl: okFetch('DOMAIN-SUFFIX,a.com\n1.2.3.0/24\n'), now: () => 1000 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.updated, [TAG_A])
  const compiles = ctx.calls.filter((c) => c.args?.includes('compile'))
  assert.deepEqual(compiles.map((c) => c.args[3]), [`${paths.rulesetDir}/${TAG_A}.srs.new`, `${paths.rulesetDir}/${TAG_A}-ip.srs.new`])
  // 先编到 .new 再原子换上(#382:直接 --output 到内核正在监视的文件会被读到半截),临时文件不留
  for (const out of [`${paths.rulesetDir}/${TAG_A}.srs`, `${paths.rulesetDir}/${TAG_A}-ip.srs`]) {
    assert.ok(ctx.writes.some((w) => w.path === out && w.copiedFrom === `${out}.new`), out)
    assert.equal(`${out}.new` in ctx.files, false)
  }
  // 域名那份只有域名,IP 那份只有 IP:DNS 规则只能引用不含 IP 的规则集(见 engine/rule-list.mjs)
  const src = (name) => JSON.parse(ctx.writes.find((w) => w.path.endsWith(name)).content).rules
  assert.deepEqual(src(`${TAG_A}.json`), [{ domain_suffix: ['a.com'] }])
  assert.deepEqual(src(`${TAG_A}-ip.json`), [{ ip_cidr: ['1.2.3.0/24'] }])
  const state = JSON.parse(ctx.writes.find((w) => w.path === listStatePath(paths)).content)
  assert.equal(state[TAG_A].url, URL_A)
  assert.equal(state[TAG_A].split, 2)
  // 形状表给生成配置用:两份都有
  assert.deepEqual(r.lists, { [TAG_A]: { domain: true, ip: true } })
})

test('只有域名的名单不出 IP 那份,还要把上次留下的 -ip.srs 删掉;只有 IP 的名单反过来', async () => {
  const ctx = createMockContext({ files: { [paths.singbox]: 'x', [`${paths.rulesetDir}/${TAG_A}-ip.srs`]: 'stale' } })
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), { fetchImpl: okFetch('a.com\nb.com\n'), now: () => 1000 })
  assert.deepEqual(ctx.calls.filter((c) => c.args?.includes('compile')).map((c) => c.args[3]), [`${paths.rulesetDir}/${TAG_A}.srs.new`])
  assert.equal(await ctx.exists(`${paths.rulesetDir}/${TAG_A}-ip.srs`), false, '过期的 IP 那份要删')
  assert.deepEqual(r.lists, { [TAG_A]: { domain: true, ip: false } })

  const ctx2 = createMockContext({ files: { [paths.singbox]: 'x' } })
  const r2 = await ensureRuleLists(ctx2, paths, routing([URL_A]), { fetchImpl: okFetch('IP-CIDR,1.2.3.0/24\n10.0.0.1\n'), now: () => 1000 })
  assert.deepEqual(ctx2.calls.filter((c) => c.args?.includes('compile')).map((c) => c.args[3]), [`${paths.rulesetDir}/${TAG_A}-ip.srs.new`])
  assert.deepEqual(r2.lists, { [TAG_A]: { domain: false, ip: true } })
})

test('没到重下时间、文件还在:不再拉', async () => {
  const ctx = createMockContext({
    files: {
      [paths.singbox]: 'x',
      [`${paths.rulesetDir}/${TAG_A}.srs`]: 'bin',
      [listStatePath(paths)]: JSON.stringify({ [TAG_A]: { url: URL_A, at: 1000, split: 2, counts: { domain_suffix: 3 } } }),
    },
  })
  let fetched = 0
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), {
    fetchImpl: async () => { fetched += 1; return okFetch('a.com')() },
    now: () => 1000 + 3600_000,
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.updated, [])
  assert.equal(fetched, 0)
  // 形状从状态里读出来,不用重新拉
  assert.deepEqual(r.lists, { [TAG_A]: { domain: true, ip: false } })
})

// 老版式 = 域名 IP 混在一份 list-xxx.srs 里、状态里没有 split 标记(升级前的版本编出来的)
const legacyState = () => JSON.stringify({ [TAG_A]: { url: URL_A, at: 1000, counts: { domain_suffix: 1, ip_cidr: 1 } } })
// mock 的 exec 不会真的产出文件:把「decompile 解出来的源文件」预先放好,模拟内核写了它
const decompiled = { [`${paths.dataDir}/tmp/${TAG_A}.legacy.json`]: JSON.stringify({ version: 3, rules: [{ domain_suffix: 'a.com', ip_cidr: ['1.2.3.0/24'] }] }) }

test('本地是老版式、名单没到重下时间:用内核解开旧文件离线拆成两份,不碰网络', async () => {
  const ctx = createMockContext({ files: { [paths.singbox]: 'x', [`${paths.rulesetDir}/${TAG_A}.srs`]: 'bin', [listStatePath(paths)]: legacyState(), ...decompiled } })
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), {
    fetchImpl: async () => { throw new Error('不该碰网络') },
    now: () => 1000 + 3600_000,
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.updated, [TAG_A])
  const cmds = ctx.calls.filter((c) => c.cmd === paths.singbox).map((c) => `${c.args[1]} ${c.args[3]}`)
  assert.deepEqual(cmds, [
    `decompile ${paths.dataDir}/tmp/${TAG_A}.legacy.json`,
    `compile ${paths.rulesetDir}/${TAG_A}.srs.new`,
    `compile ${paths.rulesetDir}/${TAG_A}-ip.srs.new`,
  ])
  assert.deepEqual(r.lists, { [TAG_A]: { domain: true, ip: true } })
  const state = JSON.parse(ctx.writes.find((w) => w.path === listStatePath(paths)).content)
  assert.equal(state[TAG_A].split, 2)
  assert.equal(state[TAG_A].at, 1000, '离线重编不算重下,时间戳不动')
})

test('老版式又解不开（比如文件坏了）:改为重新拉取', async () => {
  const ctx = createMockContext({ files: { [paths.singbox]: 'x', [`${paths.rulesetDir}/${TAG_A}.srs`]: 'bin', [listStatePath(paths)]: legacyState() } })
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), { fetchImpl: okFetch('a.com\n'), now: () => 1000 + 3600_000 })
  assert.deepEqual(r.updated, [TAG_A])
  assert.deepEqual(r.lists, { [TAG_A]: { domain: true, ip: false } })
})

test('老版式、拉不动但本地有旧的:沿用之余也离线拆一下,形状表就有了', async () => {
  const ctx = createMockContext({ files: { [paths.singbox]: 'x', [`${paths.rulesetDir}/${TAG_A}.srs`]: 'bin', [listStatePath(paths)]: legacyState(), ...decompiled } })
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), {
    fetchImpl: async () => ({ ok: false, status: 502 }),
    now: () => 1000 + 3 * 86400_000,
  })
  assert.equal(r.ok, true)
  assert.equal(r.failed[0].tag, TAG_A)
  assert.deepEqual(r.lists, { [TAG_A]: { domain: true, ip: true } })
})

test('拉不动:本地有旧的就沿用,没有就让部署停下来', async () => {
  const withOld = createMockContext({
    files: { [paths.singbox]: 'x', [`${paths.rulesetDir}/${TAG_A}.srs`]: 'bin' },
  })
  const r1 = await ensureRuleLists(withOld, paths, routing([URL_A]), { fetchImpl: async () => ({ ok: false, status: 502 }) })
  assert.equal(r1.ok, true)
  assert.equal(r1.failed[0].tag, TAG_A)

  const fresh = createMockContext({ files: { [paths.singbox]: 'x' } })
  const r2 = await ensureRuleLists(fresh, paths, routing([URL_A]), { fetchImpl: async () => ({ ok: false, status: 502 }) })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /规则集链接拉取失败/)
})

test('名单里一条都解析不出来:当作失败,别编出一个空规则集', async () => {
  const ctx = createMockContext({ files: { [paths.singbox]: 'x' } })
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), { fetchImpl: okFetch('# 只有注释\n') })
  assert.equal(r.ok, false)
  assert.match(r.message, /没有解析出/)
})

test('没有引用任何链接时什么都不做', async () => {
  const ctx = createMockContext({})
  const r = await ensureRuleLists(ctx, paths, routing([]), { fetchImpl: async () => { throw new Error('不该被调用') } })
  assert.deepEqual(r, { ok: true, updated: [], failed: [], lists: {} })
})

test('链接指向 .mrs:自己解开 zstd,编出来的和文本名单走同一条路', async () => {
  const mrs = readFileSync(new URL('../engine/fixtures/geosite-tesla.mrs', import.meta.url))
  const ctx = createMockContext({ files: { [paths.singbox]: 'x' } })
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), { fetchImpl: okFetch(mrs), now: () => 1000 })
  assert.equal(r.ok, true)
  const src = JSON.parse(ctx.writes.find((w) => w.path.endsWith(`${TAG_A}.json`)).content)
  assert.equal(src.rules[0].domain_suffix.length, 11)
  assert.ok(src.rules[0].domain_suffix.includes('tesla.com'))
  // 还是那一句 rule-set compile,内核那边完全不知道来源是 .mrs;纯域名的 .mrs 不出 IP 那份
  assert.deepEqual(ctx.calls.filter((c) => c.args?.includes('compile')).map((c) => c.args[3]), [`${paths.rulesetDir}/${TAG_A}.srs.new`])
  assert.deepEqual(r.lists, { [TAG_A]: { domain: true, ip: false } })
})

// GitHub #217:链接指向 sing-box 编好的 .srs(one-geoip 的 one-china.srs 那种)。JS 不自己解,写成临时文件让内核
// rule-set decompile 出源格式,再按同一套拆成域名 / IP 两份重编。只有 IP 的名单不出域名那份
test('链接指向 .srs:交给内核解开,再拆成域名 / IP 两份重编;临时文件用完删掉', async () => {
  const srs = Buffer.concat([Buffer.from('SRS\x03', 'latin1'), Buffer.from('binary-payload')])
  const decompiled = { [`${paths.dataDir}/tmp/${TAG_A}.srs.json`]: JSON.stringify({ version: 3, rules: [{ ip_cidr: ['1.0.1.0/24', '1.0.2.0/23'] }, { domain_suffix: 'cn' }] }) }
  const ctx = createMockContext({ files: { [paths.singbox]: 'x', ...decompiled } })
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), { fetchImpl: okFetch(srs), now: () => 1000 })
  assert.equal(r.ok, true, r.message)
  const cmds = ctx.calls.filter((c) => c.cmd === paths.singbox).map((c) => `${c.args[1]} ${c.args[3]}`)
  assert.deepEqual(cmds, [
    `decompile ${paths.dataDir}/tmp/${TAG_A}.srs.json`,
    `compile ${paths.rulesetDir}/${TAG_A}.srs.new`,
    `compile ${paths.rulesetDir}/${TAG_A}-ip.srs.new`,
  ])
  const ipSrc = JSON.parse(ctx.writes.find((w) => w.path.endsWith(`${TAG_A}-ip.json`)).content)
  assert.deepEqual(ipSrc.rules[0].ip_cidr, ['1.0.1.0/24', '1.0.2.0/23'])
  assert.deepEqual(r.lists, { [TAG_A]: { domain: true, ip: true } })
  assert.equal(ctx.files[`${paths.dataDir}/tmp/${TAG_A}.srs`], undefined, '临时 .srs 用完删掉')
  assert.equal(ctx.files[`${paths.dataDir}/tmp/${TAG_A}.srs.json`], undefined, '解出来的 JSON 也删掉')
  // 内核解不开:整条失败(本地没有旧的就让部署停下来)
  const bad = createMockContext({ files: { [paths.singbox]: 'x' }, defaultExec: { code: 1, stdout: '', stderr: 'invalid rule-set' } })
  const r2 = await ensureRuleLists(bad, paths, routing([URL_A]), { fetchImpl: okFetch(srs), now: () => 1000 })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /解不开/)
})

// 审查第 4 项:超时和 8MB 上限要管到响应体读完为止
const streamOf = ({ chunk, count, hang = false }) => new ReadableStream({
  sent: 0,
  pull(controller) {
    if (this.sent >= count) {
      if (hang) return new Promise(() => {})   // 头回了、正文一直不结束
      controller.close()
      return undefined
    }
    this.sent++
    controller.enqueue(new Uint8Array(chunk))
    return undefined
  },
})

test('fetchRuleList:响应体流式累计,超过上限立刻断开,不把整份读进内存', async () => {
  let pulled = 0
  const body = new ReadableStream({
    pull(controller) {
      pulled++
      if (pulled > 12) { controller.close(); return }
      controller.enqueue(new Uint8Array(1024 * 1024))   // 每块 1MB,共 12MB
    },
  })
  const fetchImpl = async () => new Response(body, { status: 200 })
  await assert.rejects(() => fetchRuleList(fetchImpl, 'https://example.com/list.txt'), /名单太大/)
  assert.ok(pulled <= 10, `越限后不该继续读,实际读了 ${pulled} 块`)
})

test('fetchRuleList:Content-Length 声明超限直接拒,一个字节都不读', async () => {
  let pulled = 0
  const body = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(16)); controller.close() } })
  const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-length': String(9 * 1024 * 1024) } })
  await assert.rejects(() => fetchRuleList(fetchImpl, 'https://example.com/list.txt'), /名单太大/)
  // ReadableStream 自己会预拉一块填队列(highWaterMark 1),那不是我们读的;再多就是真去读了
  assert.ok(pulled <= 1, `声明超限就不该读正文,实际拉了 ${pulled} 块`)
})

test('fetchRuleList:响应头到了但正文一直不结束 → 总超时照样生效,不再无限等', async () => {
  const fetchImpl = async () => new Response(streamOf({ chunk: 8, count: 2, hang: true }), { status: 200 })
  const t0 = Date.now()
  await assert.rejects(() => fetchRuleList(fetchImpl, 'https://example.com/list.txt', { timeoutMs: 120 }), /下载超时/)
  assert.ok(Date.now() - t0 < 2000)
})

test('fetchRuleList:正常大小的流式响应照常读完;没有流的响应（旧桩）走一次性读', async () => {
  const fetchImpl = async () => new Response(streamOf({ chunk: 3, count: 4 }), { status: 200 })
  const buf = await fetchRuleList(fetchImpl, 'https://example.com/list.txt')
  assert.equal(buf.length, 12)
  const plain = await fetchRuleList(async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('DOMAIN-SUFFIX,a.com\n') }), 'https://example.com/list.txt')
  assert.equal(plain.toString(), 'DOMAIN-SUFFIX,a.com\n')
})

test('立即更新(#155):没到重下时间也重拉重编、时间记成现在;构成没变不用重启,多出 IP 那一份才要;拉不动本地那份原样留着', async () => {
  const files = () => ({
    [paths.singbox]: 'x',
    [`${paths.rulesetDir}/${TAG_A}.srs`]: 'old',
    [listStatePath(paths)]: JSON.stringify({ [TAG_A]: { url: URL_A, at: 1000, split: 2, counts: { domain_suffix: 1 } }, other: { url: 'https://b.test/x', at: 5 } }),
  })
  // 部署那条路这时候是不拉的
  let fetched = 0
  const counting = (body) => async () => { fetched += 1; return okFetch(body)() }
  await ensureRuleLists(createMockContext({ files: files() }), paths, routing([URL_A]), { fetchImpl: counting('a.com'), now: () => 2000 })
  assert.equal(fetched, 0)
  const ctx = createMockContext({ files: files() })

  const r = await refreshRuleList(ctx, paths, URL_A, { fetchImpl: counting('DOMAIN-SUFFIX,a.com\nDOMAIN-SUFFIX,abcd.com\n'), now: () => 3000 })
  assert.equal(fetched, 1)
  assert.equal(r.tag, TAG_A)
  assert.deepEqual(r.tags, [TAG_A, `${TAG_A}-ip`])
  assert.equal(r.total, 2)
  assert.equal(r.shapeChanged, false)
  const state = () => JSON.parse(ctx.writes.filter((w) => w.path === listStatePath(paths)).at(-1).content)
  assert.equal(state()[TAG_A].at, 3000)
  assert.deepEqual(state()[TAG_A].counts, { domain_suffix: 2 })
  assert.deepEqual(state().other, { url: 'https://b.test/x', at: 5 }, '别的名单的状态不动')
  assert.deepEqual(ctx.calls.filter((c) => c.args?.includes('compile')).map((c) => c.args[3]), [`${paths.rulesetDir}/${TAG_A}.srs.new`])

  // 名单里多了 IP:配置里要多引用一份 -ip.srs,得重启内核
  const grown = await refreshRuleList(ctx, paths, URL_A, { fetchImpl: okFetch('a.com\n1.2.3.0/24\n'), now: () => 4000 })
  assert.equal(grown.shapeChanged, true)

  // 拉不动:抛出去,状态和文件都不动
  const before = state()
  await assert.rejects(refreshRuleList(ctx, paths, URL_A, { fetchImpl: async () => { throw new Error('ECONNRESET') }, now: () => 5000 }))
  assert.deepEqual(state(), before)

  // 还没部署过的链接:第一次编出来不算「构成变了」
  const fresh = createMockContext({ files: { [paths.singbox]: 'x' } })
  assert.equal((await refreshRuleList(fresh, paths, URL_A, { fetchImpl: okFetch('a.com\n1.2.3.0/24\n') })).shapeChanged, false)
})

// 地区分流(给手机用的)里的规则集链接:部署时和站点集的一起编,拉不到不让部署失败;单独补的时候站点集那些条目原样留着
const URL_B = 'https://example.com/list/region.list'
const TAG_B = listTagForUrl(URL_B)
test('extra 里 optional 的链接拉不到、本地也没有:记进 failed,部署照常;站点集的照编', async () => {
  const ctx = createMockContext({ files: { [paths.singbox]: 'x' } })
  const fetchImpl = async (url) => (String(url) === URL_B ? { ok: false, status: 502 } : okFetch('a.com\n')())
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), { fetchImpl, now: () => 1000, extra: [{ url: URL_B, tag: TAG_B, optional: true }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.updated, [TAG_A])
  assert.deepEqual(r.failed.map((f) => f.tag), [TAG_B])
  const state = JSON.parse(ctx.writes.find((w) => w.path === listStatePath(paths)).content)
  assert.deepEqual(Object.keys(state), [TAG_A])
})

test('同一个链接站点集也引用:按站点集的算(拉不到又没有旧的,部署照样停下)', async () => {
  const ctx = createMockContext({ files: { [paths.singbox]: 'x' } })
  const r = await ensureRuleLists(ctx, paths, routing([URL_A]), {
    fetchImpl: async () => ({ ok: false, status: 502 }),
    extra: [{ url: URL_A, tag: TAG_A, optional: true }],
  })
  assert.equal(r.ok, false)
})

test('keepOthers:只补地区分流那几条,状态里站点集的条目原样留着;什么都没变就不写状态文件', async () => {
  const kept = { [TAG_A]: { url: URL_A, at: 1000, split: 2, counts: { domain_suffix: 3 } } }
  const ctx = createMockContext({ files: { [paths.singbox]: 'x', [listStatePath(paths)]: JSON.stringify(kept) } })
  const r = await ensureRuleLists(ctx, paths, null, { fetchImpl: okFetch('b.com\n'), now: () => 2000, extra: [{ url: URL_B, tag: TAG_B, optional: true }], keepOthers: true })
  assert.deepEqual(r.updated, [TAG_B])
  const state = JSON.parse(ctx.writes.find((w) => w.path === listStatePath(paths)).content)
  assert.deepEqual(Object.keys(state).sort(), [TAG_A, TAG_B].sort())
  assert.deepEqual(state[TAG_A], kept[TAG_A])

  // 再来一次:没到 24 小时、文件都在 → 不拉、不写
  const writesBefore = ctx.writes.length
  const again = await ensureRuleLists(ctx, paths, null, { fetchImpl: async () => { throw new Error('不该拉') }, now: () => 3000, extra: [{ url: URL_B, tag: TAG_B, optional: true }], keepOthers: true })
  assert.deepEqual(again.updated, [])
  assert.equal(ctx.writes.length, writesBefore, '状态没变,不写闪存')
})
