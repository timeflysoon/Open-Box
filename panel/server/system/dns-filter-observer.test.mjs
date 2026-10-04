import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createDnsEventParser, createDnsFilterStore } from './dns-filter-observer.mjs'

test('native DNS events count requests once, identify filter vs policy, and retain real duration', () => {
  const db = new DatabaseSync(':memory:')
  const now = () => 1700000000000
  const data = createDnsFilterStore(db, { now })
  const parser = createDnsEventParser({ data, now, rules: [{ rule_set: ['ads'], action: 'predefined', rcode: 'NXDOMAIN' }], names: { ads: 'anti-AD' } })
  const send = (payload) => parser.accept({ payload })
  send('[1 0ms] inbound/direct[dns-in]: inbound packet connection from 192.168.3.100:56000')
  send('[1 0ms] dns: exchange ads.test. IN A')
  send('[1 0ms] dns: match[0] rule_set=ads => predefined(NXDOMAIN)')
  send('[2 10ms] dns: exchange good.test. IN AAAA')
  send('[2 34ms] dns: exchanged good.test NOERROR 60')
  send('[2 34ms] dns: exchanged AAAA good.test. 60 IN AAAA ::1')
  send('[3 0ms] dns: exchange good.test. IN A')
  send('[3 2ms] dns: cached good.test NOERROR 58')
  send('[4 0ms] dns: exchange fail.test. IN A')
  send('[4 10ms] dns: exchange failed for fail.test. IN A: timeout')
  const summary = data.summary()
  assert.equal(summary.queries, 4)
  assert.equal(summary.blocked, 1)
  assert.equal(summary.timed, 3)
  assert.equal(summary.elapsed, 36)
  const blocked = data.records({ result: 'blocked' })
  assert.equal(blocked.total, 1)
  assert.equal(blocked.rows[0].source, '192.168.3.100')
  assert.equal(blocked.rows[0].list, 'anti-AD')
  assert.deepEqual(summary.topDomains.map((r) => [r.domain, r.count]), [['ads.test', 1]])
  db.close()
})

test('ambiguous parallel completions and disconnected queries do not invent timings or blocks', () => {
  const rows = [], started = []
  const parser = createDnsEventParser({ data: { start: (q) => started.push(q), finish: (q) => rows.push(q) } })
  for (const payload of ['[1 0ms] dns: exchange same.test. IN A', '[1 0ms] dns: exchange same.test. IN AAAA', '[1 25ms] dns: exchanged same.test NOERROR 60']) parser.accept({ payload })
  parser.drain()
  assert.equal(started.length, 2)
  assert.equal(rows[0].elapsed, null)
  assert.equal(rows[1].result, 'unknown')
  assert.equal(rows[1].elapsed, null)
})

test('core duration hundredths and retained hourly statistics survive reopening the collector', () => {
  const db = new DatabaseSync(':memory:')
  let at = 1700000000000
  let data = createDnsFilterStore(db, { now: () => at })
  const parser = createDnsEventParser({ data, now: () => at })
  parser.accept({ payload: '[9 0ms] dns: exchange slow.test. IN A' })
  parser.accept({ payload: '[9 1.5s] dns: exchanged slow.test NOERROR 60' })
  data.flush()
  data = createDnsFilterStore(db, { now: () => at })
  assert.equal(data.summary().queries, 1)
  assert.equal(data.summary().averageMs, 1050)
  assert.equal(data.records({ search: 'slow.test', page: '1.1' }).total, 1)
  at += 25 * 3600000
  assert.equal(data.summary().queries, 0)
  assert.equal(data.records().total, 0)
  db.close()
})

const recordFixture = (t, count) => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const at = 1700000000000
  const data = createDnsFilterStore(db, { now: () => at })
  for (let i = 1; i <= count; i++) {
    data.start(at)
    data.finish({ at, domain: `${i % 2 ? 'ad' : 'site'}${i}.example.test`, qtype: 'A', result: i % 2 ? 'blocked' : 'allowed', elapsed: 1 })
  }
  data.flush()
  return { db, data }
}

test('DNS records default to 20 rows and page without overlaps at preset and custom sizes', (t) => {
  const { data } = recordFixture(t, 137)
  const first = data.records()
  assert.equal(first.pageSize, 20)
  assert.equal(first.page, 1)
  assert.equal(first.total, 137)
  assert.equal(first.rows.length, 20)
  assert.equal(first.rows[0].id, 137)
  assert.equal(first.rows.at(-1).id, 118)
  for (const size of [20, 50, 100, 37]) {
    const ids = []
    for (let page = 1; page <= Math.ceil(137 / size); page++) {
      const result = data.records({ page: String(page), pageSize: String(size) })
      assert.equal(result.page, page)
      assert.equal(result.pageSize, size)
      assert.equal(result.total, 137)
      assert.equal(result.rows.length, Math.min(size, 137 - (page - 1) * size))
      ids.push(...result.rows.map((row) => row.id))
    }
    assert.deepEqual(ids, Array.from({ length: 137 }, (_, i) => 137 - i))
  }
})

test('DNS record page bounds use the filtered total and recover after records disappear', (t) => {
  const { db, data } = recordFixture(t, 137)
  const filtered = data.records({ search: 'AD', result: 'blocked', page: 2, pageSize: 20 })
  assert.equal(filtered.total, 69)
  assert.equal(filtered.rows[0].id, 97)
  assert.equal(filtered.rows.at(-1).id, 59)
  assert.ok(filtered.rows.every((row) => row.result === 'blocked'))
  const empty = data.records({ search: 'not-present', page: 99, pageSize: 50 })
  assert.deepEqual(empty, { total: 0, page: 1, pageSize: 50, rows: [] })
  const last = data.records({ page: 999, pageSize: 20 })
  assert.equal(last.page, 7)
  assert.equal(last.rows.length, 17)
  db.exec('DELETE FROM dns_filter_records WHERE id > 20')
  const refreshed = data.records({ page: 7, pageSize: 20 })
  assert.equal(refreshed.page, 1)
  assert.equal(refreshed.total, 20)
  assert.equal(refreshed.rows.length, 20)
})

