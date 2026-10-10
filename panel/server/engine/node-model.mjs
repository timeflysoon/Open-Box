export const NODE_TYPES = Object.freeze([
  'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'wireguard', 'anytls', 'socks', 'http',
])

export const isNodeType = (value) => NODE_TYPES.includes(value)

// 节点名称来自机场原文,只要有值就原样保留。名称不是协议字段,不做字符集、格式或
// "是否合法"检查;否则带空格、表情、括号、斜杠等正常机场名称会在导入时被改掉。
// YAML 允许未加引号的数字/布尔值,也把这类标量转成文本保留。空值没有可用的 tag,
// 才使用服务器和端口作为稳定兜底名称。
const nodeName = (value, fallback) => {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return fallback
}

export const createNode = (input) => {
  if (!input || typeof input !== 'object') throw new Error('node input must be an object')
  const { tag, type, server, source } = input
  if (!type || !isNodeType(type)) throw new Error(`invalid node type: ${type}`)
  if (!server || typeof server !== 'string') throw new Error('node requires a string server')
  const port = Number.parseInt(input.server_port, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid server_port: ${input.server_port}`)
  }
  if (source !== 'clash' && source !== 'sharelink' && source !== 'singbox') {
    throw new Error(`invalid source: ${source}`)
  }
  const name = nodeName(tag, `${server}:${port}`)
  return {
    tag: name,
    originalTag: nodeName(input.originalTag, name),
    type,
    server,
    server_port: port,
    fields: checkedFields(input.fields && typeof input.fields === 'object' ? input.fields : {}),
    source,
  }
}

// 内核一读到就整个起不来的字段错误(GitHub #518:一个坏节点拖住整个内核),建节点时就挡掉:抛出带 code 'invalid-field'
// 的错误,解析订阅时记进「跳过」(原因 invalid,detail 是下面这几句),这个节点不收。路由器保存订阅时还会让内核把每个节点
// 过一遍(system/validate.mjs 的 kernelRejectedNodes),这里只挡常见的、App 的引擎里也要挡的
const invalidField = (detail) => Object.assign(new Error(detail), { code: 'invalid-field', detail })

// REALITY 公钥:内核按 base64url(不带 =)解码,必须正好 32 字节,即 43 位。机场给成标准 base64 写法(+ / 和末尾的 =)
// 的换过来再认;还不对就是坏的
const REALITY_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/
export const normalizeRealityPublicKey = (value) => {
  const key = String(value ?? '').trim().replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return REALITY_PUBLIC_KEY.test(key) ? key : null
}

const checkedFields = (fields) => {
  const tls = fields.tls
  const reality = tls && typeof tls === 'object' && tls.enabled !== false && tls.reality && typeof tls.reality === 'object' && tls.reality.enabled ? tls.reality : null
  if (!reality) return fields
  if (!reality.public_key) throw invalidField('missing reality public_key')
  const key = normalizeRealityPublicKey(reality.public_key)
  if (!key) throw invalidField('invalid reality public_key')
  return key === reality.public_key ? fields : { ...fields, tls: { ...tls, reality: { ...reality, public_key: key } } }
}
