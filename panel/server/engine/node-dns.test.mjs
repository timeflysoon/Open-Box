import assert from 'node:assert/strict'
import test from 'node:test'
import { nodeDnsServers, normalizeNodeDns, planNodeDns, validateNodeDns, withNodeResolver } from './node-dns.mjs'

test('validateNodeDns:只收 https DoH;地址是域名时 bootstrap 必填且只收 IP;空的就是不用', () => {
  assert.equal(validateNodeDns(undefined), null)
  assert.equal(validateNodeDns(null), null)
  assert.equal(validateNodeDns({ url: '' }), null)
  assert.equal(validateNodeDns({ url: 'https://dns.example.net:2096/p/abc', bootstrap: '223.5.5.5' }), null)
  assert.equal(validateNodeDns({ url: 'https://1.1.1.1/dns-query' }), null, 'DoH 是 IP 时不要 bootstrap')
  assert.match(validateNodeDns({ url: 'https://dns.example.net/dns-query' }), /bootstrap is required/)
  assert.match(validateNodeDns({ url: 'http://dns.example.net/q', bootstrap: '1.1.1.1' }), /https/)
  assert.match(validateNodeDns({ url: 'tls://dns.example.net', bootstrap: '1.1.1.1' }), /https/)
  assert.match(validateNodeDns({ url: 'https://u:p@dns.example.net/q', bootstrap: '1.1.1.1' }), /https/)
  assert.match(validateNodeDns({ url: 'https://dns.example.net/q', bootstrap: 'dns.google' }), /bootstrap must be an IP/)
  assert.match(validateNodeDns({ url: '', bootstrap: '1.1.1.1' }), /url is required/)
  assert.match(validateNodeDns('https://x'), /must be an object/)
})

test('nodeDnsServers:域名 DoH 一台 + bootstrap 一台;端口 / 路径是默认值时不写;IP 形态不带 bootstrap', () => {
  const p = nodeDnsServers({ url: 'https://dns.example.net:2096/p/abc?x=1', bootstrap: '223.5.5.5' }, 'sub-1')
  assert.equal(p.tag, 'dns-sub-sub-1')
  assert.deepEqual(p.servers, [
    { type: 'https', tag: 'dns-sub-sub-1', server: 'dns.example.net', server_port: 2096, path: '/p/abc?x=1', domain_resolver: 'dns-sub-sub-1-bootstrap' },
    { type: 'udp', tag: 'dns-sub-sub-1-bootstrap', server: '223.5.5.5' },
  ])
  assert.deepEqual(nodeDnsServers({ url: 'https://1.1.1.1/dns-query' }, 'a b/c').servers, [{ type: 'https', tag: 'dns-sub-a_b_c', server: '1.1.1.1' }])
  assert.equal(nodeDnsServers(null, 'x'), null)
  assert.equal(nodeDnsServers({ url: 'https://dns.example.net/q' }, 'x'), null, '缺 bootstrap 的不生成')
  assert.deepEqual(normalizeNodeDns({ url: ' https://1.1.1.1/dns-query ', bootstrap: '' }), { url: 'https://1.1.1.1/dns-query' })
})

test('planNodeDns / withNodeResolver:停用的订阅不算;服务器是 IP 的出站不带解析器', () => {
  const plan = planNodeDns([
    { id: 'a', nodeDns: { url: 'https://dns.example.net/q', bootstrap: '1.1.1.1' } },
    { id: 'b', enabled: false, nodeDns: { url: 'https://dns.example.org/q', bootstrap: '1.1.1.1' } },
    { id: 'c' },
  ])
  assert.deepEqual([...plan.bySubscription.entries()], [['a', 'dns-sub-a']])
  assert.deepEqual(plan.servers.map((s) => s.tag), ['dns-sub-a', 'dns-sub-a-bootstrap'])
  assert.equal(withNodeResolver({ type: 'anytls', server: 'hk.node.example' }, 'dns-sub-a').domain_resolver, 'dns-sub-a')
  assert.equal(withNodeResolver({ type: 'anytls', server: '203.0.113.9' }, 'dns-sub-a').domain_resolver, undefined)
  assert.equal(withNodeResolver({ type: 'anytls', server: 'hk.node.example' }, undefined).domain_resolver, undefined)
})
