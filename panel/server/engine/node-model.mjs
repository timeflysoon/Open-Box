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
    fields: input.fields && typeof input.fields === 'object' ? input.fields : {},
    source,
  }
}
