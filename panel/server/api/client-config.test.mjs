import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createStore } from '../store/openbox-store.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { parseSubscription } from '../engine/subscription.mjs'
import { FLIP_FALLBACK_TAG, flipFlagContent } from '../engine/flip.mjs'
import { buildCurrentConfig } from './deploy-runner.mjs'
import { routerId } from './client-app.mjs'
import { CLIENT_DEVICES_KEY, buildClientBundle, registerClientConfigRoutes, registerPublicClientConfigRoutes } from './client-config.mjs'
import { routeProxyDnsUpstreams } from './dns-upstream-route.mjs'

const sbBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.tools/sing-box')
const hasBin = fs.existsSync(sbBin)

const memStore = () => {
  const m = new Map()
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}

// 路由器上开着一堆手机用不上的东西:dnsmasq 转发、直连上游是局域网地址、DNS 重写、auto_redirect、终端分流、共享网络、IPv6
const seeded = () => {
  const store = memStore()
  const node = parseSubscription('ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@hk.example.com:8388#香港01').nodes[0]
  store.setSubscriptions([{ id: 'sub', name: '机场', url: 'https://sub.example/x' }])
  store.setNodes([{ ...node, subscriptionId: 'sub', tag: '香港-01' }])
  store.setGroups([{ id: 'grp', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }])
  store.setProfile({
    rejectQuic: true,
    ipv6: true,
    dns: {
      split: true, mode: 'dnsmasq', fakeIpForProxy: true, direct: '192.168.3.1',
      rewrite: { enabled: true, initialized: 1, rules: [{ id: 'r1', enabled: true, source: 'nas.test', addresses: ['192.168.3.9'] }] },
    },
    tun: { autoRedirect: true },
    clientRoutes: [{ id: 'c1', name: '电视', sources: ['10.0.0.9'], outbound: 'direct' }],
    servers: [{ id: 's1', enabled: true, name: '家里', protocol: 'shadowsocks', port: 8388, method: 'aes-256-gcm', password: 'x', address: 'home.example.com' }],
    routing: {
      fallbackDefault: '香港-自动',
      policies: [
        { id: 'cn', name: '国内', default: 'direct', rulesets: ['geosite-cn', 'geoip-cn'] },
        { id: 'ai', name: 'AI', default: '香港-自动', domainSuffix: ['openai.com'] },
      ],
    },
  })
  return store
}

// 随包 geodata 的替身:有内核就真编,没有就写个 SRS 头(只用来算摘要)
const makeGeoDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-client-geo-'))
  for (const tag of ['geosite-cn', 'geoip-cn']) {
    const out = path.join(dir, `${tag}.srs`)
    if (hasBin) {
      const src = path.join(dir, `${tag}.json`)
      const rule = tag.startsWith('geoip') ? { ip_cidr: ['1.2.3.0/24'] } : { domain_suffix: ['cn'] }
      fs.writeFileSync(src, JSON.stringify({ version: 3, rules: [rule] }))
      execFileSync(sbBin, ['rule-set', 'compile', '--output', out, src])
    } else {
      fs.writeFileSync(out, Buffer.from(`SRS-${tag}`))
    }
  }
  return dir
}

const env = () => {
  const store = seeded()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-client-root-'))
  return {
    store,
    geoDir: makeGeoDir(),
    paths: createPaths(root),
    // 没有 ip 命令、没有内核:局域网地址是空的,内核版本读不到;选择按档案默认
    ctx: createMockContext({ defaultExec: { code: 1, stdout: '', stderr: '' } }),
    fetchImpl: async () => { throw new Error('kernel not running') },
  }
}

