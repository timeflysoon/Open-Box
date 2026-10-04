import assert from 'node:assert/strict'
import test from 'node:test'
import { chainNodes, normalizeChainProxies, parseChainNode, residentialToShareLink, resolveChainNodes, validateChainProxies } from './chain-proxy.mjs'
import { emitOutbound } from './emit-outbound.mjs'
import { buildConfig } from './config.mjs'
import { defaultGroups } from './user-groups.mjs'

const SOCKS = 'socks5://user:pass@res.example.net:1080#住宅'
const SS = 'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@1.2.3.4:8388#ss-a'
const node = (tag) => ({ tag, originalTag: tag, type: 'shadowsocks', server: `${tag}.example.com`, server_port: 443, fields: { method: 'aes-256-gcm', password: 'x' }, source: 'sharelink', subscriptionId: 's1' })
const entry = (over = {}) => ({ id: 'c1', enabled: true, name: '住宅-美国', link: SOCKS, upstream: 'HK-01', ...over })

test('parseChainNode:一条链接出一个节点;空的 / 解析不出 / 多个节点都报人话', () => {
  const ok = parseChainNode(SOCKS)
  assert.equal(ok.node.type, 'socks')
  assert.equal(ok.node.server, 'res.example.net')
  assert.equal(ok.node.server_port, 1080)
  assert.match(parseChainNode('').error, /不能为空/)
  assert.match(parseChainNode('not a node').error, /没有解析出可用的节点/)
  assert.match(parseChainNode(`${SOCKS}\n${SS}`).error, /只能填一个节点/)
})

test('validateChainProxies:id / 名称 / 上游 / 节点内容逐项查,名称重复和上游指向自己都拦', () => {
  assert.equal(validateChainProxies([entry()]), '')
  assert.match(validateChainProxies('x'), /must be an array/)
  assert.match(validateChainProxies([entry({ id: 'bad id' })]), /id must match/)
  assert.match(validateChainProxies([entry({ name: ' ' })]), /名称不能为空/)
  assert.match(validateChainProxies([entry(), entry({ id: 'c2' })]), /名称重复/)
  assert.match(validateChainProxies([entry({ upstream: '' })]), /还没有选上游/)
  assert.match(validateChainProxies([entry({ upstream: '住宅-美国' })]), /不能是它自己/)
  assert.match(validateChainProxies([entry({ link: 'garbage' })]), /没有解析出可用的节点/)
})

test('normalizeChainProxies:去空白、补 enabled、按节点内容重算摘要(不信客户端传来的 node)', () => {
  const [e] = normalizeChainProxies([{ id: 'c1', name: ' 住宅 ', link: ` ${SOCKS} `, upstream: ' HK-01 ', node: { type: 'fake', server: 'x', port: 1 } }])
  assert.deepEqual(e, { id: 'c1', enabled: true, name: '住宅', link: SOCKS, upstream: 'HK-01', node: { type: 'socks', server: 'res.example.net', port: 1080 } })
})

test('chainNodes:只出启用着、解析得出来的;tag 用用户起的名字,带 chain / detour 标记', () => {
  const list = chainNodes({ chainProxies: [entry(), entry({ id: 'c2', name: '停用的', enabled: false }), entry({ id: 'c3', name: '坏的', link: 'garbage' })] })
  assert.equal(list.length, 1)
  assert.equal(list[0].tag, '住宅-美国')
  assert.equal(list[0].chain, true)
  assert.equal(list[0].detour, 'HK-01')
})

test('resolveChainNodes:上游不存在 / 指向内置直连 / 名称重复 / 成环的条目不进配置,原因记下来', () => {
  const nodes = [node('HK-01'), node('US-01')]
  const groups = [...defaultGroups(), { id: 'g1', name: '住宅组', type: 'selector', mode: 'static', members: ['环里的'], keywords: [], enabled: true }]
  const r = resolveChainNodes({
    nodes, userGroups: groups,
    chainProxies: [
      entry(),
      entry({ id: 'c2', name: '没上游', upstream: '不存在' }),
      entry({ id: 'c3', name: '走直连', upstream: '直连' }),
      entry({ id: 'c4', name: 'US-01', upstream: 'HK-01' }),
      entry({ id: 'c5', name: '环里的', upstream: '住宅组' }),
      entry({ id: 'c6', name: '二跳', upstream: '住宅-美国' }),
    ],
  })
  assert.deepEqual(r.nodes.map((n) => n.tag).sort(), ['二跳', '住宅-美国'].sort(), '链式节点可以再套一层链式节点')
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]))
  assert.deepEqual(reasons, { 没上游: 'upstream', 走直连: 'upstream', 'US-01': 'duplicate', 环里的: 'cycle' })
})

