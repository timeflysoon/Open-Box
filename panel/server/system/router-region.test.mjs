import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createStore } from '../store/openbox-store.mjs'
import { createMockContext } from './context.mjs'
import { createRealContext } from './context-real.mjs'
import { createPaths } from './paths.mjs'
import { buildRuleSetIndex, loadRuleSetIndex } from './ruleset-index.mjs'
import { regionDnsError } from '../engine/dns-upstream.mjs'
import {
  EGRESS_COUNTRY_KEY, REGION_DETECT_KEY, applyDetectedRegion, detectEgressCountry, detectRouterRegion, fetchEgressIp, ipCountry, ipInChina, parseEgressIp,
  prepareDnsRegion, readEgressCountry, settleRegionBeforeDeploy, startEgressCountryDetect, startRegionDetect,
} from './router-region.mjs'

const paths = createPaths('/opt/open-box')
const memStore = () => {
  const m = new Map()
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}

test('prepareDnsRegion:还没有地区的档案先按中国大陆记下、直连 DNS 换成上游 DNS(备用照留)、记待判定;已经有地区的不动', () => {
  const store = memStore()
  store.setProfile({ dns: { direct: '223.5.5.5', directExtras: [{ server: '119.29.29.29' }], proxy: '8.8.8.8' } })
  assert.equal(prepareDnsRegion(store), true)
  const dns = store.getProfile().dns
  assert.equal(dns.region, 'cn')
  assert.equal(dns.direct, 'wan')
  assert.deepEqual(dns.directExtras, [{ server: '119.29.29.29' }])
  assert.equal(dns.proxy, '8.8.8.8', '代理侧不动')
  assert.equal(store.getRaw(REGION_DETECT_KEY), 'pending')
  // 第二次启动:地区已经有了,用户之后改的直连 DNS 不会再被换掉
  store.setProfile({ dns: { direct: '223.5.5.5' } })
  assert.equal(prepareDnsRegion(store), false)
  assert.equal(store.getProfile().dns.direct, '223.5.5.5')
})

test('parseEgressIp:取正文里第一个公网 IPv4;私网 / CGNAT / FakeIP 段不算', () => {
  assert.equal(parseEgressIp('39.129.157.217\n'), '39.129.157.217')
  assert.equal(parseEgressIp('Current IP Address: 131.117.188.66'), '131.117.188.66')
  for (const text of ['10.65.178.202', '100.64.1.2', '192.168.3.1', '172.20.0.1', '198.19.0.9', '<html>error</html>', '', null]) assert.equal(parseEgressIp(text), '', String(text))
})

test('fetchEgressIp:临时实例只有 direct 出站、Linux 上打内核出站标记,几家一起取,按顺序挑第一个合法的;临时配置用完删掉', async () => {
  const ctx = createMockContext({ files: { [paths.singbox]: 'bin' } })
  const answers = { 'https://ip.3322.net': { code: 1, stdout: '', stderr: 'timeout' }, 'https://ddns.oray.com/checkip': { code: 0, stdout: 'Current IP Address: 131.117.188.66', stderr: '' } }
  ctx.exec = async (cmd, args) => {
    ctx.calls.push({ cmd, args })
    return answers[args.at(-1)]
  }
  const ip = await fetchEgressIp({ ctx, paths, profile: { dns: { direct: 'wan' } }, systemDns: ['81.2.69.142'], platform: 'linux' })
  assert.equal(ip, '131.117.188.66')
  const written = ctx.writes.find((w) => /\/config\.region-probe-\d+\.json$/.test(w.path))
  const cfg = JSON.parse(written.content)
  assert.deepEqual(cfg.outbounds, [{ type: 'direct', tag: 'direct' }])
  assert.equal(cfg.route.default_mark, 0x2024)
  assert.deepEqual(cfg.dns.servers, [{ type: 'udp', tag: 'resolver', server: '81.2.69.142' }])
  assert.equal(ctx.calls.filter((c) => c.cmd === paths.singbox).length, 2)
  assert.equal(await ctx.exists(written.path), false)
  // 每次一个文件:后台判定和「恢复默认」同时跑时不互相覆盖
  await fetchEgressIp({ ctx, paths, profile: { dns: { direct: 'wan' } }, systemDns: [], platform: 'linux' })
  const paths2 = ctx.writes.filter((w) => /\/config\.region-probe-\d+\.json$/.test(w.path)).map((w) => w.path)
  assert.equal(new Set(paths2).size, 2)
  // 没装内核:取不了
  assert.equal(await fetchEgressIp({ ctx: createMockContext({ files: {} }), paths }), '')
})

