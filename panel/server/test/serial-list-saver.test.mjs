import assert from 'node:assert/strict'
import test from 'node:test'
// 前端的组合函数只用了类型导入,Node 24 直接去掉类型就能跑
import { useSerialListSaver } from '../../src/composables/serialListSaver.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 模拟页面:server 是服务端存的,rows 是界面绑的那份;保存 / 拉取都走「网络」(有延迟)
const page = ({ saveMs = 30, reloadMs = 30, failSaves = 0, failReload = false } = {}) => {
  const state = { server: ['S0'], errors: 0, reloads: 0, saves: [] }
  const rows = { value: ['S0'] }
  let failuresLeft = failSaves
  const { persist } = useSerialListSaver({
    list: rows,
    save: async (next) => {
      const sent = [...next]
      await sleep(saveMs)
      if (failuresLeft > 0) { failuresLeft--; state.saves.push(`失败 ${sent}`); throw new Error('保存失败') }
      state.server = sent
      state.saves.push(`成功 ${sent}`)
      return [...sent]
    },
    reload: async () => {
      state.reloads++
      const snapshot = [...state.server]
      await sleep(reloadMs)
      if (failReload) throw new Error('拉取失败')
      return snapshot
    },
    apply: (saved) => { rows.value = [...saved] },
    onError: () => { state.errors++ },
  })
  return { state, rows, persist }
}

test('前面那条失败、后面还有改动在排队:不提示、不拉服务端的旧数据盖界面,排队那条带着整份存上(GPT 复核第二项)', async () => {
  const { state, rows, persist } = page({ failSaves: 1, reloadMs: 200 })
  void persist(['A'])
  await sleep(5)
  const last = persist(['A', 'B'])
  await last
  await sleep(250)
  assert.deepEqual(state.server, ['A', 'B'])
  assert.deepEqual(rows.value, ['A', 'B'], '界面不能被盖回旧数据')
  assert.equal(state.errors, 0)
  assert.equal(state.reloads, 0)
  assert.deepEqual(state.saves, ['失败 A', '成功 A,B'])
})

test('最后一条失败:提示一次,按服务端内容刷新界面', async () => {
  const { state, rows, persist } = page({ failSaves: 1 })
  await persist(['A'])
  assert.equal(state.errors, 1)
  assert.equal(state.reloads, 1)
  assert.deepEqual(rows.value, ['S0'])
  assert.deepEqual(state.server, ['S0'])
})

test('失败后拉取的这会儿又改了:拉回来的不覆盖,新改动带着整份存上', async () => {
  const { state, rows, persist } = page({ failSaves: 1, reloadMs: 100 })
  void persist(['A'])
  await sleep(50) // 保存 A 已经失败,正在拉取
  assert.equal(state.reloads, 1)
  await persist([...rows.value, 'C'])
  assert.deepEqual(state.server, ['A', 'C'])
  assert.deepEqual(rows.value, ['A', 'C'])
  assert.equal(state.errors, 1)
})

test('拉取也失败:保持本地那份,后面的保存照常', async () => {
  const { state, rows, persist } = page({ failSaves: 1, failReload: true })
  await persist(['A'])
  assert.deepEqual(rows.value, ['A'])
  await persist(['A', 'B'])
  assert.deepEqual(state.server, ['A', 'B'])
  assert.deepEqual(rows.value, ['A', 'B'])
})

test('连着改:轮到时后面还有更新的就不发,只发最后一条;已经在路上的那条照常存完', async () => {
  let p = page()
  void p.persist(['A'])
  void p.persist(['A', 'B'])
  await p.persist(['A', 'B', 'C'])
  assert.deepEqual(p.state.saves, ['成功 A,B,C'])
  assert.deepEqual(p.rows.value, ['A', 'B', 'C'])

  p = page()
  void p.persist(['A'])
  await sleep(5) // A 已经发出去了
  void p.persist(['A', 'B'])
  await p.persist(['A', 'B', 'C'])
  assert.deepEqual(p.state.saves, ['成功 A', '成功 A,B,C'])
  assert.deepEqual(p.rows.value, ['A', 'B', 'C'])
})
