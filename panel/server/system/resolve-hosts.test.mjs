import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import test from 'node:test'
import { isResolverServer, resolveHostsToCidrs } from './resolve-hosts.mjs'

test('resolveHostsToCidrs:v4 → /32、v6 → /128,去重;失败 / 超时的域名跳过,不影响其它', async () => {
  const lookup = async (host) => {
    if (host === 'a.test') return [{ address: '1.2.3.4', family: 4 }, { address: '2001:db8::1', family: 6 }]
    if (host === 'b.test') return [{ address: '1.2.3.4', family: 4 }]
    if (host === 'slow.test') return new Promise(() => {})
    throw new Error('NXDOMAIN')
  }
  const r = await resolveHostsToCidrs(['a.test', 'b.test', 'slow.test', 'nx.test', '', 'A.TEST'], { lookup, timeoutMs: 50 })
  assert.deepEqual(r.sort(), ['1.2.3.4/32', '2001:db8::1/128'])
})

test('resolveHostsToCidrs:没有域名 → 空数组', async () => {
  assert.deepEqual(await resolveHostsToCidrs([], { lookup: async () => { throw new Error('no') } }), [])
})

test('resolveHostsToCidrs:传了 lookup 就用它;servers 里非 IP 的项被丢掉,不影响解析', async () => {
  const seen = []
  const lookup = async (host) => { seen.push(host); return [{ address: '9.9.9.9', family: 4 }] }
  const r = await resolveHostsToCidrs(['x.test'], { servers: ['not-an-ip', '211.139.29.150'], lookup, timeoutMs: 100 })
  assert.deepEqual(r, ['9.9.9.9/32'])
  assert.deepEqual(seen, ['x.test'])
})

test('resolveHostsToCidrs:servers 里只有 fe80::1%wan6 这种不能用的地址时不抛错（以前 setServers 同步抛错让整次部署失败）', async () => {
  const cidrs = await resolveHostsToCidrs(['example.invalid'], { servers: ['fe80::1%wan6', 'garbage'], timeoutMs: 1500 })
  assert.deepEqual(cidrs, [])
})

test('isResolverServer:裸 IP 和不在 53 端口时的 ip:port / [ipv6]:port 都认;域名、坏端口、没端口的方括号不认', () => {
  for (const ok of ['223.5.5.5', '2400:3200::1', '223.5.5.5:5353', '[2400:3200::1]:5300']) assert.equal(isResolverServer(ok), true, ok)
  for (const bad of ['dns.alidns.com', 'dns.alidns.com:53', '223.5.5.5:0', '223.5.5.5:70000', '[2400:3200::1]', '', null]) assert.equal(isResolverServer(bad), false, String(bad))
})

test('resolveHostsToCidrs:直连 DNS 不在 53 端口(ip:port)也照样问它', async () => {
  // 只会答 A 的最小 DNS 服务:问什么都回 10.9.8.7,AAAA 回空
  const sock = dgram.createSocket('udp4')
  sock.on('message', (msg, rinfo) => {
    let end = 12
    while (msg[end] !== 0) end += msg[end] + 1
    const qtype = msg.readUInt16BE(end + 1)
    const question = msg.subarray(12, end + 5)
    const header = Buffer.from([msg[0], msg[1], 0x81, 0x80, 0, 1, 0, qtype === 1 ? 1 : 0, 0, 0, 0, 0])
    const answer = qtype === 1 ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 9, 8, 7]) : Buffer.alloc(0)
    sock.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address)
  })
  await new Promise((r) => sock.bind(0, '127.0.0.1', r))
  try {
    const cidrs = await resolveHostsToCidrs(['node.example'], { servers: [`127.0.0.1:${sock.address().port}`], timeoutMs: 2000 })
    assert.deepEqual(cidrs, ['10.9.8.7/32'])
  } finally {
    sock.close()
  }
})
