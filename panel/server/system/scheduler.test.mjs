import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { runScheduledTasks } from './scheduler.mjs'

const paths = createPaths('/opt/open-box')

// 定时自动更新:探到的最新版本号要交给升级脚本(--expect)。不交的话脚本自己再探一次,国内直连不通时拿不到,
// 就退回会动的 releases/latest/download,镜像缓存的旧包也照装(审查第六项)
const run = async ({ current = 'v0.1.265', latest = 'v0.1.266' } = {}) => {
  const now = new Date(2026, 8, 30, 4, 10)
  const ctx = createMockContext({ files: { [paths.metaPath]: JSON.stringify({ version: current }) } })
  const store = { getProfile: () => ({ updates: { openbox: { auto: true, hour: 4, days: 1, channel: 'mirror' } } }) }
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'HEAD')
    return { status: 302, url, headers: new Headers({ location: `https://github.com/timeflysoon/Open-Box/releases/tag/${latest}` }) }
  }
  const logs = []
  await runScheduledTasks({ store, ctx, paths, fetchImpl, now, log: (m) => logs.push(m) })
  return { calls: ctx.calls.filter((c) => c.cmd === 'sh'), logs }
}

test('定时自动更新:有新版本就带着探到的版本号启动升级脚本(--expect)', async () => {
  const { calls, logs } = await run()
  assert.equal(calls.length, 1, logs.join('\n'))
  assert.deepEqual(calls[0].args, [paths.updateScript, '--detach', '--mirror', '--expect', 'v0.1.266'])
})

test('定时自动更新:已是最新就不启动升级', async () => {
  const { calls } = await run({ current: 'v0.1.266', latest: 'v0.1.266' })
  assert.equal(calls.length, 0)
})
