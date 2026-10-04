import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DNS_PROTOCOLS, dnsPortOr, dnsProtocolOr, dnsServerEntry, isValidDnsPort, isValidDnsUpstream, normalizeDnsUpstream } from './dns-upstream.mjs'

test('isValidDnsUpstream:只认 IPv4 / IPv6;域名、带协议、端口、路径、空白、未指定地址都不过', () => {
  for (const ok of ['223.5.5.5', '1.1.1.1', '2400:3200::1', '2001:db8::1', '192.168.3.5']) {
    assert.equal(isValidDnsUpstream(ok), true, ok)
  }
  for (const bad of ['', ' ', 'dns.google', 'router.lan', 'https://1.1.1.1/dns-query', '223.5.5.5:53', '1.1.1.1/dns-query', '256.1.1.1', '0.0.0.0', '::', 'a b', 'tls://dns.google', 1, null, undefined]) {
    assert.equal(isValidDnsUpstream(bad), false, String(bad))
  }
})

test('协议表只有 udp / tcp（带域名的 DoT / DoH 不做）;不认识的协议按兜底;条目按 sing-box 1.12+ 的 server 对象写,端口不写', () => {
  assert.deepEqual([...DNS_PROTOCOLS], ['udp', 'tcp'])
  assert.equal(dnsProtocolOr('tcp', 'udp'), 'tcp')
  assert.equal(dnsProtocolOr('tls', 'udp'), 'udp')
  assert.equal(dnsProtocolOr('doh', 'udp'), 'udp')
  assert.equal(dnsProtocolOr(undefined, 'tcp'), 'tcp')
  assert.deepEqual(dnsServerEntry({ protocol: 'tcp', server: '1.1.1.1' }, 'dns-proxy', '其他'), { type: 'tcp', tag: 'dns-proxy', server: '1.1.1.1', detour: '其他' })
  assert.deepEqual(dnsServerEntry({ protocol: 'udp', server: '223.5.5.5' }, 'dns-direct'), { type: 'udp', tag: 'dns-direct', server: '223.5.5.5' })
  // 端口:默认 53 不写 server_port,改了才写;不合法的按默认
  assert.deepEqual(dnsServerEntry({ protocol: 'udp', server: '223.5.5.5', port: 53 }, 'dns-direct'), { type: 'udp', tag: 'dns-direct', server: '223.5.5.5' })
  assert.deepEqual(dnsServerEntry({ protocol: 'tcp', server: '192.168.3.5', port: 5353 }, 'dns-direct'), { type: 'tcp', tag: 'dns-direct', server: '192.168.3.5', server_port: 5353 })
  assert.equal(isValidDnsPort(5353), true)
  for (const bad of [0, 65536, -1, 1.5, '53', undefined, null]) assert.equal(isValidDnsPort(bad), false, String(bad))
  assert.equal(dnsPortOr(undefined), 53)
  assert.equal(dnsPortOr(853), 853)
})

test('normalizeDnsUpstream:老档案的 DoH / DoT 链接折成主机 IP,域名折成空串,方括号 v6 去括号,裸地址去空白原样', () => {
  assert.equal(normalizeDnsUpstream('https://1.1.1.1/dns-query'), '1.1.1.1')
  assert.equal(normalizeDnsUpstream('https://dns.google/dns-query'), '')
  assert.equal(normalizeDnsUpstream('tls://8.8.8.8'), '8.8.8.8')
  assert.equal(normalizeDnsUpstream('https://[2001:4860:4860::8888]/dns-query'), '2001:4860:4860::8888')
  assert.equal(normalizeDnsUpstream('[2400:3200::1]'), '2400:3200::1')
  assert.equal(normalizeDnsUpstream('  223.5.5.5 '), '223.5.5.5')
  assert.equal(normalizeDnsUpstream('223.5.5.5'), '223.5.5.5')
  assert.equal(normalizeDnsUpstream('not a host'), '')
  assert.equal(normalizeDnsUpstream(''), '')
  assert.equal(normalizeDnsUpstream(undefined), '')
})