test('DNS record pagination bounds invalid sizes and allows pages beyond 1000 at one row per page', (t) => {
  const { data } = recordFixture(t, 1203)
  for (const pageSize of [0, -1, 'bad', 'Infinity', 'NaN', 0.5, '1 OR 1=1']) {
    const result = data.records({ pageSize })
    assert.equal(result.pageSize, 20)
    assert.equal(result.rows.length, 20)
  }
  const capped = data.records({ pageSize: 1000000 })
  assert.equal(capped.pageSize, 1000)
  assert.equal(capped.rows.length, 1000)
  const last = data.records({ page: 1203, pageSize: 1 })
  assert.equal(last.page, 1203)
  assert.deepEqual(last.rows.map((row) => row.id), [1])
  for (const page of [0, -1, 'bad', 'Infinity']) assert.equal(data.records({ page }).page, 1)
})

// dnsmasq 转发模式:内核那条来源是本机的记录,落库前按 dnsmasq 查询日志对回终端;dnsmasq 自己答掉的补成记录(system/dnsmasq-query-log.mjs)
const fakeDnsmasq = ({ clients = {}, answered = [] } = {}) => {
  let polls = 0
  const queue = [...answered]
  return {
    active: () => true,
    poll: () => { polls++ },
    resolve: (row) => { const c = clients[row.domain]; delete clients[row.domain]; return c || '' },
    takeAnswered: () => queue.splice(0),
    set: (domain, client) => { clients[domain] = client },
    polls: () => polls,
  }
}

test('dnsmasq-forwarded records get their device from the query log; dnsmasq answers are stored and counted', () => {
  const db = new DatabaseSync(':memory:')
  let clock = 1700000000000
  const now = () => clock
  const dnsmasq = fakeDnsmasq({
    clients: { 'a.example': '10.0.0.20', 'self.example': '127.0.0.1' },
    answered: [{ at: clock, domain: 'cached.example', qtype: 'A', source: '10.0.0.21', result: 'cached', list: '', elapsed: null, via: 'dnsmasq' }],
  })
  const data = createDnsFilterStore(db, { now, dnsmasq })
  for (const [domain, source] of [['a.example', '127.0.0.1'], ['self.example', '127.0.0.1'], ['late.example', '127.0.0.1'], ['direct.example', '192.168.3.18']]) {
    data.start(clock)
    data.finish({ at: clock, domain, qtype: 'A', source, result: 'allowed', list: '', elapsed: 5 })
  }
  const first = data.records({})
  assert.ok(dnsmasq.polls() >= 1, '落库前先读 dnsmasq 日志')
  assert.deepEqual(first.rows.map((r) => [r.domain, r.source, r.via]).sort(), [
    ['a.example', '10.0.0.20', 'dnsmasq'],
    ['cached.example', '10.0.0.21', 'dnsmasq'],
    ['direct.example', '192.168.3.18', ''],
    ['self.example', '127.0.0.1', 'dnsmasq'],
  ], '还没对上的那条先等着')
  // 日志晚到:下一轮对上
  dnsmasq.set('late.example', '10.0.0.22')
  clock += 1000
  assert.equal(data.records({}).rows.find((r) => r.domain === 'late.example').source, '10.0.0.22')
  // dnsmasq 自己答的也算进查询量,不计耗时
  const summary = data.summary()
  assert.equal(summary.queries, 5)
  assert.equal(summary.timed, 4)
  assert.equal(data.records({ result: 'dnsmasq' }).total, 1)
  assert.equal(data.records({ result: 'cached' }).total, 1)
  assert.equal(data.records({ result: 'allowed' }).total, 4)
  db.close()
})

test('unmatched dnsmasq-forwarded records are written as router forwarding after a short wait or on stop', () => {
  const db = new DatabaseSync(':memory:')
  let clock = 1700000000000
  const data = createDnsFilterStore(db, { now: () => clock, dnsmasq: fakeDnsmasq() })
  data.finish({ at: clock, domain: 'x.example', qtype: 'A', source: '127.0.0.1', result: 'allowed', list: '', elapsed: 1 })
  assert.equal(data.records({}).total, 0)
  clock += 6000
  const rows = data.records({}).rows
  assert.deepEqual(rows.map((r) => [r.source, r.via]), [['127.0.0.1', '']])
  data.finish({ at: clock, domain: 'y.example', qtype: 'A', source: '127.0.0.1', result: 'allowed', list: '', elapsed: 1 })
  data.flush({ force: true })
  assert.equal(data.records({}).total, 2, '面板停止时不再等')
  db.close()
})

test('old record tables gain the via column and keep their rows', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE dns_filter_records (id INTEGER PRIMARY KEY, at INTEGER, domain TEXT, qtype TEXT, source TEXT, result TEXT, list TEXT, elapsed REAL)')
  db.prepare('INSERT INTO dns_filter_records (at,domain,qtype,source,result,list,elapsed) VALUES (?,?,?,?,?,?,?)').run(1700000000000, 'old.example', 'A', '127.0.0.1', 'allowed', '', 3)
  const data = createDnsFilterStore(db, { now: () => 1700000001000 })
  const rows = data.records({}).rows
  assert.deepEqual(rows.map((r) => [r.domain, r.via]), [['old.example', '']])
  db.close()
})
