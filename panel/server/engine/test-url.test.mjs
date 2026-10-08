import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_DIRECT_TEST_URL, DEFAULT_TEST_URL, ensureTestUrlDefaults, expectedQuery, kernelTestUrl, normalizeExpectedStatus, probeKeyUrl } from './test-url.mjs'
import { createStore } from '../store/openbox-store.mjs'

const memStore = () => {
  const m = new Map()
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}

test('kernelTestUrl 保留用户指定的协议、主机、端口、路径和参数，不替换成其他检测地址', () => {
  for (const url of [
    'http://cp.cloudflare.com/generate_204', 'HTTP://example.com:8080/x?q=1',
    'https://cp.cloudflare.com/generate_204', 'http://www.msftconnecttest.com/connecttest.txt',
  ]) assert.equal(kernelTestUrl(` ${url} `), url)
  assert.equal(kernelTestUrl(''), '')
  assert.equal(kernelTestUrl(undefined), '')
  assert.equal(kernelTestUrl('not a url'), 'not a url')
  assert.ok(DEFAULT_TEST_URL.startsWith('http://') && DEFAULT_DIRECT_TEST_URL.startsWith('http://'))
})

test('新档案默认 HTTP；旧版内置 HTTPS 默认迁移为 HTTP，重复启动不再写入', () => {
  const fresh = memStore()
  assert.equal(ensureTestUrlDefaults(fresh), false)
  assert.equal(fresh.getProfile().testUrl, DEFAULT_TEST_URL)
  assert.equal(fresh.getProfile().directTestUrl, DEFAULT_DIRECT_TEST_URL)
  const old = memStore()
  old.setProfile({ testUrl: 'https://www.gstatic.com/generate_204', directTestUrl: 'https://connectivitycheck.platform.hicloud.com/generate_204' })
  assert.equal(ensureTestUrlDefaults(old), true)
  assert.equal(old.getProfile().testUrl, DEFAULT_TEST_URL)
  assert.equal(old.getProfile().directTestUrl, DEFAULT_DIRECT_TEST_URL)
  assert.equal(ensureTestUrlDefaults(old), false)
})

test('保留自定义 HTTP 和 HTTPS 地址；兼容早期直连默认值', () => {
  const custom = memStore()
  custom.setProfile({ testUrl: 'http://cp.cloudflare.com/generate_204', directTestUrl: 'https://example.com/204' })
  assert.equal(ensureTestUrlDefaults(custom), false)
  assert.equal(custom.getProfile().testUrl, 'http://cp.cloudflare.com/generate_204')
  assert.equal(custom.getProfile().directTestUrl, 'https://example.com/204')
  custom.setProfile({ directTestUrl: 'http://www.msftconnecttest.com/connecttest.txt' })
  assert.equal(ensureTestUrlDefaults(custom), true)
  assert.equal(custom.getProfile().directTestUrl, DEFAULT_DIRECT_TEST_URL)
})

// 和内核 common/urltest/expected.go(tcp19)同一套写法:空 / * 不限;状态码或范围用 / 或 , 隔开
test('可接受状态码:规范写法和内核一致,写法不对回 null', () => {
  for (const [raw, want] of [
    [undefined, ''], [null, ''], ['', ''], ['*', ''], [' * ', ''],
    ['204', '204'], ['200/204', '200/204'], ['200-299/302', '200-299/302'], [' 200 - 399 , 418 ', '200-399/418'],
    ['200-200', '200'], ['100-599', '100-599'], ['200-299,,302', '200-299/302'],
  ]) assert.equal(normalizeExpectedStatus(raw), want, String(raw))
  for (const raw of ['abc', '99', '600', '300-200', '/', ',', '200-', '-200', '!200', '0200', '2OO', 204, {}]) {
    assert.equal(normalizeExpectedStatus(raw), null, String(raw))
  }
  // 测速去重的键:不限时就是地址本身(和以前一样),限了带上规范写法
  assert.equal(probeKeyUrl('http://a.test/', ''), 'http://a.test/')
  assert.equal(probeKeyUrl('http://a.test/', '200-399'), 'http://a.test/ expected=200-399')
  assert.equal(expectedQuery(''), '')
  assert.equal(expectedQuery('200-399/204'), '&expected=200-399%2F204')
})
