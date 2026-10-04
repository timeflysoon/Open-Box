import assert from 'node:assert/strict'
import test from 'node:test'
import { createStore, DEFAULT_PROFILE, KEYS } from './openbox-store.mjs'

const memStore = () => {
  const m = new Map()
  return {
    store: createStore({
      get: (k) => (m.has(k) ? m.get(k) : null),
      set: (k, v) => m.set(k, v),
      del: (k) => m.delete(k),
    }),
    m,
  }
}

test('getProfile 无值返回默认', () => {
  const { store } = memStore()
  assert.deepEqual(store.getProfile(), DEFAULT_PROFILE)
})

test('IPv6 默认关闭:不解析也不访问 v6,除非用户自己打开', () => {
  const { store } = memStore()
  assert.equal(store.getProfile().ipv6, false)
})

test('setProfile 深合并,不丢未提及字段', () => {
  const { store } = memStore()
  store.setProfile({ ipv6: false, dns: { mode: 'dnsmasq' } })
  const p = store.getProfile()
  assert.equal(p.ipv6, false)
  assert.equal(p.dns.mode, 'dnsmasq')
  assert.equal(p.dns.direct, 'wan') // 未提及字段保留(默认是上游 DNS)
  assert.equal(p.routing.fallbackDefault, 'proxy')
})

test('setProfile 返回合并结果', () => {
  const { store } = memStore()
  const returned = store.setProfile({ ipv6: false })
  assert.deepEqual(returned, store.getProfile())
})

test('老数据缺新字段时用默认补齐', () => {
  const { store, m } = memStore()
  m.set(KEYS.profile, JSON.stringify({ ipv6: false }))
  const p = store.getProfile()
  assert.equal(p.ipv6, false)
  assert.deepEqual(p.tun, DEFAULT_PROFILE.tun)
})

test('数组字段整体替换而非合并', () => {
  const { store } = memStore()
  store.setProfile({ routing: { displayOrder: ['AI'] } })
  store.setProfile({ routing: { displayOrder: ['谷歌'] } })
  const p = store.getProfile()
  assert.deepEqual(p.routing.displayOrder, ['谷歌'])
  // 未提及的 routing 字段仍保留默认
  assert.equal(p.routing.fallbackDefault, 'proxy')
  assert.deepEqual(p.routing.policies.map((x) => x.name), ['中国大陆·直连'])
})

test('订阅/节点/部署态往返', () => {
  const { store } = memStore()
  store.setSubscriptions([{ id: 's1', url: 'http://x', name: 'A' }])
  assert.equal(store.getSubscriptions()[0].id, 's1')
  store.setNodes([{ tag: '美国-01' }])
  assert.equal(store.getNodes().length, 1)
  store.setDeployState({ stage: 'running', message: '', at: 1, badTags: [] })
  assert.equal(store.getDeployState().stage, 'running')
})

test('订阅/节点无值时返回空数组', () => {
  const { store } = memStore()
  assert.deepEqual(store.getSubscriptions(), [])
  assert.deepEqual(store.getNodes(), [])
})

test('clashSecret 生成一次并持久化', () => {
  const { store } = memStore()
  const s1 = store.getClashSecret()
  const s2 = store.getClashSecret()
  assert.equal(s1, s2)
  assert.match(s1, /^[0-9a-f]{32}$/)
})

test('clashSecret 用注入的 randomHex 保证测试确定性', () => {
  const m = new Map()
  const injected = createStore(
    {
      get: (k) => (m.has(k) ? m.get(k) : null),
      set: (k, v) => m.set(k, v),
      del: (k) => m.delete(k),
    },
    { randomHex: () => 'a'.repeat(32) },
  )
  assert.equal(injected.getClashSecret(), 'a'.repeat(32))
})

test('损坏的 JSON 回退到默认而非抛错', () => {
  const { store, m } = memStore()
  m.set(KEYS.profile, '{ not json')
  assert.deepEqual(store.getProfile(), DEFAULT_PROFILE)
  m.set(KEYS.subscriptions, 'oops')
  assert.deepEqual(store.getSubscriptions(), [])
})

test('损坏的部署态 JSON 回退到默认', () => {
  const { store, m } = memStore()
  m.set(KEYS.deployState, 'not json')
  assert.deepEqual(store.getDeployState(), { stage: 'idle', message: '', at: 0, badTags: [] })
})

test('线路选择快照:键名带 openbox/ 前缀（受保护,不会被设置同步清掉）;旧的点号键自动搬过来', () => {
  const m = new Map()
  const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
  assert.equal(KEYS.selections, 'openbox/selections')
  m.set('openbox.selections', JSON.stringify({ '谷歌': '香港' }))
  assert.deepEqual(store.getSelectionsSnapshot(), { '谷歌': '香港' })
  assert.ok(!m.has('openbox.selections'))
  assert.ok(m.has('openbox/selections'))
  store.setSelectionsSnapshot({ a: 'b' })
  assert.equal(m.get('openbox/selections'), JSON.stringify({ a: 'b' }))
  // 内核在跑时直接写新快照(不经 get):旧键也要被清掉
  m.set('openbox.selections', '{}')
  store.setSelectionsSnapshot({ c: 'd' })
  assert.ok(!m.has('openbox.selections'))
})

