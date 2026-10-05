// engine/cidr.mjs(不用 BigInt,打进 App)和 system/local-subnets.mjs(BigInt 原写法,路由器的旁路 / 规则集索引用)
// 逐条对拍:解析认不认、规范写法、重叠、包含、减法结果都一样。随机样本用固定种子,出错能复现
import assert from 'node:assert/strict'
import test from 'node:test'
import * as reference from '../system/local-subnets.mjs'
import { cidrContains, cidrsOverlap, parseCidr, subtractCidrs } from './cidr.mjs'

const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const int = (rand, n) => Math.floor(rand() * n)

const randomV4 = (rand) => {
  const ip = [0, 0, 0, 0].map(() => (rand() < 0.3 ? [0, 10, 127, 172, 192, 255][int(rand, 6)] : int(rand, 256))).join('.')
  return rand() < 0.15 ? ip : `${ip}/${int(rand, 33)}`
}
const randomV6 = (rand) => {
  const groups = Array.from({ length: 8 }, () => (rand() < 0.4 ? '0' : int(rand, 0x10000).toString(16)))
  let text = groups.join(':')
  const r = rand()
  if (r < 0.3) {
    // 压缩一段连续 0(可能不是最长的那段,解析要都认)
    const start = int(rand, 7)
    const len = 1 + int(rand, 8 - start)
    text = `${groups.slice(0, start).join(':')}::${groups.slice(start + len).join(':')}`
  } else if (r < 0.4) {
    text = `::ffff:${int(rand, 256)}.${int(rand, 256)}.${int(rand, 256)}.${int(rand, 256)}`
  }
  return rand() < 0.15 ? text : `${text}/${int(rand, 129)}`
}
const junk = ['', 'abc', '300.1.1.1/8', '1.2.3/24', '1.2.3.4/33', '::/129', '1::2::3', ':::', '1.2.3.4/x', 'fe80::1%en0', '0.0.0.0/0', '::/0', '::', '1.2.3.4 ', ' 1.2.3.4/32']
const sample = (rand) => (rand() < 0.5 ? randomV4(rand) : rand() < 0.95 ? randomV6(rand) : junk[int(rand, junk.length)])

test('解析和规范写法:认不认、取整后的写法都和 BigInt 写法一样', () => {
  const rand = rng(7)
  for (const s of [...junk, ...Array.from({ length: 5000 }, () => sample(rand))]) {
    assert.equal(Boolean(parseCidr(s)), Boolean(reference.parseCidr(s)), s)
    assert.deepEqual(subtractCidrs([s], []), reference.subtractCidrs([s], []), s)
  }
})

test('重叠、包含:和 BigInt 写法一样', () => {
  const rand = rng(8)
  for (let i = 0; i < 5000; i++) {
    const v6 = rand() < 0.5
    const a = v6 ? randomV6(rand) : randomV4(rand)
    const b = rand() < 0.1 ? randomV4(rand) : v6 ? randomV6(rand) : randomV4(rand)
    assert.equal(cidrsOverlap(a, b), reference.cidrsOverlap(a, b), `${a} ${b}`)
    assert.equal(cidrContains(a, b), reference.cidrContains(a, b), `${a} ${b}`)
  }
})

test('减法(tun 排除段那样挖洞):结果和 BigInt 写法逐条一样', () => {
  const rand = rng(9)
  // 实际用法:私网范围挖掉本机网段 / 自定义直连段
  assert.deepEqual(
    subtractCidrs(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'], ['192.168.3.0/24', '10.0.0.0/24', 'fd00:3::/64']),
    reference.subtractCidrs(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'], ['192.168.3.0/24', '10.0.0.0/24', 'fd00:3::/64']),
  )
  for (let i = 0; i < 400; i++) {
    const v6 = rand() < 0.4
    const pick = () => (v6 ? randomV6(rand) : randomV4(rand))
    // 洞要比底大才挖得出东西:底取短前缀,洞取长前缀
    const bases = Array.from({ length: 1 + int(rand, 3) }, () => pick().replace(/\/\d+$/, '') + `/${v6 ? 8 + int(rand, 40) : 4 + int(rand, 16)}`)
    const holes = Array.from({ length: int(rand, 5) }, () => pick().replace(/\/\d+$/, '') + `/${v6 ? 40 + int(rand, 60) : 16 + int(rand, 14)}`)
    assert.deepEqual(subtractCidrs(bases, holes), reference.subtractCidrs(bases, holes), `${bases} - ${holes}`)
  }
})
