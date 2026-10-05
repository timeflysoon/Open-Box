import assert from 'node:assert/strict'
import test from 'node:test'
import { describeNameConflict, findNameConflicts, outboundNameOwners, refreshNameError, saveNameError, subscriptionNameError } from './name-guard.mjs'

const groups = [{ id: 'g1', name: '香港-自动', type: 'urltest' }, { id: 'g2', name: '停用的组', type: 'selector', enabled: false }]
const routing = { policies: [{ id: 'ai', name: 'AI', domainSuffix: ['openai.com'] }, { id: 'off', name: '停用站点集', enabled: false, domainSuffix: ['x.com'] }] }
const subscriptions = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]
const chainProxies = [{ id: 'c1', name: '链-美国', upstream: 'HK', link: 'socks5://u:p@1.2.3.4:1080#x' }]

test('谁在用这个名字:节点(带订阅名)、链式代理、节点组、内置出口、站点集(含兜底),停用的也算', () => {
  const owners = outboundNameOwners({ nodes: [{ tag: 'HK', subscriptionId: 'a' }], subscriptions, groups, routing, chainProxies })
  const byName = Object.fromEntries(owners.map((o) => [o.name, o.label]))
  assert.equal(byName.HK, '订阅「甲」的节点')
  assert.equal(byName['链-美国'], '链式代理')
  assert.equal(byName['香港-自动'], '节点组')
  assert.equal(byName['停用的组'], '节点组')
  assert.equal(byName.AI, '站点集')
  assert.equal(byName['停用站点集'], '站点集')
  assert.equal(byName['其他'], '站点集')
  assert.equal(owners.filter((o) => o.kind === 'builtin').length, 2)
})

test('撞名:节点和节点之间不算(那个自动加 -2),别的组合都算', () => {
  const owners = outboundNameOwners({
    nodes: [{ tag: 'HK', subscriptionId: 'a' }, { tag: 'HK', subscriptionId: 'b' }, { tag: 'AI', subscriptionId: 'a' }, { tag: '链-美国', subscriptionId: 'b' }],
    subscriptions, groups, routing, chainProxies,
  })
  const conflicts = findNameConflicts(owners)
  assert.deepEqual(conflicts.map((c) => c.name), ['AI', '链-美国'])
  assert.equal(describeNameConflict(conflicts[0]), '名称「AI」重复:订阅「甲」的节点和站点集同名')
  assert.equal(describeNameConflict({ name: 'X', owners: [{ label: '节点组' }, { label: '节点组' }] }), '名称「X」重复:两个节点组同名')
})

test('刷新订阅能不能存:只看这几条订阅的新节点;撞了说哪条订阅、哪个名字、和谁、怎么改', () => {
  const base = { subscriptions, groups, routing, chainProxies }
  assert.equal(refreshNameError({ ...base, nodes: [{ tag: 'HK', subscriptionId: 'b' }], subscriptionIds: ['b'] }), null)
  assert.equal(
    refreshNameError({ ...base, nodes: [{ tag: '香港-自动', subscriptionId: 'b' }], subscriptionIds: ['b'] }),
    '订阅「乙」更新后的节点「香港-自动」和节点组同名,这次更新没有保存(旧节点照用)。请在这条订阅的改名规则里改掉这个名字,或者给节点组换个名字',
  )
  assert.match(refreshNameError({ ...base, nodes: [{ tag: '其他', subscriptionId: 'a' }], subscriptionIds: ['a'] }), /和站点集同名/)
  // 别的订阅原来就撞着的,不归这次刷新管
  assert.equal(refreshNameError({ ...base, nodes: [{ tag: '香港-自动', subscriptionId: 'a' }, { tag: 'JP', subscriptionId: 'b' }], subscriptionIds: ['b'] }), null)
})

test('新建 / 改订阅的说法;保存节点组 / 站点集 / 链式代理前按「这次存的那一类」查', () => {
  const base = { subscriptions, groups, routing, chainProxies }
  assert.equal(
    subscriptionNameError({ ...base, nodes: [{ tag: 'AI', subscriptionId: 'a' }], subscriptionIds: ['a'], action: 'save' }),
    '订阅「甲」的节点「AI」和站点集同名,没有保存。请在这条订阅的改名规则里改掉这个名字,或者给站点集换个名字',
  )
  const nodes = [{ tag: 'HK', subscriptionId: 'a' }]
  assert.equal(saveNameError({ ...base, nodes, groups: [...groups, { id: 'g3', name: 'HK', type: 'selector' }] }, ['group', 'builtin']), '名称「HK」重复:订阅「甲」的节点和节点组同名,不能保存。请换一个名字')
  assert.equal(saveNameError({ ...base, nodes, routing: { policies: [{ id: 'x', name: 'HK', domain: ['a.com'] }] } }, ['policy']), '名称「HK」重复:订阅「甲」的节点和站点集同名,不能保存。请换一个名字')
  assert.equal(saveNameError({ ...base, nodes, chainProxies: [{ id: 'c', name: 'AI', upstream: 'HK', link: 'socks5://1.2.3.4:1080' }] }, ['chain']), '名称「AI」重复:链式代理和站点集同名,不能保存。请换一个名字')
  // 只查这次存的那一类:节点组没撞,站点集和节点撞着(历史状态)不拦存节点组
  assert.equal(saveNameError({ ...base, nodes: [{ tag: 'AI', subscriptionId: 'a' }] }, ['group', 'builtin']), null)
})
