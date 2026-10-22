// 生成 internal/urlx 的金标准:随机 URL 喂 Node 的 new URL(x).hostname,记录主机名(抛错记 null)。
// 不依赖 engine 基线,用 Node 内置的 WHATWG URL 当标准答案(direct-hosts.mjs / dns-upstream.mjs 都直接调它)。
// 用法: node core/testdata/gen-urlx-golden.mjs [条数] [输出文件]
//   第三个参数 --wide:把需要 UTS46 字符映射表的写法(ﬁ、ǆ、ẞ、软连字符、²……)也放进语料,
//   用来量化已知差异,不写进提交的金标准。
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const count = Number(process.argv[2] || 3000)
const out = resolve(process.argv[3] || new URL('./urlx_golden.json', import.meta.url).pathname)
const wide = process.argv.includes('--wide')

let seed = 20261021
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rnd() * a.length)]

const schemes = ['http', 'https', 'HTTP', 'ws', 'wss', 'ftp', 'file', 'foo', 'a+b', 'x-y.z', 'socks5', 'vless', 'http ', '1http', '', ' ']
const seps = ['://', ':', '//', ':/', ':\\\\', '://\\', '\\\\', ':///', '://', '://', '://']
// 能和 Node 逐条一致的标签
const labels = ['example', 'EXAMPLE', 'a', 'b-c', 'xn--fiq228c', '中文', '例え', 'пример', 'Ünï', 'ß', 'Σ', 'ａｂｃ', 'ＥＸ', '1', '0x7f', '0X1F', '0', '00', '08', '0377', '256', '4294967295', '4294967296', '999999999999999999999', '1e3', 'x', '_', 'a_b', 'a b', 'a%20b', '%41', '%2e', '%zz', '%', 'a%', '%e4%b8%ad', '%C0', '%ff', 'a\u0000', '\u00a0', 'a:b', 'a@b', '[::1]', '[1:2::3]', '[::ffff:1.2.3.4]', '[ABCD::]', '[0:0:0:0:0:0:0:0]', '[1::]', '[fe80::1%25eth0]', '[::1', '::1', '1.2.3', '1.2', '1.2.3.4.5', '1.2.3.4', '127.1', '0x7f.1', '0x100000000', '1.0x1000000', '1..2', '1.2.3.', '.', '', 'localhost', 'a.b.c', 'a..b', '-a', 'a-', 'xn--', 'xn--a', 'xn--zz', 'a.xn--fiq228c', '\ufffd', '\u0085', '\ud800', '😀', 'a😀', '\u0628\u0627']
// 需要 UTS46 映射表(NFKC / 大小写折叠 / 忽略字符)和双向规则(希伯来字母混拉丁字母)的写法:已知差异,只在 --wide 里出现
const exotic = ['\u05d0b', 'ǅ', 'ǆ', 'İ', 'a\u00ad', 'a\u200bb', '\u3002', '\uff0e', '\uff61', 'a\u3002b', '\u2488', '\u00b2', '\u2160', '\ufb01', '\u1e9e', '\u0345', '\u0378', '\u180e']
const pool = wide ? labels.concat(exotic) : labels
const tails = ['', '/', '/path', '?q=1', '#h', ':80', ':0', ':65535', ':65536', ':99999', ':080', ':abc', ':', '@x', '/a@b', '\\path', '?x@y', '#a:b', ':80/path', ' ', '\t', '\n', '/\t']
const users = ['', 'u@', 'u:p@', '@', 'a@b@', 'u:@', ':@', '%40@', '[x]@', 'u:p:q@']
const host = () => {
  const n = 1 + Math.floor(rnd() * 3)
  const parts = Array.from({ length: n }, () => pick(pool))
  return parts.join(rnd() < 0.9 ? '.' : pick(wide ? ['.', '..', ',', '/', '\\', '%2e', '@'] : ['.', '..', '/', '\\', '%2e', '@']))
}

const cases = []
let nulls = 0
for (let i = 0; i < count; i++) {
  let s = pick(schemes) + pick(seps) + (rnd() < 0.3 ? pick(users) : '') + host() + pick(tails)
  if (rnd() < 0.05) s = pick(['  ', '\t', '\n', '\u0001', '\u00a0']) + s
  if (rnd() < 0.05) s = s + pick(['  ', '\t', '\n', '\u0001'])
  if (rnd() < 0.03) s = s.slice(0, Math.floor(rnd() * s.length))
  let want = null
  try { want = new URL(s).hostname } catch { nulls++ }
  cases.push({ in: s, want })
}
writeFileSync(out, JSON.stringify({ generatedBy: 'gen-urlx-golden.mjs', wide, cases }) + '\n')
console.log('写入', cases.length, '条 →', out, '| 抛错', nulls, '| 主机非空', cases.filter((c) => c.want).length)
