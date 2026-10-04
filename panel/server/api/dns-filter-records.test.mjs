import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import express from 'express'
import { registerDnsFilterRoutes } from './dns-filter.mjs'

// 「域名解析查询」的终端设备一栏:按来源 IP 补 DHCP 主机名、标出路由器自己的地址(和流量表的终端同一套)
test('records carry the DHCP hostname and router-own marker for each source', async (t) => {
  const rows = [
    { id: 3, at: 1, domain: 'a.example', qtype: 'A', source: '192.168.1.20', result: 'allowed', list: '', elapsed: 5 },
    { id: 2, at: 1, domain: 'b.example', qtype: 'A', source: '127.0.0.1', result: 'allowed', list: '', elapsed: 5 },
    { id: 1, at: 1, domain: 'c.example', qtype: 'AAAA', source: '192.168.1.1', result: 'blocked', list: 'ads', elapsed: null },
  ]
  let query = null
  const deps = {
    store: { getProfile: () => ({ dns: { filter: { enabled: true, lists: [], allowDomains: [] } } }), getRaw: () => '{}' },
    ctx: {
      readFile: async (path) => {
        assert.equal(path, '/tmp/dhcp.leases')
        return '1700000000 aa:bb:cc:dd:ee:01 192.168.1.20 phone-a *\n1700000000 aa:bb:cc:dd:ee:02 192.168.1.21 * *\n'
      },
      exec: async (cmd, args) => {
        if (cmd === 'ip' && args[0] === '-4') return { code: 0, stdout: '5: br-lan    inet 192.168.1.1/24 brd 192.168.1.255 scope global br-lan\n' }
        return { code: 1, stdout: '' }
      },
    },
    paths: { dhcpLeases: '/tmp/dhcp.leases' },
    data: { records: (q) => { query = q; return { page: 1, pageSize: 20, total: rows.length, rows } } },
    observer: { status: () => ({}) },
  }
  const app = express()
  registerDnsFilterRoutes(app, deps)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/openbox/dns-filter/records?search=example&result=&page=1&pageSize=20`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(query.search, 'example')
  assert.equal(body.total, 3)
  assert.deepEqual(body.rows.map((r) => [r.source, r.name, r.self?.iface || '']), [
    ['192.168.1.20', 'phone-a', ''],
    ['127.0.0.1', '', ''],
    ['192.168.1.1', '', 'br-lan'],
  ])
})
