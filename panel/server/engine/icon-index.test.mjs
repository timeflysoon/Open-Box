import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { buildIconIndex, encodeIconIndex } from '../../scripts/gen-icon-index.mjs'
import { ICON_INDEX_FILE, iconsFor, loadIconIndex, normalizeIconCode } from './icon-index.mjs'

test('随包的图标索引和前端图标源文件一致(改了图标要重跑 scripts/gen-icon-index.mjs)', () => {
  const fresh = encodeIconIndex(buildIconIndex())
  assert.ok(fs.readFileSync(ICON_INDEX_FILE).equals(fresh), 'resources/icons.json.gz 过期了:node scripts/gen-icon-index.mjs')
})

test('四类图标都在,键的写法和前端一致', () => {
  const index = loadIconIndex()
  assert.match(index.HK, /^<svg/)
  assert.match(index['globe:earth-meridians'], /^<svg/)
  assert.match(index['misc:pin'], /^<svg/)
  // 彩色公司标识是原文;单色的按 helper/iconUrl.ts 拼成 24x24、用品牌色填
  assert.match(index['brand:google'], /^<svg/)
  assert.match(index['brand:huggingface'], /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24"><path fill="#FFD21E" d="/)
})

test('按代码取:写法不分大小写,只回用到的,不认识的没有', () => {
  assert.equal(normalizeIconCode(' hk '), 'HK')
  assert.equal(normalizeIconCode('Globe:Asia'), 'globe:asia')
  assert.equal(normalizeIconCode('BRAND:Google'), 'brand:google')
  assert.equal(normalizeIconCode(''), '')
  const picked = iconsFor(['hk', 'brand:Google', 'misc:pin', 'misc:pin', 'brand:no-such-brand', '', null])
  assert.deepEqual(Object.keys(picked).sort(), ['HK', 'brand:google', 'misc:pin'])
  // 索引读不到时当没有图标
  assert.deepEqual(iconsFor(['HK'], loadIconIndex('/nonexistent/icons.json.gz')), {})
})