// 2026-09-22 开发路由器:节点组恢复默认后「香港-自动」没了,5 条链式代理的上游同时失效。剔坏条目的循环
// 上界跟着变短的名单一起缩,最后一条没剔掉就原样进了配置,内核启动 FATAL(dependency[香港-自动] not found)
test('resolveChainNodes:再多条链式代理同时没了上游也一条不留', () => {
  const chainProxies = Array.from({ length: 6 }, (_, i) => entry({ id: `c${i}`, name: `住宅-${i}`, upstream: '香港-自动' }))
  const r = resolveChainNodes({ nodes: [node('HK-01')], userGroups: defaultGroups(), chainProxies })
  assert.deepEqual(r.nodes, [])
  assert.equal(r.skipped.length, 6)
  assert.ok(r.skipped.every((s) => s.reason === 'upstream'))
  // 配置里也一条都不该有
  const config = buildConfig({ nodes: [node('HK-01')], userGroups: defaultGroups(), profile: { chainProxies, routing: { policies: [], fallbackDefault: 'direct' }, dns: { split: true } } })
  assert.ok(!config.outbounds.some((o) => /^住宅-/.test(o.tag)))
})

test('buildConfig:链式节点带 detour 进出站;静态成员能引用它,「全部节点」这类动态组不会自动收它;它的地址不进节点站点直连', () => {
  const nodes = [node('HK-01')]
  const groups = [...defaultGroups(), { id: 'g1', name: '住宅组', type: 'selector', mode: 'static', members: ['住宅-美国'], keywords: [], enabled: true }]
  const profile = { chainProxies: [entry()], routing: { policies: [], fallbackDefault: 'direct' }, dns: { split: true } }
  const config = buildConfig({ nodes, profile, userGroups: groups })
  const chain = config.outbounds.find((o) => o.tag === '住宅-美国')
  assert.equal(chain.type, 'socks')
  assert.equal(chain.detour, 'HK-01')
  assert.equal(chain.server, 'res.example.net')
  assert.deepEqual(config.outbounds.find((o) => o.tag === '住宅组').outbounds, ['住宅-美国'])
  for (const o of config.outbounds.filter((x) => Array.isArray(x.outbounds) && x.tag !== '住宅组')) {
    assert.ok(!o.outbounds.includes('住宅-美国'), `${o.tag} 不该自动收链式节点`)
  }
  assert.ok(!JSON.stringify(config.route.rules).includes('res.example.net'), '链式节点的服务器地址不进直连规则')
  assert.equal(config.outbounds.find((o) => o.tag === 'HK-01').detour, undefined, '普通节点不带 detour')
})

test('parseChainNode:住宅代理的纯文本账号 / http:// / https:// 都按 HTTP 代理接;出站带账号密码,https 带 TLS', () => {
  assert.equal(residentialToShareLink('cm915011.as.thordata.net:9999:td-customer-ufypFgys18os-country-TW:k3ttgk8vhg'), 'http://td-customer-ufypFgys18os-country-TW:k3ttgk8vhg@cm915011.as.thordata.net:9999')
  assert.equal(residentialToShareLink('user:p:a:ss@1.2.3.4:1080'), 'http://user:p%3Aa%3Ass@1.2.3.4:1080', '密码里的冒号原样保留')
  assert.equal(residentialToShareLink('gw.example.net:7000'), 'http://gw.example.net:7000')
  assert.equal(residentialToShareLink('socks5://u:p@h:1'), '', '带 :// 的不改写')
  assert.equal(residentialToShareLink('host:99999x:u:p'), '')
  assert.equal(residentialToShareLink('just some text'), '')
  for (const text of [
    'cm915011.as.thordata.net:9999:td-customer-ufypFgys18os-country-TW:k3ttgk8vhg',
    'http://td-customer-ufypFgys18os-country-TW:k3ttgk8vhg@cm915011.as.thordata.net:9999',
  ]) {
    const node = parseChainNode(text).node
    assert.equal(node.type, 'http', text)
    assert.equal(node.server, 'cm915011.as.thordata.net')
    assert.equal(node.server_port, 9999)
    assert.deepEqual(emitOutbound({ ...node, tag: '住宅' }), { type: 'http', tag: '住宅', server: 'cm915011.as.thordata.net', server_port: 9999, username: 'td-customer-ufypFgys18os-country-TW', password: 'k3ttgk8vhg' })
  }
  const https = parseChainNode('https://td-customer-ufypFgys18os-country-TW:k3ttgk8vhg@cm915011.as.thordata.net:9999').node
  const out = emitOutbound({ ...https, tag: '住宅' })
  assert.equal(out.type, 'http')
  assert.equal(out.tls.enabled, true)
  assert.equal(out.tls.server_name, 'cm915011.as.thordata.net')
  assert.equal(parseChainNode('user:p:a:ss@1.2.3.4:1080').node.server, '1.2.3.4')
  assert.equal(parseChainNode('user:p:a:ss@1.2.3.4:1080').node.fields.password, 'p:a:ss')
  assert.match(parseChainNode('http://nohost').error, /格式不对|解析失败/)
  // socks5:// 照旧是 socks
  assert.equal(parseChainNode('socks5://u:p@1.2.3.4:1080#x').node.type, 'socks')
})
