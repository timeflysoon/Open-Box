// 生成 internal/urlx 的 Parse 金标准:随机的「https://用户信息@主机:端口/路径?查询#片段」喂 Node 的 new URL(x),
// 记录 username / password / hostname / port / pathname / search / hash(抛错记 null)。
// 用法: node core/testdata/gen-urlx-parts-golden.mjs [条数] [输出文件]
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const count = Number(process.argv[2] || 3000)
const out = resolve(process.argv[3] || new URL('./urlx_parts_golden.json', import.meta.url).pathname)
let seed = 20261022
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rnd() * a.length)]
const schemes = ['https', 'https', 'https', 'http', 'HTTPS', 'wss', 'ftp', 'foo']
const users = ['', '', '', 'u@', 'u:p@', ':p@', 'u:@', '@', 'a b:c d@', 'us/er:pa:ss@', '用户:密码@', '%41@', 'a@b@']
const hosts = ['dns.example.net', 'DNS.Example.NET', '1.2.3.4', '[2001:db8::1]', 'a.b', 'xn--fiq228c.com', '中文.com', 'h']
const ports = ['', '', '', ':08080', ':0021', ':443', ':80', ':8443', ':0443', ':0', ':00', ':65535', ':21', ':8080']
const segs = ['dns-query', 'a', 'B', '', '.', '..', '%2e', '%2E%2e', '.%2e', 'a b', 'a%20b', 'a%zz', 'x\\y', 'q?x', '{x}', '`', '<>', '"', "'", '^', '|', '[', ']', 'é', '中文', '😀', 'a;b', 'a=b', 'a:b', 'a@b', 'a%', '%', '~', 'a\u0001b', '\u007f', '\u0080', '!$&()*+,', '#x']
const query = ['', '?', '?a=1', '?a=1&b=2', "?a='x'", '?a b', '?a"b', '?a<b>', '?a`b', '?a{b}', '?é', '?中', '?a#b', '?%zz', '??', '?a?b', '?^|', '?a\u0001b', '?\u007f']
const frag = ['', '#', '#f', '#a b', '#a"b', '#`', '#é', '##', '#?', '#%zz', '#a\u0001b']
const cases = []
for (let i = 0; i < count; i++) {
  const n = Math.floor(rnd() * 4)
  const path = Array.from({ length: n }, () => '/' + pick(segs)).join('') + (rnd() < 0.15 ? '/' : '')
  const s = pick(schemes) + '://' + pick(users) + pick(hosts) + pick(ports) + (rnd() < 0.9 ? path : '') + pick(query) + pick(frag)
  let want = null
  try { const u = new URL(s); want = { scheme: u.protocol.replace(/:$/, ''), username: u.username, password: u.password, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash } } catch { /* 抛错 */ }
  cases.push({ in: s, want })
}
writeFileSync(out, JSON.stringify({ generatedBy: 'gen-urlx-parts-golden.mjs', cases }) + '\n')
console.log('写入', cases.length, '条 →', out, '| 抛错', cases.filter((c) => !c.want).length)
