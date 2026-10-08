// 测速地址默认使用 HTTP；随包内核的 Clash API 保留用户指定的协议、主机和路径。
export const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204'
export const DEFAULT_DIRECT_TEST_URL = 'http://connectivitycheck.platform.hicloud.com/generate_204'

// 仅移除输入首尾空白，不替换用户指定的检测地址或协议。
export const kernelTestUrl = (raw) => typeof raw === 'string' ? raw.trim() : ''

// 只迁移旧版内置默认值；自定义 HTTP / HTTPS 地址保持不变。
export const ensureTestUrlDefaults = (store) => {
  const profile = store.getProfile() || {}
  const patch = {}
  if (profile.testUrl === 'https://www.gstatic.com/generate_204') patch.testUrl = DEFAULT_TEST_URL
  if (['https://connectivitycheck.platform.hicloud.com/generate_204', 'http://www.msftconnecttest.com/connecttest.txt'].includes(profile.directTestUrl)) {
    patch.directTestUrl = DEFAULT_DIRECT_TEST_URL
  }
  if (!Object.keys(patch).length) return false
  store.setProfile(patch)
  return true
}

// 测速「可接受状态码」(内核 1.14.1-openbox-tcp19 起,GitHub #395 #482):测速只要有应答内核就算通,站点回 403 / 404 的节点
// (被拦、被当成滥用)照样被当成好的,自动择优、故障转移不换。写法和 mihomo 的 expected-status、内核 common/urltest/expected.go
// 一样:空 / "*" = 什么应答都算通(老样子,默认);否则状态码或范围,用 / 或 , 隔开:204、200/204、200-299/302。
// 回规范写法(不限 = '')或 null(写法不对)
export const normalizeExpectedStatus = (raw) => {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text || text === '*') return ''
  const parts = text.split(/[/,]/).map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return null
  const out = []
  for (const part of parts) {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(part)
    if (!m) return null
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    if (from < 100 || to > 599 || to < from) return null
    out.push(from === to ? String(from) : `${from}-${to}`)
  }
  return out.join('/')
}

// 测速去重用的键:同一个节点、同一个地址,可接受状态码不同的不能共用一次结果(和内核 urltest.ProbeLink 一个意思)
export const probeKeyUrl = (url, expected) => (expected ? `${url} expected=${expected}` : url)

// Clash API 测速接口的 expected 参数;不限时不带(老内核不认这个参数,照常测、不看状态码)
export const expectedQuery = (expected) => (expected ? `&expected=${encodeURIComponent(expected)}` : '')