test('detectRouterRegion:出口 IP 在 geoip-cn 里是中国大陆,不在是中国大陆之外;取不到 IP / 没有 geoip 数据判不出', async () => {
  const store = memStore()
  const base = { store, ctx: createMockContext({}), paths, systemDnsReader: async () => [] }
  const inChina = async ({ ip }) => ip.startsWith('39.')
  assert.deepEqual(await detectRouterRegion({ ...base, egressIp: async () => '39.129.157.217', inChina }), { region: 'cn', ip: '39.129.157.217' })
  assert.deepEqual(await detectRouterRegion({ ...base, egressIp: async () => '131.117.188.66', inChina }), { region: 'intl', ip: '131.117.188.66' })
  assert.deepEqual(await detectRouterRegion({ ...base, egressIp: async () => '', inChina }), { region: null, ip: '' })
  assert.deepEqual(await detectRouterRegion({ ...base, egressIp: async () => '131.117.188.66', inChina: async () => null }), { region: null, ip: '131.117.188.66' })
})

// 港澳台算「中国大陆之外」(用户 2026-10-02 把页签从「中国 / 中国之外」改成「中国大陆 / 中国大陆之外」:港澳没有 DNS 污染)。
// 判定靠随包的 geoip-cn,用真数据核一遍:香港 / 澳门 / 台湾的样本地址各自落在 geoip-hk / geoip-mo / geoip-tw 里
const SINGBOX = path.resolve(import.meta.dirname, '../../.tools/sing-box')
const GEOIP_CN = path.resolve(import.meta.dirname, '../resources/geodata/geoip-cn.srs')
test('ipInChina(真 geoip-cn):中国大陆的地址算中国大陆;香港 / 澳门 / 台湾 / 国外的算中国大陆之外', { skip: !(fs.existsSync(SINGBOX) && fs.existsSync(GEOIP_CN)) && 'no .tools/sing-box or geodata' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-region-'))
  try {
    const ctx = createRealContext()
    const realPaths = { dataDir, singbox: SINGBOX }
    const loadCnIndex = () => loadRuleSetIndex(ctx, realPaths, 'geoip-cn', GEOIP_CN)
    for (const ip of ['223.5.5.5', '114.114.114.114', '180.76.76.76']) {
      assert.equal(await ipInChina({ ctx, paths: realPaths, ip, loadCnIndex }), true, ip)
    }
    for (const ip of ['203.80.96.10', '218.102.23.228', '202.175.3.3', '168.95.1.1', '1.1.1.1']) {
      assert.equal(await ipInChina({ ctx, paths: realPaths, ip, loadCnIndex }), false, ip)
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('applyDetectedRegion:判成中国大陆之外时,代理 DNS 还是出厂那台(TCP 1.1.1.1:53、没有备用)的换成上游 DNS;改过的不动;清掉待判定', () => {
  const store = memStore()
  prepareDnsRegion(store)
  assert.deepEqual(applyDetectedRegion(store, 'intl'), { region: 'intl', proxy: 'wan', proxyProtocol: 'udp', proxyPort: 53 })
  assert.equal(store.getProfile().dns.proxy, 'wan')
  assert.equal(store.getRaw(REGION_DETECT_KEY), null)

  const custom = memStore()
  prepareDnsRegion(custom)
  custom.setProfile({ dns: { proxy: '8.8.8.8' } })
  assert.deepEqual(applyDetectedRegion(custom, 'intl'), { region: 'intl' })
  assert.equal(custom.getProfile().dns.proxy, '8.8.8.8')

  const cn = memStore()
  prepareDnsRegion(cn)
  assert.deepEqual(applyDetectedRegion(cn, 'cn'), {})
  assert.equal(cn.getProfile().dns.proxy, '1.1.1.1')
})

test('startRegionDetect:待判定才判;判不出隔一阵再试;判的时候用户切了地区就不落结果', async () => {
  const store = memStore()
  prepareDnsRegion(store)
  const results = [{ region: null, ip: '' }, { region: 'intl', ip: '131.117.188.66' }]
  const logs = []
  const job = startRegionDetect({ store, ctx: createMockContext({}), paths, delayMs: 60_000, retryDelaysMs: [60_000], detect: async () => results.shift(), log: (m) => logs.push(m) })
  assert.equal(await job.runNow(), null)
  assert.equal(store.getProfile().dns.region, 'cn')
  assert.equal(await job.runNow(), 'intl')
  assert.equal(store.getProfile().dns.region, 'intl')
  assert.equal(store.getRaw(REGION_DETECT_KEY), null)
  assert.ok(logs.some((m) => m.includes('中国大陆之外')), logs.join('\n'))
  job.stop()

  // 判到一半用户自己切了地区(PUT 清掉待判定):结果不落
  const other = memStore()
  prepareDnsRegion(other)
  const job2 = startRegionDetect({ store: other, ctx: createMockContext({}), paths, delayMs: 60_000, detect: async () => { other.delRaw(REGION_DETECT_KEY); return { region: 'intl', ip: '131.117.188.66' } } })
  assert.equal(await job2.runNow(), null)
  assert.equal(other.getProfile().dns.region, 'cn')
  job2.stop()

  // 已经判过(没有待判定):根本不判
  let called = false
  const job3 = startRegionDetect({ store, ctx: createMockContext({}), paths, delayMs: 60_000, detect: async () => { called = true; return { region: 'cn', ip: '' } } })
  assert.equal(await job3.runNow(), null)
  assert.equal(called, false)
  job3.stop()
})

test('startRegionDetect:默认 3 秒后第一次判,判不出按 30 秒、1 分钟、2 分钟、5 分钟、10 分钟、10 分钟再试(升级时撞上重启内核不用干等 10 分钟)', async () => {
  const { REGION_RETRY_DELAYS_MS } = await import('./router-region.mjs')
  assert.deepEqual([...REGION_RETRY_DELAYS_MS], [30_000, 60_000, 120_000, 300_000, 600_000, 600_000])
  const store = memStore()
  prepareDnsRegion(store)
  const delays = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return { unref() {} } }
  try {
    const job = startRegionDetect({ store, ctx: createMockContext({}), paths, detect: async () => ({ region: null, ip: '' }) })
    for (let i = 0; i < 8; i++) await job.runNow()
    job.stop()
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  assert.deepEqual(delays, [3_000, 30_000, 60_000, 120_000, 300_000, 600_000, 600_000], '7 次判不出之后不再排,等下次启动')
})

test('applyDetectedRegion:判成中国时代理侧不能留着上游 DNS——主上游换回 TCP 1.1.1.1,备用里的上游 DNS 去掉(在中国这个组合是不允许的)', () => {
  const store = memStore()
  store.setProfile({ dns: { region: 'intl', proxy: 'wan', proxyProtocol: 'udp', proxyExtras: [{ server: '8.8.8.8', protocol: 'tcp' }, { server: 'wan' }] } })
  store.setRaw(REGION_DETECT_KEY, 'pending')
  assert.deepEqual(applyDetectedRegion(store, 'cn'), { region: 'cn', proxy: '1.1.1.1', proxyProtocol: 'tcp', proxyPort: 53, proxyExtras: [{ server: '8.8.8.8', protocol: 'tcp' }] })
  const dns = store.getProfile().dns
  assert.equal(regionDnsError(dns), null)
})

test('fetchEgressIp:哪家先给出合法 IP 就用哪家,不等慢的那家;快的那家失败时等慢的', async () => {
  const run = async (answers) => {
    const ctx = createMockContext({ files: { [paths.singbox]: 'bin' } })
    ctx.exec = (cmd, args) => answers[args.at(-1)]()
    const t0 = Date.now()
    const ip = await fetchEgressIp({ ctx, paths, profile: { dns: { direct: 'wan' } }, systemDns: [], platform: 'linux' })
    return { ip, ms: Date.now() - t0 }
  }
  const later = (ms, r) => () => new Promise((resolve) => setTimeout(() => resolve(r), ms))
  const ok = (ip) => ({ code: 0, stdout: ip, stderr: '' })
  const fast = await run({ 'https://ip.3322.net': later(2000, ok('1.1.1.1')), 'https://ddns.oray.com/checkip': later(10, ok('Current IP Address: 104.194.206.3')) })
  assert.equal(fast.ip, '104.194.206.3')
  assert.ok(fast.ms < 1000, `不等慢的那家:${fast.ms}ms`)
  const fallback = await run({ 'https://ip.3322.net': later(50, ok('131.117.188.66')), 'https://ddns.oray.com/checkip': later(5, { code: 1, stdout: '', stderr: 'timeout' }) })
  assert.equal(fallback.ip, '131.117.188.66')
  const none = await run({ 'https://ip.3322.net': later(5, { code: 1, stdout: '', stderr: 'x' }), 'https://ddns.oray.com/checkip': later(5, ok('10.0.0.1')) })
  assert.equal(none.ip, '')
})

test('settleRegionBeforeDeploy:部署前地区还没判出就当场判一次并落下(配置直接按那个地区生成);已经判过 / 判不出返回 null', async () => {
  const store = memStore()
  store.setProfile({ dns: { direct: '223.5.5.5' } })
  const seen = []
  const r = await settleRegionBeforeDeploy({ store, ctx: createMockContext({}), paths, detect: async (deps) => { seen.push(deps.timeoutMs); return { region: 'intl', ip: '104.194.206.3' } } })
  assert.equal(r.region, 'intl')
  assert.deepEqual(seen, [8000])
  const dns = store.getProfile().dns
  assert.deepEqual({ region: dns.region, direct: dns.direct, proxy: dns.proxy }, { region: 'intl', direct: 'wan', proxy: 'wan' })
  assert.equal(store.getRaw(REGION_DETECT_KEY), null)
  // 已经判过:不再判
  assert.equal(await settleRegionBeforeDeploy({ store, ctx: createMockContext({}), paths, detect: async () => { throw new Error('不该判') } }), null)
  // 判不出:照常部署,待判定留给面板后台
  const other = memStore()
  assert.equal(await settleRegionBeforeDeploy({ store: other, ctx: createMockContext({}), paths, detect: async () => ({ region: null, ip: '' }) }), null)
  assert.equal(other.getRaw(REGION_DETECT_KEY), 'pending')
  assert.equal(other.getProfile().dns.region, 'cn')
})

test('ipCountry:只认两个字母的国家规则集;先查地区分流里的和常见的,命中就停;每查完一份就放掉', async () => {
  // 假规则集(真的区间表):每个国家一个网段;清单里没有的国家不查
  const ranges = { jp: '1.0.0.0/24', us: '8.8.8.0/24', de: '5.5.5.0/24', zz: '9.9.9.0/24' }
  const countries = async () => ['ad', 'de', 'jp', 'us', 'zz']
  const loaded = []
  const dropped = []
  const load = async (tag) => {
    loaded.push(tag)
    return buildRuleSetIndex({ version: 3, rules: [{ ip_cidr: [ranges[tag.replace('geoip-', '')] || '203.0.113.0/24'] }] })
  }
  const drop = (tags) => dropped.push(...tags)
  assert.equal(await ipCountry({ ctx: {}, paths, ip: '5.5.5.5', first: ['DE'], countries, load, drop }), 'DE')
  assert.deepEqual(loaded, ['geoip-de'], '地区分流里出现的先查,命中就停')
  assert.deepEqual(dropped, ['geoip-de'], '查完就放掉')
  loaded.length = 0
  assert.equal(await ipCountry({ ctx: {}, paths, ip: '9.9.9.9', countries, load, drop }), 'ZZ')
  assert.deepEqual(loaded, ['geoip-jp', 'geoip-us', 'geoip-de', 'geoip-ad', 'geoip-zz'], '常见的(只查随包里有的)先查,再按清单查剩下的')
  assert.equal(await ipCountry({ ctx: {}, paths, ip: '203.0.113.9', countries: async () => ['jp'], load: async () => null, drop }), '', '没有规则集数据判不出')
})

test('detectEgressCountry:按出口 IP 记下国家;出口 IP 没变就不再查规则集;取不到 IP / 查不出时回上次记下的', async () => {
  const store = memStore()
  let calls = 0
  const country = async ({ ip }) => { calls += 1; return ip === '8.8.8.8' ? 'US' : '' }
  const deps = { store, ctx: {}, paths, systemDnsReader: async () => [], country, now: () => 100 }
  assert.deepEqual(await detectEgressCountry({ ...deps, egressIp: async () => '8.8.8.8' }), { ip: '8.8.8.8', country: 'US', at: 100 })
  assert.deepEqual(readEgressCountry(store), { ip: '8.8.8.8', country: 'US', at: 100 })
  assert.deepEqual(await detectEgressCountry({ ...deps, egressIp: async () => '8.8.8.8', now: () => 200 }), { ip: '8.8.8.8', country: 'US', at: 200 })
  assert.equal(calls, 1, '同一个出口 IP 不再查')
  assert.deepEqual(await detectEgressCountry({ ...deps, egressIp: async () => '' }), { country: 'US', ip: '', at: 200 })
  assert.deepEqual(await detectEgressCountry({ ...deps, egressIp: async () => '1.2.3.4' }), { country: 'US', ip: '1.2.3.4', at: 200 })
  assert.equal(calls, 2)
  store.setRaw(EGRESS_COUNTRY_KEY, 'broken')
  assert.equal(readEgressCountry(store), null)
})

test('startEgressCountryDetect:没判过 / 超过一周才在后台判一次', async () => {
  const store = memStore()
  let runs = 0
  const detect = async () => { runs += 1; return { country: 'CN', ip: '1.1.1.1' } }
  const handle = startEgressCountryDetect({ store, ctx: {}, paths, delayMs: 5, detect, now: () => 1000 })
  assert.ok(handle)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(runs, 1)
  store.setRaw(EGRESS_COUNTRY_KEY, JSON.stringify({ ip: '1.1.1.1', country: 'CN', at: 1000 }))
  assert.equal(startEgressCountryDetect({ store, ctx: {}, paths, delayMs: 5, detect, now: () => 2000 }), null, '一周内判过就不判')
  assert.ok(startEgressCountryDetect({ store, ctx: {}, paths, delayMs: 1, detect, now: () => 1000 + 8 * 24 * 3600 * 1000 }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(runs, 2)
})

test('ipCountry(真 geoip):中国大陆 / 澳门 / 台湾 / 美国 / 日本的地址判得出国家', { skip: !(fs.existsSync(SINGBOX) && fs.existsSync(GEOIP_CN)) && 'no .tools/sing-box or geodata' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-country-'))
  try {
    const ctx = createRealContext()
    const geoDir = path.dirname(GEOIP_CN)
    const realPaths = { dataDir, singbox: SINGBOX, geoDir }
    const load = (tag) => loadRuleSetIndex(ctx, realPaths, tag, path.join(geoDir, `${tag}.srs`))
    for (const [ip, cc] of [['223.5.5.5', 'CN'], ['202.175.3.3', 'MO'], ['168.95.1.1', 'TW'], ['8.8.8.8', 'US'], ['210.130.1.1', 'JP']]) {
      assert.equal(await ipCountry({ ctx, paths: realPaths, ip, load }), cc, ip)
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

