import assert from 'node:assert/strict'
import test from 'node:test'
import { detectChallenge, parseHeaderBlock, pickProbeHeaders } from './http-challenge.mjs'

test('响应头解析:名字小写、取第一个、忽略坏行;只挑判定用的几个头', () => {
  const h = parseHeaderBlock('Server: cloudflare\r\nCF-Mitigated: challenge\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nbadline\r\ncf-ray: a3ab-LHR\r\n')
  assert.equal(h.server, 'cloudflare'); assert.equal(h['cf-mitigated'], 'challenge'); assert.equal(h['set-cookie'], 'a=1')
  assert.deepEqual(pickProbeHeaders(h), { server: 'cloudflare', 'cf-mitigated': 'challenge', 'cf-ray': 'a3ab-LHR' })
})

test('只有 cf-mitigated: challenge 才算人机验证;普通的 Cloudflare 403 不算', () => {
  assert.equal(detectChallenge(403, { server: 'cloudflare', 'cf-mitigated': 'challenge' }), 'cloudflare')
  assert.equal(detectChallenge(503, { 'cf-mitigated': 'Challenge' }), 'cloudflare')
  assert.equal(detectChallenge(403, { server: 'cloudflare' }), '')
  assert.equal(detectChallenge(403, null), '')
  assert.equal(detectChallenge(200, { 'cf-mitigated': 'challenge' }), 'cloudflare', '状态码不参与判定,有标记就是')
})
