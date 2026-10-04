import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { checkConfig, validateConfigObject, attributeBadNodes, describeConfigError } from './validate.mjs'

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