test('客户端配置:路由器专属的都去掉,路由器自己的配置一字不变', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const routerConfig = () => buildCurrentConfig(store, [], { rulesetDir: paths.rulesetDir, geoDir }).config
  const before = routerConfig()
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.deepEqual(routerConfig(), before, '生成客户端配置不能改动档案 / 路由器配置')
  assert.ok(before.inbounds.some((i) => i.auto_redirect), '路由器那份照旧开着 auto_redirect')

  assert.equal(bundle.format, 'open-box-client')
  assert.equal(bundle.router.id, routerId(store))
  assert.match(bundle.fingerprint, /^[0-9a-f]{16}$/)
  const config = bundle.config
  assert.equal(config.inbounds, undefined)
  assert.equal(config.experimental, undefined)
  assert.equal(config.log, undefined)
  const text = JSON.stringify(config)
  // 终端分流、DNS 重写服务、dnsmasq 回送、局域网直连上游都没了
  assert.ok(!text.includes('10.0.0.9'))
  assert.ok(!text.includes('7854'))
  assert.ok(!text.includes('192.168.3.1'))
  assert.ok(!config.outbounds.some((o) => o.tag === 'dnsmasq'))
  assert.deepEqual(config.dns.servers.find((s) => s.tag === 'dns-direct'), { type: 'local', tag: 'dns-direct' })
  assert.equal(config.dns.servers.find((s) => s.type === 'fakeip').inet4_range, '198.18.0.0/16')
  assert.equal(config.route.auto_detect_interface, true)
  for (const entry of config.route.rule_set) assert.match(entry.path, /^(rulesets\/.+\.srs|flip\/obflip-.+\.json)$/)

  // 规则集:摘要和路由器上的文件一致;开关:国内此刻直连(关)、兜底此刻走代理(开)
  assert.deepEqual(bundle.ruleSets.map((r) => r.tag).sort(), ['geoip-cn', 'geosite-cn'])
  for (const r of bundle.ruleSets) {
    assert.equal(r.sha256, createHash('sha256').update(fs.readFileSync(path.join(geoDir, `${r.tag}.srs`))).digest('hex'))
    assert.equal(r.data, undefined, '扫码拿的 bundle 不带规则集内容')
  }
  const flags = Object.fromEntries(bundle.flags.map((f) => [f.selector, f]))
  assert.equal(flags['国内'].on, false)
  assert.equal(flags.AI.on, true)
  assert.equal(bundle.flags.find((f) => f.tag === FLIP_FALLBACK_TAG).on, true)
  assert.equal(bundle.directTag, config.outbounds.find((o) => o.type === 'direct').tag)
})

test('客户端配置:selector 默认值跟路由器此刻的选择走', async () => {
  const { store, geoDir, paths, ctx } = env()
  const fetchImpl = async () => ({ ok: true, json: async () => ({ proxies: { 国内: { now: '香港-自动' } } }) })
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.equal(bundle.config.outbounds.find((o) => o.tag === '国内').default, '香港-自动')
  assert.equal(bundle.flags.find((f) => f.selector === '国内').on, true, '国内此刻走代理:开关跟着开')
})

test('客户端配置:代理侧 DNS 上游的线路按目标分流判(和部署一样)', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const profile = store.getProfile()
  // 上游 9.9.9.9 被一个按 IP 分的站点集接住:解析器 detour 到那个站点集;不在任何站点集里就跟兜底
  store.setProfile({
    ...profile,
    dns: { ...profile.dns, proxy: '9.9.9.9', proxyProtocol: 'tcp' },
    routing: { ...profile.routing, policies: [{ id: 'dns', name: 'DNS上游', default: '香港-自动', ipCidr: ['9.9.9.9/32'] }, ...profile.routing.policies] },
  })
  const viaPolicy = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.equal(viaPolicy.config.dns.servers.find((s) => s.tag === 'dns-proxy').detour, 'DNS上游')
  store.setProfile({ ...store.getProfile(), dns: { ...store.getProfile().dns, proxy: '8.8.4.4' } })
  const viaFallback = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.equal(viaFallback.config.dns.servers.find((s) => s.tag === 'dns-proxy').detour, '其他')
})

test('客户端配置:判上游线路用的是手机那份规则表(profilePatch),不是路由器的', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const profile = store.getProfile()
  // 路由器开着 IPv6、代理线路的 v6 降为 IPv4:走代理的 v6 目标在路由器上会被拒绝;手机那份关了 IPv6,没有这条拒绝
  store.setProfile({
    ...profile,
    ipv6: true,
    ipv6Proxy: 'ipv4',
    dns: { ...profile.dns, proxy: '2606:4700:4700::1111', proxyProtocol: 'tcp' },
    routing: { ...profile.routing, policies: [{ id: 'dns', name: 'DNS上游', default: '香港-自动', ipCidr: ['2606:4700:4700::1111/128'] }, ...profile.routing.policies] },
  })
  const [onRouter] = await routeProxyDnsUpstreams({ store, ctx, paths, fetchImpl }, store.getProfile())
  assert.equal(onRouter.reject, true, '按路由器的规则表判:v6 目标走代理线路被拒绝')
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.equal(bundle.config.dns.servers.find((s) => s.tag === 'dns-proxy').detour, 'DNS上游', '按手机的规则表判:落到那个站点集')
})