test('旧数据或旧备份的 Geo 自动更新计划退出使用，其他更新和 DNS 计划保留', () => {
  const { store, m } = memStore()
  m.set(KEYS.profile, JSON.stringify({ updates: { geo: { auto: true }, openbox: { auto: true } } }))
  assert.equal(store.getProfile().updates.geo, undefined)
  assert.equal(store.getProfile().updates.openbox.auto, true)
  const imported = store.setProfile({ updates: { geo: { auto: true, hour: 4 } }, dns: { filter: { autoUpdate: { enabled: true } } } })
  assert.equal(imported.updates.geo, undefined)
  assert.equal(imported.updates.openbox.auto, true)
  assert.equal(imported.dns.filter.autoUpdate.enabled, true)
})

// ---------- 老档案整理(2026-09 清理退役字段) ----------
const legacyStored = () => ({
  region: 'CN',
  rulesetDir: '/opt/open-box/data/rulesets',
  ipv6: true,
  dns: { split: true, mode: 'dnsmasq', direct: '223.5.5.5', proxy: 'https://1.1.1.1/dns-query' },
  updates: { openbox: { auto: true, hour: 3, channel: 'auto', checkChannel: 'auto' }, geo: { auto: true } },
  routing: {
    proxyTag: 'PROXY',
    regions: [{ id: 'cn', name: '中国大陆', catchAll: 'proxy', rules: [{ type: 'geosite', value: 'cn', action: 'direct' }, { type: 'geoip', value: 'cn', action: 'direct' }] }],
    regionMode: 'CN',
    outboundOptions: { direct: true, reject: true, groups: true },
    policies: [{ id: 'g', name: '谷歌', rulesets: ['geosite-google'], default: '香港-自动' }],
    adBlock: false,
    adRuleset: 'geosite-category-ads-all',
    categories: [],
    directRulesets: ['geosite-cn', 'geoip-cn'],
    fallback: 'PROXY',
  },
})

test('读老档案:退役字段翻译 / 删掉并写回一次,DoH 上游折成主机名;再读不再写', () => {
  const { store, m } = memStore()
  m.set(KEYS.profile, JSON.stringify(legacyStored()))
  const p = store.getProfile()
  for (const key of ['region', 'rulesetDir']) assert.equal(key in p, false, key)
  assert.equal('geo' in p.updates, false)
  assert.equal(p.updates.openbox.hour, 3)
  for (const key of ['proxyTag', 'regions', 'regionId', 'regionMode', 'outboundOptions', 'adBlock', 'adRuleset', 'categories', 'directRulesets', 'fallback']) {
    assert.equal(key in p.routing, false, key)
  }
  assert.deepEqual(p.routing.policies.map((x) => x.name), ['谷歌', '中国大陆·直连'])
  assert.equal(p.routing.fallbackDefault, 'proxy')
  assert.equal(p.dns.proxy, '1.1.1.1')
  assert.equal(p.dns.direct, '223.5.5.5')
  // 已经写回:库里那份也干净了
  const stored = JSON.parse(m.get(KEYS.profile))
  assert.equal('region' in stored, false)
  assert.equal('regions' in stored.routing, false)
  assert.equal(stored.dns.proxy, '1.1.1.1')
  assert.deepEqual(stored.routing.policies.map((x) => x.name), ['谷歌', '中国大陆·直连'])
  // 再读一次不会再翻译一遍(不长出第二个「中国大陆·直连」),库里那份也一字不变
  const before = m.get(KEYS.profile)
  const again = store.getProfile()
  assert.deepEqual(again.routing.policies.map((x) => x.name), ['谷歌', '中国大陆·直连'])
  assert.equal(m.get(KEYS.profile), before)
})

test('全新安装:没有 policies 时种一条「中国大陆·直连」,兜底默认走代理;用户删空了就不再补', () => {
  const { store } = memStore()
  const fresh = store.getProfile()
  assert.deepEqual(fresh.routing.policies.map((x) => x.name), ['中国大陆·直连'])
  assert.deepEqual(fresh.routing.policies[0].rulesets, ['geosite-cn', 'geoip-cn'])
  assert.equal(fresh.routing.fallbackDefault, 'proxy')
  assert.equal(fresh.rulesetDir, undefined)
  assert.equal(fresh.region, undefined)
  store.setProfile({ routing: { policies: [] } })
  assert.deepEqual(store.getProfile().routing.policies, [])
})

