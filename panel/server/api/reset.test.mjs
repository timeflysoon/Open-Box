import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultRouting, registerResetRoutes } from './reset.mjs'

// 两个破坏性接口:恢复默认分流(只给数据,写回走正常的 PUT /profile)、恢复出厂设置(整表清空)。
// 出厂按用户的要求是"完全回到刚装好的样子":连面板密码、面板设置、流量统计一起清,然后按随包
// 默认重新播种。所以这里盯的是:真的调了整表清空 + 重新播种 + 停内核,而且任何一步不具备时
// 宁可不做也不能做一半。
const fakeApp = () => {
  const routes = new Map()
  return {
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler),
    call: async (key, req = {}) => {
      const handler = routes.get(key)
      assert.ok(handler, `没有注册 ${key}`)
      let status = 200
      let body = null
      const res = {
        status: (code) => { status = code; return res },
        json: (payload) => { body = payload; return res },
      }
      await handler(req, res)
      return { status, body }
    },
  }
}

test('GET /api/openbox/defaults/routing:给出随包默认的那套目标分流(Speed 在最前)', async () => {
  const app = fakeApp()
  registerResetRoutes(app, {})
  const { status, body } = await app.call('GET /api/openbox/defaults/routing')
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.routing.policies) && body.routing.policies.length >= 5)
  assert.equal(body.routing.policies[0].name, 'Speed', '就是随包那份,顺序也一样')
})

test('恢复出厂设置:整表清空 + 按随包默认重新播种 + 停内核', async () => {
  const app = fakeApp()
  let wiped = 0
  let stopped = 0
  registerResetRoutes(app, {
    wipeAll: () => { wiped += 1; return { seeded: 71, profile: true } },
    // stopService 看的是 exec 返回的 code(不是 ok),假 ctx 要照真实形状给
    ctx: { exec: async () => { stopped += 1; return { code: 0, stdout: '', stderr: '' } } },
    paths: { initd: { core: '/etc/init.d/openbox' } },
  })
  const { status, body } = await app.call('POST /api/openbox/factory-reset')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(wiped, 1, '必须真的整表清空(密码、面板设置、统计都在这一张表里)')
  assert.equal(body.profileSeeded, true, '清完要按随包默认把初始目标分流播种回去')
  assert.ok(stopped >= 1, '恢复出厂后内核要停:没有任何节点了,让它带旧配置跑只会让人误以为还在代理')
  assert.equal(body.kernelStopped, true)
})

test('清空这一步不具备时,宁可不做也不做一半(返回 503,不碰任何数据)', async () => {
  const app = fakeApp()
  registerResetRoutes(app, { wipeAll: null })
  const { status } = await app.call('POST /api/openbox/factory-reset')
  assert.equal(status, 503)
})

test('清空过程出错要如实报 500,不能假装成功', async () => {
  const app = fakeApp()
  registerResetRoutes(app, {
    wipeAll: () => { throw new Error('磁盘满了') },
    ctx: { exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
    paths: { initd: { core: '/etc/init.d/openbox' } },
  })
  const { status, body } = await app.call('POST /api/openbox/factory-reset')
  assert.equal(status, 500)
  assert.match(body.message, /磁盘满了/)
})

test('随包默认档案读得到(读不到时两个接口都不该瞎跑)', () => {
  const routing = defaultRouting()
  assert.ok(routing && Array.isArray(routing.policies), '读不到随包默认的话,接口会返回 503 而不是清库')
})

test('GET /api/openbox/defaults/groups:给出随包默认的那两个节点组(所有-自动 / 所有-手动)+ 内置直连', async () => {
  const app = fakeApp()
  registerResetRoutes(app, {})
  const { status, body } = await app.call('GET /api/openbox/defaults/groups')
  assert.equal(status, 200)
  const names = body.groups.map((g) => g.name)
  assert.ok(names.includes('所有-自动') && names.includes('所有-手动'), `默认组不对:${names.join(', ')}`)
  // 和全新安装第一次落地的那份必须是同一个来源,不能在这里另写一份
  const { defaultGroups } = await import('../engine/user-groups.mjs')
  assert.deepEqual(body.groups, defaultGroups())
})
