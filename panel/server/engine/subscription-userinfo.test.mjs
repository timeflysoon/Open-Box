import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSubscriptionUserinfo, userinfoFromHeaders } from './subscription-userinfo.mjs'

test('subscription-userinfo:四项都在、缺项、乱值、空头', () => {
  assert.deepEqual(parseSubscriptionUserinfo('upload=123; download=456; total=107374182400; expire=1735660800'), { upload: 123, download: 456, total: 107374182400, expire: 1735660800 })
  assert.deepEqual(parseSubscriptionUserinfo('Upload=1;download=2'), { upload: 1, download: 2, total: null, expire: null })
  assert.deepEqual(parseSubscriptionUserinfo('upload=abc; total=-5; expire=1.9e9'), { upload: null, download: null, total: null, expire: 1900000000 })
  assert.equal(parseSubscriptionUserinfo('foo=1'), null)
  assert.deepEqual(parseSubscriptionUserinfo('upload=0; download=0; total=0; expire=0'), { upload: 0, download: 0, total: null, expire: null }, 'total / expire 写 0 当作没给,不显示 1970-01-01 到期')
  assert.equal(parseSubscriptionUserinfo(''), null)
  assert.equal(parseSubscriptionUserinfo(undefined), null)
})

test('从 Response 的 headers.get 或普通对象里取', () => {
  assert.deepEqual(userinfoFromHeaders({ get: (n) => (n === 'subscription-userinfo' ? 'upload=1; download=2; total=3' : null) }), { upload: 1, download: 2, total: 3, expire: null })
  assert.deepEqual(userinfoFromHeaders({ 'Subscription-Userinfo': 'download=9' }), { upload: null, download: 9, total: null, expire: null })
  assert.equal(userinfoFromHeaders({ get: () => null }), null)
  assert.equal(userinfoFromHeaders(null), null)
})
