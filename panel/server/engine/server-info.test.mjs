import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SERVER_NAME, normalizeServerInfo, serverInfoView } from './server-info.mjs'

test('默认名称就是「Open-Box」,不带版本号(用户 2026-10-06)', () => {
  assert.equal(DEFAULT_SERVER_NAME, 'Open-Box')
})

test('发给 App 的路由器标识:空名称换默认、地区没手动选就用判出来的、图标 SVG 先查索引', () => {
  assert.deepEqual(serverInfoView({ serverInfo: undefined }), {
    name: 'Open-Box', icon: '', iconSvg: '', region: '', regionSvg: '', regionAuto: true,
  })
  assert.deepEqual(serverInfoView({ serverInfo: { name: ' 家里 ', region: '' }, detectedRegion: 'cn', iconSvgFor: (code) => `<svg id="${code}"/>` }), {
    name: '家里', icon: '', iconSvg: '', region: 'CN', regionSvg: '<svg id="CN"/>', regionAuto: true,
  })
  const view = serverInfoView({
    serverInfo: { icon: 'brand:x', iconSvg: '<svg id="saved"/>', region: 'HK' },
    detectedRegion: 'CN', iconSvgFor: (code) => (code === 'brand:x' ? '<svg id="index"/>' : ''),
  })
  assert.deepEqual(view, { name: 'Open-Box', icon: 'brand:x', iconSvg: '<svg id="index"/>', region: 'HK', regionSvg: '', regionAuto: false })
  assert.equal(serverInfoView({ serverInfo: { icon: 'brand:y', iconSvg: '<svg id="saved"/>' } }).iconSvg, '<svg id="saved"/>')
})

test('存之前去首尾空白,图标 SVG 原样;没给的字段不带', () => {
  assert.deepEqual(normalizeServerInfo({ name: ' a ', iconSvg: ' <svg/> ', region: 'HK' }), { name: 'a', iconSvg: ' <svg/> ', region: 'HK' })
})
