import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { checkConfig, validateConfigObject, attributeBadNodes, describeConfigError, kernelErrorText, kernelRejectedNodes } from './validate.mjs'

test('错误索引映射到重命名后的节点、订阅和原名，不泄露节点配置', () => {
  const nodes = [{ tag: '机场A-香港01', originalTag: 'HK01', subscriptionId: 'a', password: 'never-show' }]
  const subscriptions = [{ id: 'a', name: '我的机场', url: 'https://private-sub/token' }]
  const config = { outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'hysteria2', tag: nodes[0].tag }] }
  for (const msg of ['\x1b[31mFATAL\x1b[0m [0000] initialize outbound[1]: missing obfs password', 'initialize outbound [1]: invalid public_key', 'outbounds.1.tls: invalid public_key', 'initialize outbound/hysteria2[机场A-香港01]: failed']) {
    const r = describeConfigError(msg, config, { nodes, subscriptions })
    assert.match(r.message, /节点「机场A-香港01」，订阅「我的机场」，原名「HK01」/)
    assert.doesNotMatch(r.message, /\x1b|never-show|private-sub/)
    assert.deepEqual(r.badTags, ['机场A-香港01'])
  }
  const group = describeConfigError('initialize outbound[0]: failure', config, { nodes, subscriptions })
  assert.match(group.message, /出站「direct」/)
  assert.deepEqual(group.badTags, [])
  assert.equal(describeConfigError('initialize outbound[999]: failed', config).located, false)
  assert.equal(describeConfigError('DNS failed', config).message, 'DNS failed')
  assert.match(describeConfigError('initialize endpoint[0]: failed', { endpoints: [{ type: 'wireguard', tag: nodes[0].tag }] }, { nodes, subscriptions }).message, /订阅「我的机场」/)
})

const paths = createPaths('/opt/open-box')

test('checkConfig 通过', async () => {
  const ctx = createMockContext({ execResults: { '/opt/open-box/bin/sing-box check -c /tmp/c.json': { code: 0 } } })
  const r = await checkConfig(ctx, paths, '/tmp/c.json')
  assert.equal(r.ok, true)
})

test('checkConfig 失败带 message', async () => {
  const ctx = createMockContext({ defaultExec: { code: 1, stderr: 'FATAL[0000] initialize outbound[1]: unknown method: x\n' } })
  const r = await checkConfig(ctx, paths, '/tmp/c.json')
  assert.equal(r.ok, false)
  assert.match(r.message, /unknown method/)
})

test('validateConfigObject 写临时文件并 check', async () => {
  const ctx = createMockContext()
  const r = await validateConfigObject(ctx, paths, { log: { level: 'warn' } }, '/tmp/v.json')
  assert.equal(r.ok, true)
  assert.equal(ctx.writes[0].path, '/tmp/v.json')
  assert.deepEqual(JSON.parse(ctx.writes[0].content), { log: { level: 'warn' } })
})

test('attributeBadNodes 定位坏节点', async () => {
  const config = {
    outbounds: [
      { type: 'direct', tag: 'direct' },
      { type: 'selector', tag: 'PROXY', outbounds: ['good'] },
      { type: 'shadowsocks', tag: 'good', server: 'a', server_port: 1, method: 'aes-256-gcm', password: 'p' },
      { type: 'shadowsocks', tag: 'bad', server: 'a', server_port: 1, method: 'nope', password: 'p' },
    ],
  }
  // 让含 "nope" 的那次 check 失败:用 defaultExec 成功,单独编排失败键
  const ctx = createMockContext({
    execResults: {},
    defaultExec: { code: 0 },
  })
  // 通过覆写 exec 精确模拟:按最近一次写入的探针内容判定该次 check 是否失败
  const realExec = ctx.exec
  ctx.exec = async (cmd, args) => {
    const call = await realExec(cmd, args)
    const written = ctx.writes[ctx.writes.length - 1]
    if (written && written.content.includes('"method":"nope"')) return { code: 1, stdout: '', stderr: 'unknown method: nope' }
    return call
  }
  const r = await attributeBadNodes(ctx, paths, config, '/tmp/n.json')
  assert.deepEqual(r.badTags, ['bad'])
  assert.equal(r.checked, 2)   // 只检代理节点,不检 direct/selector
})

