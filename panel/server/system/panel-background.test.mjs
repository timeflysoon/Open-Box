import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createStore } from '../store/openbox-store.mjs'
import { panelBackground, panelBackgroundMeta } from './panel-background.mjs'
import { BACKGROUND_IMAGE_KEY } from './seed-defaults.mjs'

const memStore = (entries = {}) => {
  const m = new Map(Object.entries(entries))
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}
const sha16 = (v) => createHash('sha256').update(v).digest('hex').slice(0, 16)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const uploaded = (extra = {}) => memStore({
  'config/custom-background-image': 'local-image-1788361724032',
  [BACKGROUND_IMAGE_KEY]: `data:image/jpeg;base64,${JPEG.toString('base64')}`,
  ...extra,
})

test('没设背景、上传的图没了 / 不是图片 data URL、设置不是 http 网址:都是 null', () => {
  assert.equal(panelBackground(memStore()), null)
  assert.equal(panelBackground(memStore({ 'config/custom-background-image': '' })), null)
  assert.equal(panelBackground(memStore({ 'config/custom-background-image': 'local-image-1' })), null)
  assert.equal(panelBackground(uploaded({ [BACKGROUND_IMAGE_KEY]: 'data:text/html;base64,PGI+' })), null)
  assert.equal(panelBackground(memStore({ 'config/custom-background-image': 'javascript:alert(1)' })), null)
  assert.equal(panelBackgroundMeta(null), null)
})

test('上传的图:version 跟图片字节走;透明度 / 模糊读面板设置,没存过用面板默认 90 / 10,越界夹住', () => {
  const bg = panelBackground(uploaded({ 'config/dashboard-transparent': '84', 'config/blur-intensity': '16' }))
  assert.deepEqual(panelBackgroundMeta(bg), { version: sha16(JPEG), transparent: 84, blur: 16 })
  assert.deepEqual(bg.image, { type: 'image/jpeg', bytes: JPEG })
  assert.deepEqual(panelBackgroundMeta(panelBackground(uploaded())), { version: sha16(JPEG), transparent: 90, blur: 10 })
  const clamped = panelBackground(uploaded({ 'config/dashboard-transparent': '130', 'config/blur-intensity': '-3' }))
  assert.equal(clamped.transparent, 100)
  assert.equal(clamped.blur, 0)
  assert.equal(panelBackground(uploaded({ 'config/blur-intensity': '80' })).blur, 39, '面板只有 blur-intensity-0 ~ 39')
  // 换一张图 version 就变,透明度 / 模糊不影响 version(App 不用为它们重新下图)
  const other = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  assert.equal(panelBackground(uploaded({ [BACKGROUND_IMAGE_KEY]: `data:image/png;base64,${other.toString('base64')}` })).version, sha16(other))
  assert.equal(panelBackground(uploaded({ 'config/dashboard-transparent': '50' })).version, sha16(JPEG))
})

test('首次启动写进去的默认背景图能解出来', () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../defaults/background-image.txt')
  const bg = panelBackground(uploaded({ [BACKGROUND_IMAGE_KEY]: fs.readFileSync(file, 'utf8') }))
  assert.equal(bg.image.type, 'image/jpeg')
  assert.deepEqual([...bg.image.bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG 文件头')
})

test('网址:照面板拼 ?v=路由器当天日期,version 每天换一次', () => {
  const store = memStore({ 'config/custom-background-image': 'https://example.com/bg.jpg', 'config/dashboard-transparent': '75', 'config/blur-intensity': '7' })
  const day = panelBackground(store, new Date(2026, 9, 5, 8, 0))
  assert.equal(day.url, 'https://example.com/bg.jpg?v=2026-10-05')
  assert.deepEqual(panelBackgroundMeta(day), { version: sha16('https://example.com/bg.jpg?v=2026-10-05'), transparent: 75, blur: 7 })
  assert.equal(panelBackground(store, new Date(2026, 9, 5, 23, 59)).version, day.version)
  assert.notEqual(panelBackground(store, new Date(2026, 9, 6, 0, 1)).version, day.version)
})

test('导出文件(withData)才带上传的图;网址没有图片字节可带', () => {
  const bg = panelBackground(uploaded())
  assert.equal(panelBackgroundMeta(bg).data, undefined)
  assert.equal(panelBackgroundMeta(bg, { withData: true }).data, JPEG.toString('base64'))
  const remote = panelBackground(memStore({ 'config/custom-background-image': 'http://192.168.3.9/bg.png' }))
  assert.equal(panelBackgroundMeta(remote, { withData: true }).data, undefined)
})