test('客户端配置按 App 的补法补齐后通过 sing-box check', { skip: hasBin ? false : '没有 panel/.tools/sing-box' }, async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-client-check-'))
  fs.mkdirSync(path.join(dir, 'rulesets'))
  fs.mkdirSync(path.join(dir, 'flip'))
  for (const r of bundle.ruleSets) fs.copyFileSync(path.join(geoDir, `${r.tag}.srs`), path.join(dir, 'rulesets', `${r.tag}.srs`))
  for (const f of bundle.flags) fs.writeFileSync(path.join(dir, 'flip', `${f.tag}.json`), flipFlagContent(f.on))
  // 和 clients/core/obclient 的 BuildFullConfig 补的一样:tun、只听本机的 mixed、clash_api、cache_file、log
  const config = {
    ...bundle.config,
    log: { level: 'warn' },
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], auto_route: true, stack: 'mixed' },
      { type: 'mixed', tag: 'app-in', listen: '127.0.0.1', listen_port: 17890 },
    ],
    experimental: { clash_api: { external_controller: '127.0.0.1:19090', secret: 'x' }, cache_file: { enabled: true, path: 'cache.db', store_fakeip: true } },
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
  execFileSync(sbBin, ['check', '-c', path.join(dir, 'config.json'), '-D', dir])
})

test('接口:加设备拿码 → 拉加密配置 → 规则集 → 导出文件 → 删设备后拉不到', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const app = express()
  app.use(express.json())
  registerPublicClientConfigRoutes(app, { store, ctx, paths, fetchImpl, geoDir })
  registerClientConfigRoutes(app, { store, ctx, paths, fetchImpl, geoDir })
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const created = await (await fetch(`${base}/api/openbox/client-config/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '手机' }),
    })).json()
    assert.equal(created.routerId, routerId(store))
    assert.match(created.token, /^[0-9a-f]{48}$/)
    assert.equal(Buffer.from(created.key, 'base64url').length, 32)
    // 库里只有 token 的摘要
    assert.ok(!store.getRaw(CLIENT_DEVICES_KEY).includes(created.token))

    const url = `${base}/client/v1/${created.routerId}/config/${created.token}`
    const sealed = await (await fetch(url)).json()
    const raw = Buffer.from(sealed.data, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(created.key, 'base64url'), Buffer.from(sealed.iv, 'base64'))
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    const bundle = JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8'))
    assert.equal(bundle.format, 'open-box-client')
    assert.ok(!JSON.stringify(sealed).includes('hk.example.com'), '传输的是密文')

    const list = await (await fetch(`${base}/api/openbox/client-config/devices`)).json()
    assert.equal(list.devices.length, 1)
    assert.equal(list.devices[0].name, '手机')
    assert.ok(list.devices[0].lastSyncAt > 0)
    assert.equal(list.devices[0].key, undefined)

    const srs = await fetch(`${url}/rule-set/geosite-cn.srs`)
    assert.equal(srs.status, 200)
    assert.deepEqual(Buffer.from(await srs.arrayBuffer()), fs.readFileSync(path.join(geoDir, 'geosite-cn.srs')))
    assert.equal((await fetch(`${url}/rule-set/..%2F..%2Fetc%2Fpasswd`)).status, 404)
    assert.equal((await fetch(`${base}/client/v1/${created.routerId}/config/${'0'.repeat(48)}`)).status, 404)
    assert.equal((await fetch(`${base}/client/v1/${'f'.repeat(32)}/config/${created.token}`)).status, 404)

    const file = await (await fetch(`${base}/api/openbox/client-config/file`)).json()
    const cn = file.ruleSets.find((r) => r.tag === 'geosite-cn')
    assert.deepEqual(Buffer.from(cn.data, 'base64'), fs.readFileSync(path.join(geoDir, 'geosite-cn.srs')))

    assert.equal((await fetch(`${base}/api/openbox/client-config/devices/${created.device.id}`, { method: 'DELETE' })).status, 200)
    assert.equal((await fetch(url)).status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// 客户端那头(clients/core/obclient 的 BuildFullConfig)的测试吃的就是这里生成的模板:路由器这边的形状变了,
// 这条会失败,提醒去重新生成(OPENBOX_UPDATE_GOLDEN=1 node --test server/api/client-config.test.mjs),Go 那边再跑一遍
const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../clients/core/obclient/testdata/full-template.json')
// 只打包面板的检出里没有 clients/(比如发版用的 worktree),跳过;要重生成的时候照样写
test('客户端模板和 clients/core/obclient/testdata 里的一致', { skip: fs.existsSync(GOLDEN) || process.env.OPENBOX_UPDATE_GOLDEN === '1' ? false : '这个检出里没有 clients/' }, async () => {
  const { store, paths, ctx, fetchImpl } = env()
  const geoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../resources/geodata')
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  const golden = { config: bundle.config, flags: bundle.flags, directTag: bundle.directTag, ruleSets: bundle.ruleSets.map((r) => r.tag) }
  if (process.env.OPENBOX_UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
    fs.writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`)
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')), golden)
})