test('setProfile 收到老客户端 / 老备份的 patch:退役字段不落库,只带 adBlock 的 patch 不会清空现有站点集', () => {
  const { store, m } = memStore()
  store.setProfile({ routing: { adBlock: true, adRuleset: 'geosite-ads' } })
  let p = store.getProfile()
  assert.equal('adBlock' in p.routing, false)
  assert.deepEqual(p.routing.policies.map((x) => x.name), ['中国大陆·直连'])
  store.setProfile({ region: 'US', rulesetDir: '/x', dns: { proxy: 'https://8.8.8.8/dns-query', direct: 'tls://223.6.6.6', proxyProtocol: 'doh' } })
  p = store.getProfile()
  assert.equal(p.region, undefined)
  assert.equal(p.rulesetDir, undefined)
  assert.equal(p.dns.proxy, '8.8.8.8')
  assert.equal(p.dns.direct, '223.6.6.6')
  // 不认识的协议值删掉,读出来是默认;端口默认 53
  assert.equal(p.dns.proxyProtocol, 'tcp')
  assert.equal(p.dns.directProtocol, 'udp')
  assert.equal(p.dns.directPort, 53)
  assert.equal(p.dns.proxyPort, 53)
  store.setProfile({ dns: { directPort: 'x', proxyPort: 5353 } })
  assert.equal(store.getProfile().dns.directPort, 53)
  assert.equal(store.getProfile().dns.proxyPort, 5353)
  // 带域名的老上游折不成 IP,换回默认
  store.setProfile({ dns: { proxy: 'https://dns.google/dns-query' } })
  assert.equal(store.getProfile().dns.proxy, '1.1.1.1')
  // 折不出合法地址的换回默认值
  store.setProfile({ dns: { proxy: 'not a host' } })
  assert.equal(store.getProfile().dns.proxy, '1.1.1.1')
  const stored = JSON.parse(m.get(KEYS.profile))
  assert.equal('region' in stored, false)
  assert.equal('adBlock' in stored.routing, false)
})

test('systemd 平台(Debian / Ubuntu):档案里的 dnsmasq 分流按劫持读,库里的值不改;OpenWrt 照旧', () => {
  const m = new Map()
  const io = { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) }
  const sd = createStore(io, { platform: 'systemd' })
  // 默认档案就是 dnsmasq
  assert.equal(DEFAULT_PROFILE.dns.mode, 'dnsmasq')
  assert.equal(sd.getProfile().dns.mode, 'hijack')
  m.set(KEYS.profile, JSON.stringify({ dns: { mode: 'dnsmasq' } }))
  assert.equal(sd.getProfile().dns.mode, 'hijack')
  assert.equal(createStore(io).getProfile().dns.mode, 'dnsmasq')
  m.set(KEYS.profile, JSON.stringify({ dns: { mode: 'off' } }))
  assert.equal(sd.getProfile().dns.mode, 'off')
})

test('端口名单黑 / 白各存一份:老档案的白名单模式把 bypassPorts 挪到白名单名下,只挪一次;切模式不带走另一份', () => {
  // 老档案(还没有 bypassPortsWhitelist):白名单模式用的就是 bypassPorts
  const old = memStore()
  old.m.set(KEYS.profile, JSON.stringify({ bypassPorts: '443, 8443', bypassPortsMode: 'whitelist' }))
  const p = old.store.getProfile()
  assert.equal(p.bypassPortsWhitelist, '443, 8443')
  assert.equal(p.bypassPorts, '')
  assert.equal(JSON.parse(old.m.get(KEYS.profile)).bypassPortsWhitelist, '443, 8443', '挪完写回库里')
  // 黑名单模式的老档案不动
  const black = memStore()
  black.m.set(KEYS.profile, JSON.stringify({ bypassPorts: '21114-21119', bypassPortsMode: 'blacklist' }))
  assert.equal(black.store.getProfile().bypassPorts, '21114-21119')
  assert.equal(black.store.getProfile().bypassPortsWhitelist, '')
  // 黑名单里填了端口,切到白名单:白名单还是空的,黑名单那份原样留着
  black.store.setProfile({ bypassPortsMode: 'whitelist' })
  const switched = black.store.getProfile()
  assert.equal(switched.bypassPortsWhitelist, '')
  assert.equal(switched.bypassPorts, '21114-21119')
  // 老备份恢复(带白名单模式、没有 bypassPortsWhitelist):同样挪到白名单名下
  black.store.setProfile({ bypassPorts: '80', bypassPortsMode: 'whitelist' })
  assert.equal(black.store.getProfile().bypassPortsWhitelist, '80')
  assert.equal(black.store.getProfile().bypassPorts, '')
})

test('DNS 上游:上游 DNS 记号 wan 原样存;空串 / 折不出 IP 的换回默认(直连 = 上游 DNS、代理 = 1.1.1.1);地区不认识的删掉', () => {
  const { store, m } = memStore()
  store.setProfile({ dns: { direct: 'wan', proxy: 'wan', region: 'intl' } })
  assert.equal(store.getProfile().dns.direct, 'wan')
  assert.equal(store.getProfile().dns.proxy, 'wan')
  assert.equal(store.getProfile().dns.region, 'intl')
  m.set(KEYS.profile, JSON.stringify({ dns: { direct: '', proxy: '', region: 'mars' } }))
  const p = store.getProfile()
  assert.equal(p.dns.direct, 'wan')
  assert.equal(p.dns.proxy, '1.1.1.1')
  assert.equal(p.dns.region, undefined)
})
