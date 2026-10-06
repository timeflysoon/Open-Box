import assert from 'node:assert/strict'
import test from 'node:test'
import { checkConflictGuard } from './conflict-guard.mjs'
import { PROCESS_ARGS_SCRIPT } from './conflicts.mjs'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'

const paths = createPaths('/opt/open-box')
// 每个参数一行(/proc/*/cmdline 的 \0 换成换行)
const PASSWALL = ['/tmp/etc/passwall/bin/xray', 'run', '-c', '/tmp/etc/passwall/TCP.json'].join('\n')
const OPENBOX = ['/opt/open-box/bin/sing-box', 'run', '-c', '/opt/open-box/etc/config.json'].join('\n')

const setup = ({ installed = ['passwall'], processes = `${OPENBOX}\n${PASSWALL}`, kernelRunning = true, stopResult = { ok: true, code: 0, stderr: '' } } = {}) => {
  const state = { kernelRunning, processes, stops: 0, deployState: null, logs: [] }
  const ctx = createMockContext({
    files: Object.fromEntries(installed.map((name) => [`/etc/init.d/${name}`, '#!/bin/sh\n'])),
    execResults: {
      [`sh -c ${PROCESS_ARGS_SCRIPT}`]: () => ({ code: 0, stdout: state.processes }),
      '/etc/init.d/openbox status': () => ({ code: 0, stdout: state.kernelRunning ? 'running' : 'inactive' }),
    },
  })
  const store = { setDeployState: (s) => { state.deployState = s } }
  const stop = async () => {
    state.stops += 1
    if (stopResult.ok) state.kernelRunning = false
    return stopResult
  }
  const guard = { hits: 0 }
  const check = () => checkConflictGuard({ store, ctx, paths, stop, guard, log: (m) => state.logs.push(m) })
  return { state, ctx, check }
}

test('PassWall 和内核同时在跑:第一次只记一笔,连续第二次才停;停了把部署状态记成 conflict + autoStopped,说清是自动停的', async () => {
  const { state, check } = setup()
  assert.equal((await check()).stopped, false)
  assert.equal(state.stops, 0)
  const r = await check()
  assert.equal(r.stopped, true)
  assert.equal(state.stops, 1)
  assert.equal(state.deployState.stage, 'conflict')
  assert.equal(state.deployState.autoStopped, true)
  assert.equal(state.deployState.message, '检测到 PassWall 和 Open-Box 同时在运行,两个代理工具会互相冲突,已自动停止 Open-Box 内核。要用 Open-Box,请先停用 PassWall(关掉它的主开关或卸载)再启动。')
  assert.match(state.logs.join('\n'), /已自动停止 Open-Box 内核/)
  // 停了之后内核不在跑:不再动作
  assert.equal((await check()).stopped, false)
  assert.equal((await check()).stopped, false)
  assert.equal(state.stops, 1)
})

test('中间有一次没看到(一闪而过)就从头数', async () => {
  const { state, check } = setup()
  await check()
  state.processes = OPENBOX
  await check()
  state.processes = `${OPENBOX}\n${PASSWALL}`
  await check()
  assert.equal(state.stops, 0, '隔了一次没看到,这次只算第一次')
  await check()
  assert.equal(state.stops, 1)
})

test('内核没在跑不停;只装着没在跑不算;一个都没装时一条命令都不跑', async () => {
  const stopped = setup({ kernelRunning: false })
  for (let i = 0; i < 3; i += 1) await stopped.check()
  assert.equal(stopped.state.stops, 0)

  const idle = setup({ processes: OPENBOX })
  for (let i = 0; i < 3; i += 1) await idle.check()
  assert.equal(idle.state.stops, 0)

  const clean = setup({ installed: [] })
  for (let i = 0; i < 3; i += 1) await clean.check()
  assert.equal(clean.state.stops, 0)
  assert.equal(clean.ctx.calls.length, 0, '没装任何代理插件:只看文件在不在,不跑命令')
})

test('停失败(内核到点没退出):不记部署状态,记一笔原因;下两次还在就再试', async () => {
  const { state, check } = setup({ stopResult: { ok: false, code: 1, stderr: '内核在 20 秒内没有退出（running）' } })
  await check()
  const r = await check()
  assert.equal(r.stopped, false)
  assert.equal(state.stops, 1)
  assert.equal(state.deployState, null)
  assert.match(state.logs.join('\n'), /自动停止内核没成功:内核在 20 秒内没有退出/)
  await check()
  await check()
  assert.equal(state.stops, 2)
})
