// 生成节点 → 出站 / endpoint 的金标准(上游 engine 的 emitOutbound / emitEndpoint)。
// 用法: node core/testdata/gen-emit-golden.mjs <engine 目录(取自 catch-up-upstream:panel/server/engine)> [输出文件]
//   engine 目录(取自 catch-up-upstream:panel/server/engine)要含 emit-outbound.mjs、emit-endpoint.mjs、node-fields.mjs
//   且需要一个 {"type":"module"} 的 package.json。
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const dir = resolve(process.argv[2] || '.')
const out = resolve(process.argv[3] || new URL('./emit_golden.json', import.meta.url).pathname)
const ob = await import(pathToFileURL(resolve(dir, 'emit-outbound.mjs')).href)
const ep = await import(pathToFileURL(resolve(dir, 'emit-endpoint.mjs')).href)

let seed = 777
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rnd() * a.length)]
const chance = (p) => rnd() < p
const maybe = (p, f) => (chance(p) ? f() : undefined)
const rt = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

const STR = ['', ' ', 'abc', 'a.com', ' b.com ', '/ws', '/svc', 'x y']
const NUM = [0, 1, 443, 2048, '4096', 8080.5]
const WEIRD = [null, true, false, 0, 5, '', 'x']

const headers = () => pick([undefined, null, {}, { Host: 'a.com' }, { host: 'b.com' }, { Host: '', host: 'c.com' }, { 'X-A': '1', host: 'b' }, { 'X-A': '1' }, 'str', 5, ['p', 'q'], []])
const hostVal = () => pick([undefined, null, '', 'a.com', 'a.com, b.com', ' a.com ,, ', ['a.com', ' b.com '], [], 5, [1, null]])
const transport = () => {
  const type = pick(['ws', 'ws', 'http', 'grpc', 'httpupgrade', 'quic', 'tcp', 'xhttp', 'kcp', undefined, '', null, 'WS'])
  return maybe(0.9, () => ({
    type, path: maybe(0.7, () => pick(['', '/ws', '/ws?ed=2048', '/a?ed=x', '/a?ed=10&b', '?ed=5', 123, '/svc', '//svc', null])),
    host: maybe(0.5, hostVal), headers: maybe(0.6, headers), service_name: maybe(0.4, () => pick(['', '/svc', 'svc', '//a//b', null, 7])),
    method: maybe(0.3, () => pick(['GET', '', null])), max_early_data: maybe(0.3, () => pick(NUM)),
    early_data_header_name: maybe(0.3, () => pick(['', 'Sec-WebSocket-Protocol', 'X'])),
  }))
}
const tls = () => maybe(0.85, () => ({
  enabled: pick([true, true, true, false, undefined, 1, 0, 'yes', null]),
  server_name: maybe(0.7, () => pick(STR)), alpn: maybe(0.5, () => pick([[], ['h2'], ['h2', 'http/1.1'], 'h2', null])),
  reality: maybe(0.35, () => ({
    enabled: pick([true, true, false, undefined, 1]), public_key: maybe(0.8, () => pick(['pk', ''])),
    short_id: maybe(0.8, () => pick([undefined, null, 'null', 'undefined', '', 'abcd', 'ABCDEF0123456789', '0123456789abcdef0', 'xyz', ' ab ', 123, 0, true])),
  })),
  utls: maybe(0.6, () => ({ enabled: pick([true, true, false, undefined, 1]), fingerprint: maybe(0.8, () => pick([undefined, null, 'chrome', 'firefox', 'UNSAFE', ' unsafe ', 'Unsafe', '', 5, 0, ' Chrome '])) })),
}))
const common = () => ({ tag: maybe(0.95, () => pick(['香港-01', 'A', ' sp ', ''])), server: maybe(0.95, () => pick(['1.2.3.4', 'a.com', ''])), server_port: maybe(0.95, () => pick([443, '443', 0, 65535, null])) })
const node = (type) => {
  const f = {}
  const add = (k, v) => { if (v !== undefined) f[k] = v }
  switch (type) {
    case 'shadowsocks':
      add('method', maybe(0.9, () => pick(['aes-256-gcm', '2022-blake3-aes-128-gcm', '']))); add('password', maybe(0.9, () => pick(['pw', '', 123])))
      add('plugin', maybe(0.4, () => pick(['obfs-local', 'v2ray-plugin', '', null, 5]))); add('plugin_opts', maybe(0.5, () => pick(['obfs=http;obfs-host=x', '', null])))
      break
    case 'vmess':
      add('uuid', maybe(0.9, () => pick(['u-1', '']))); add('alter_id', maybe(0.6, () => pick([undefined, null, 0, 2, '1', false])))
      add('security', maybe(0.6, () => pick(['auto', 'aes-128-gcm', '', null]))); add('transport', transport()); add('tls', tls())
      break
    case 'vless':
      add('uuid', maybe(0.9, () => pick(['u-2', '']))); add('flow', maybe(0.7, () => pick(['', 'none', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443', 'xtls-rprx-direct', ' xtls-rprx-vision ', null, 5, 'XTLS-RPRX-VISION'])))
      add('transport', transport()); add('tls', tls())
      break
    case 'trojan':
      add('password', maybe(0.9, () => pick(['pw', '', 5]))); add('transport', transport()); add('tls', tls())
      break
    case 'anytls':
      add('password', maybe(0.9, () => pick(['pw', '']))); add('transport', transport()); add('tls', tls())
      break
    case 'hysteria2':
      add('password', maybe(0.9, () => pick(['pw', '']))); add('tls', tls()); add('obfs', maybe(0.4, () => pick([{ type: 'salamander', password: 'x' }, '', null, 'o'])))
      add('server_ports', maybe(0.5, () => pick(['20000-40000', '20000-40000,50000', '20000:40000', '50000', '80~90', ['20000-40000', '50000'], [], 5, null, '1-65536', '0-10', '10-5', 'x', '1,2,3', '  ', '20000 - 40000', ['a'], '20000-40000，50000', 123456, true, [1000, null], '100;200', '70000', '00080-00090', ' 5 ', '\ufeff80-90', '80\u00a0-\u00a090', '80 \u3000,\u2003 90', '80-90,\ufeff', '443,8443,10000-20000', '1-65535', '65535-65535,1-2', ['80\u00a0-\u00a090'], ['80\u3000~\u200190'], ['\ufeff80-90'], '80\ufeff90', '80\u202f90', '80\u202890', '80\u202990', '80\u168090', '80\u205f-\u205f90', ['7', ' 8-9 '], { a: 1 }])))
      add('hop_interval', maybe(0.5, () => pick([null, '', 5, 4, '30', 30, '30s', '5m', '1h', '100ms', '30 s', 'abc', 0, '0', '007', '4', 1e21, '10m ', ' 10 ', true, [], {}, '5', 5.5])))
      add('disable_chrome_parrot', maybe(0.3, () => pick([true, false, 'true', 1]))); add('disableChromeParrot', maybe(0.3, () => pick([true, false, 'true'])))
      break
    case 'socks':
      add('version', maybe(0.6, () => pick([5, '5', 4, '4a', '', 0, null, undefined]))); add('username', maybe(0.5, () => pick(['u', '', 7, null])))
      add('password', maybe(0.5, () => pick(['p', '', 8, null]))); add('transport', transport()); add('tls', tls())
      break
    case 'http':
      add('username', maybe(0.6, () => pick(['u', '', 7, null]))); add('password', maybe(0.6, () => pick(['p', '', 8, null]))); add('tls', tls()); add('transport', transport())
      break
    case 'tuic':
      add('uuid', maybe(0.9, () => pick(['u-3', '']))); add('password', maybe(0.9, () => pick(['pw', '']))); add('tls', tls())
      add('congestion_control', maybe(0.5, () => pick(['bbr', 'cubic', '', null])))
      break
    case 'wireguard':
      add('peer_public_key', maybe(0.9, () => pick(['pub', '']))); add('private_key', maybe(0.9, () => pick(['priv', ''])))
      add('pre_shared_key', maybe(0.4, () => pick(['psk', '', null])))
      add('local_address', maybe(0.9, () => pick([['172.16.0.2'], ['172.16.0.2', '2606:4700::1'], ['10.0.0.2/24', ' 10.0.0.3 '], [], '172.16.0.2', null, [5, '']])))
      break
  }
  return { type, ...common(), ...(chance(0.15) ? { detour: pick(['上游', '', null, 5, ' x ', true, 'a']) } : {}), fields: f }
}

const cases = []
const run = (fn, f, n) => {
  const input = rt(n)
  try { cases.push({ fn, node: input, want: rt(f(input)) }) } catch (e) { cases.push({ fn, node: input, error: e.message }) }
}
const TYPES = ['shadowsocks', 'vmess', 'vless', 'trojan', 'anytls', 'hysteria2', 'socks', 'tuic', 'http']
for (let i = 0; i < 800; i++) run('emitOutbound', ob.emitOutbound, node(TYPES[i % TYPES.length]))
// 端口跳跃的语料要密一些:大部分随机写法都是非法的,多放一批才能碰到合法的
for (let i = 0; i < 300; i++) run('emitOutbound', ob.emitOutbound, node('hysteria2'))
for (let i = 0; i < 120; i++) run('emitEndpoint', ep.emitEndpoint, node('wireguard'))
// 边界:类型不对
for (const t of ['wireguard', 'bogus', undefined, null, 5]) run('emitOutbound', ob.emitOutbound, { type: t, tag: 'x', fields: {} })
for (const t of ['vmess', undefined, 'wireguard1']) run('emitEndpoint', ep.emitEndpoint, { type: t, tag: 'x', fields: {} })
writeFileSync(out, JSON.stringify({ generatedBy: 'gen-emit-golden.mjs', cases }) + '\n')

const okCount = cases.filter((c) => c.want).length
const byType = {}
for (const c of cases.filter((c) => c.want && c.fn === 'emitOutbound')) byType[c.want.type] = (byType[c.want.type] || 0) + 1
const tr = cases.filter((c) => c.want && c.want.transport).length, rl = cases.filter((c) => c.want && c.want.tls && c.want.tls.reality).length
console.log('写入', cases.length, '条 →', out, '| 成功', okCount, '| 报错', cases.length - okCount, '| 带 transport', tr, '| 带 reality', rl)
console.log(byType)