// GitHub #518:添加 / 刷新订阅、启动时让内核挑出它不认的节点
test('kernelRejectedNodes:内核报哪个就剔掉再查,直到通过;编号跳过检查用的直连;不带 detour;临时文件用完删', async () => {
  const node = (tag, extra = {}, more = {}) => ({ tag, type: 'shadowsocks', server: 'a.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'p', ...extra }, source: 'clash', ...more })
  const nodes = [node('good1'), node('bad1', { method: 'nope' }), node('good2'), node('bad2', { method: 'nope' }), node('chain', {}, { detour: 'up' })]
  const ctx = createMockContext()
  const seen = []
  ctx.exec = async () => {
    const probe = JSON.parse(ctx.files['/tmp/vet.json'])
    seen.push(probe.outbounds.map((o) => o.tag))
    if (probe.outbounds.some((o) => o.detour)) return { code: 1, stdout: '', stderr: 'FATAL[0000] initialize outbound[5]: outbound not found: up\n' }
    const i = probe.outbounds.findIndex((o) => o.method === 'nope')
    if (i >= 0) return { code: 1, stdout: '', stderr: `\x1b[31mFATAL\x1b[0m[0000] initialize outbound[${i}]: unknown method: nope\n` }
    return { code: 0, stdout: '', stderr: '' }
  }
  const r = await kernelRejectedNodes(ctx, paths, nodes, '/tmp/vet.json')
  assert.deepEqual(r, { rejected: [{ tag: 'bad1', error: 'unknown method: nope' }, { tag: 'bad2', error: 'unknown method: nope' }], unlocated: '' })
  assert.equal(seen.length, 3)
  assert.equal(seen[0][0], '__openbox_vet_direct')
  assert.deepEqual(seen[2], ['__openbox_vet_direct', 'good1', 'good2', 'chain'])
  assert.equal('/tmp/vet.json' in ctx.files, false, '临时配置里有节点凭据,用完删')
})

test('kernelRejectedNodes:wireguard 走 endpoint、按名字报的也认;认不出是哪个就停下,不乱剔', async () => {
  const wg = { tag: 'wg', type: 'wireguard', server: 'w.com', server_port: 51820, fields: { private_key: 'k', peer_public_key: 'p', local_address: ['10.0.0.2/32'] }, source: 'clash' }
  const ss = { tag: 'ss', type: 'shadowsocks', server: 'a.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'p' }, source: 'clash' }
  const ctx = createMockContext()
  let round = 0
  ctx.exec = async () => {
    round += 1
    const probe = JSON.parse(ctx.files['/tmp/w.json'])
    if ((probe.endpoints || []).length) return { code: 1, stdout: '', stderr: 'FATAL[0000] initialize endpoint[0]: decode private key: bad\n' }
    if (probe.outbounds.some((o) => o.tag === 'ss')) return { code: 1, stdout: '', stderr: 'FATAL[0000] start outbound/shadowsocks[ss]: boom\n' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const r = await kernelRejectedNodes(ctx, paths, [wg, ss], '/tmp/w.json')
  assert.deepEqual(r.rejected.map((x) => x.tag), ['wg', 'ss'])
  assert.equal(round, 2, '都剔完了就不再多查一轮')
  const stuck = createMockContext({ defaultExec: { code: 1, stderr: 'FATAL[0000] duplicate outbound tag: x\n' } })
  const r2 = await kernelRejectedNodes(stuck, paths, [ss], '/tmp/s.json')
  assert.deepEqual(r2.rejected, [])
  assert.match(r2.unlocated, /duplicate outbound tag/)
  assert.equal(kernelErrorText('FATAL[0000] initialize outbound[72]: invalid public_key'), 'invalid public_key')
})

