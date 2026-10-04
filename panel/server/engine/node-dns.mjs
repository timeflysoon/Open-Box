import net from 'node:net'

// 节点服务器域名的专用解析器(GitHub #136):有的机场要求节点域名只能用它自己给的 DoH 解析(常见带私有路径,
// 如 https://dns.example.net:2096/<私有路径>),普通 DNS 查到的地址连不上——OpenClash 用 nameserver-policy /
// proxy-server-nameserver 解决。这里按订阅设:订阅的 nodeDns = { url, bootstrap }
//   url        DoH 地址,只收 https://
//   bootstrap  解析 DoH 自己的域名用的 DNS,只收 IP(UDP 53);DoH 地址本身是 IP 时可以不填
// 生成配置时这份订阅的每个节点(服务器是域名的)出站带上 domain_resolver 指向这台 DoH;普通网站和局域网的
// DNS 不受影响。两台都不写 detour,和 dns-direct 一样从路由器直接连
//
// 私有路径相当于口令:诊断包里要抹掉(api/diagnostics.mjs 按 NODE_DNS_TAG_PREFIX 认)
export const NODE_DNS_TAG_PREFIX = 'dns-sub-'

const parseDohUrl = (raw) => {
  let u
  try { u = new URL(String(raw || '').trim()) } catch { return null }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.hash) return null
  const host = u.hostname.replace(/^\[|\]$/g, '')
  return { host, port: u.port ? Number(u.port) : 443, path: `${u.pathname || '/'}${u.search || ''}` }
}

// 保存前的校验:返回错误信息,合法返回 null。nodeDns 为空(null / undefined / url 空)表示不用专用解析器
export const validateNodeDns = (raw) => {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'nodeDns must be an object'
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  const bootstrap = typeof raw.bootstrap === 'string' ? raw.bootstrap.trim() : ''
  if (raw.url !== undefined && typeof raw.url !== 'string') return 'nodeDns.url must be a string'
  if (raw.bootstrap !== undefined && typeof raw.bootstrap !== 'string') return 'nodeDns.bootstrap must be a string'
  if (!url) return bootstrap ? 'nodeDns.url is required when bootstrap is set' : null
  if (url.length > 2048) return 'nodeDns.url is too long'
  const parsed = parseDohUrl(url)
  if (!parsed) return 'nodeDns.url must be an https:// DoH address'
  if (bootstrap && !net.isIP(bootstrap)) return 'nodeDns.bootstrap must be an IP address'
  if (!bootstrap && !net.isIP(parsed.host)) return 'nodeDns.bootstrap is required when the DoH address is a domain'
  return null
}

// 存下来的样子:没配就是 null
export const normalizeNodeDns = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!url || validateNodeDns(raw)) return null
  const bootstrap = typeof raw.bootstrap === 'string' ? raw.bootstrap.trim() : ''
  return { url, ...(bootstrap ? { bootstrap } : {}) }
}

const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)

// 一份 nodeDns → 内核的 DNS 服务器(DoH 一台,地址是域名时再加一台 bootstrap)。tag 按订阅 id 取,稳定
export const nodeDnsServers = (nodeDns, id) => {
  const conf = normalizeNodeDns(nodeDns)
  if (!conf) return null
  const { host, port, path } = parseDohUrl(conf.url)
  const tag = `${NODE_DNS_TAG_PREFIX}${safeId(id)}`
  const needsBootstrap = !net.isIP(host)
  const doh = {
    type: 'https',
    tag,
    server: host,
    ...(port !== 443 ? { server_port: port } : {}),
    ...(path && path !== '/dns-query' ? { path } : {}),
    ...(needsBootstrap ? { domain_resolver: `${tag}-bootstrap` } : {}),
  }
  const servers = needsBootstrap ? [doh, { type: 'udp', tag: `${tag}-bootstrap`, server: conf.bootstrap }] : [doh]
  return { tag, servers }
}

// 生成配置用:哪些订阅配了专用解析器 → { servers: 全部要加的 DNS 服务器, bySubscription: 订阅 id → DoH 的 tag }
export const planNodeDns = (subscriptions = []) => {
  const servers = []
  const bySubscription = new Map()
  for (const sub of Array.isArray(subscriptions) ? subscriptions : []) {
    if (!sub || sub.enabled === false) continue
    const plan = nodeDnsServers(sub.nodeDns, sub.id)
    if (!plan) continue
    servers.push(...plan.servers)
    bySubscription.set(sub.id, plan.tag)
  }
  return { servers, bySubscription }
}

// 出站的服务器是域名才需要解析器;是 IP 的不带,免得内核对着一个用不上的解析器报警告
export const withNodeResolver = (outbound, tag) => {
  if (!tag || !outbound || typeof outbound.server !== 'string' || !outbound.server || net.isIP(outbound.server)) return outbound
  return { ...outbound, domain_resolver: tag }
}
