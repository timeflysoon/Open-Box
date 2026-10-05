import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultServerName, normalizeServerInfo, serverInfoView } from './server-info.mjs'

test('默认名称:「Open-Box v版本号」,版本带不带 v 都一样;读不到版本只写 Open-Box', () => {
  assert.equal(defaultServerName('0.1.280'), 'Open-Box v0.1.280')
  assert.equal(defaultServerName('v0.1.280'), 'Open-Box v0.1.280')
  assert.equal(defaultServerName(''), 'Open-Box')
})

test('发给 App 的路由器标识:空名称换默认、地区没手动选就用判出来的、图标 SVG 先查索引', () => {
  assert.deepEqual(serverInfoView({ serverInfo: undefined, version: '0.1.280' }), {
    name: 'Open-Box v0.1.280', icon: '', iconSvg: '', region: '', regionSvg: '', regionAuto: true,
  })
  assert.deepEqual(serverInfoView({ serverInfo: { name: ' 家里 ', region: '' }, version: '0.1.280', detectedRegion: 'cn', iconSvgFor: (code) => `<svg id="${code}"/>` }), {
    name: '家里', icon: '', iconSvg: '', region: 'CN', regionSvg: '<svg id="CN"/>', regionAuto: true,
  })
  const view = serverInfoView({
    serverInfo: { icon: 'brand:x', iconSvg: '<svg id="saved"/>', region: 'HK' },
    version: '0.1.280', detectedRegion: 'CN', iconSvgFor: (code) => (code === 'brand:x' ? '<svg id="index"/>' : ''),
  })
  assert.deepEqual(view, { name: 'Open-Box v0.1.280', icon: 'brand:x', iconSvg: '<svg id="index"/>', region: 'HK', regionSvg: '', regionAuto: false })
  assert.equal(serverInfoView({ serverInfo: { icon: 'brand:y', iconSvg: '<svg id="saved"/>' }, version: '' }).iconSvg, '<svg id="saved"/>')
})

test('存之前去首尾空白,图标 SVG 原样;没给的字段不带', () => {
  assert.deepEqual(normalizeServerInfo({ name: ' a ', iconSvg: ' <svg/> ', region: 'HK' }), { name: 'a', iconSvg: ' <svg/> ', region: 'HK' })
})
