// 档案里的两个 DNS 上游(dns.direct / dns.proxy + dns.directProtocol / dns.proxyProtocol):
//   · 地址只存 IP(IPv4 / IPv6)或「上游 DNS」记号 wan(见下面 WAN_UPSTREAM),不收域名——带域名的上游
//     还得另找一个 DNS 去解析它,先有鸡还是先有蛋;
//     v0.1.83 之前留在档案里的 "https://1.1.1.1/dns-query" 这种 DoH 链接只剩主机那一段有用
//   · 协议只有 udp / tcp。DoT / DoH / DoQ 这些带域名的协议不做:证书、SNI 都绕着域名转,还得另找一个 DNS
//     去解析那个域名(用户明确不要)
//   · 端口 dns.directPort / dns.proxyPort:按协议给默认 53,用户可改;生成配置时等于 53 就不写 server_port
// normalizeDnsUpstream 把老写法折算成裸地址(读档案 / 迁移用);isValidDnsUpstream 只认裸 IP(校验用)。
// 选的协议那台服务器到底支不支持,不在这里猜:api/dns-upstream-test.mjs 用内核真的查一次
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const IPV6_RE = /^[0-9a-f:]+$/i

export const DNS_PROTOCOLS = Object.freeze(['udp', 'tcp'])
export const DEFAULT_DNS_PORT = 53
export const DEFAULT_DIRECT_UPSTREAM = '223.5.5.5'
export const DEFAULT_PROXY_UPSTREAM = '1.1.1.1'
// 每一侧最多能配几个备用上游(和主上游一起并发竞速)。定这个上限是因为每多一个上游,
// 生成的 DNS 规则就多一轮 evaluate + respond —— 规则表本来就按站点集展开过一遍
export const MAX_DNS_EXTRAS = 3

// 「上游 DNS」:路由器系统此刻的上游 DNS——接口上 DHCP / PPPoE 分配或手动指定的(部署时读 resolv.conf.auto 等,见
// system/resolv.mjs;主路由一般是 WAN 口下发的,旁路由可能根本没有 WAN 口,用户 2026-10-02 指出,界面上不提 WAN),
// 档案里记成这个记号(dns.direct / dns.proxy / 备用上游的 server;记号叫 wan 是历史原因,不显示给用户)。
// 用户 2026-10-02 定:直连 DNS 默认就是它;代理 DNS 只有路由器在中国大陆之外时才能用它——中国大陆的 DNS 对境外域名有污染。
// 它固定直连(不经目标分流)、固定 UDP 53:系统只给地址,协议跟着上游走,和系统 / dnsmasq 问它的方式一样,不让用户选
export const WAN_UPSTREAM = 'wan'
export const isWanUpstream = (value) => value === WAN_UPSTREAM

// 路由器在哪(档案 dns.region):cn 中国大陆 / intl 中国大陆之外(含港澳台:用户 2026-10-02 把页签从「中国 / 中国之外」改成这样,
// 港澳台没有 DNS 污染;判定用的 geoip-cn 本来就只含中国大陆)。没有这个键的(老设备、全新安装还没判出来)按中国大陆算,
// 见 system/router-region.mjs
export const DNS_REGIONS = Object.freeze(['cn', 'intl'])
export const dnsRegionOf = (profile) => (profile && profile.dns && profile.dns.region === 'intl' ? 'intl' : 'cn')
// 读不到系统的上游 DNS 时「上游 DNS」退回哪台:国内 223.5.5.5;国外 1.1.1.1(英国实测国内公共 DNS 一次要 84~456 ms,
// 1.1.1.1 / 8.8.8.8 是 0~12 ms)
export const wanFallbackUpstream = (region) => (region === 'intl' ? DEFAULT_PROXY_UPSTREAM : DEFAULT_DIRECT_UPSTREAM)
// 两个地区的默认 DNS(用户 2026-10-02):中国大陆——直连用上游 DNS,代理用经代理查的 TCP 1.1.1.1(TCP 而不是 UDP:UDP 经代理
// 常被截断 / 丢包);中国大陆之外——没有污染,两侧都用上游 DNS。地区页签切换、「恢复默认」都按它
export const regionDnsDefaults = (region) => (region === 'intl'
  ? { direct: WAN_UPSTREAM, directProtocol: 'udp', directPort: DEFAULT_DNS_PORT, directExtras: [], proxy: WAN_UPSTREAM, proxyProtocol: 'udp', proxyPort: DEFAULT_DNS_PORT, proxyExtras: [] }
  : { direct: WAN_UPSTREAM, directProtocol: 'udp', directPort: DEFAULT_DNS_PORT, directExtras: [], proxy: DEFAULT_PROXY_UPSTREAM, proxyProtocol: 'tcp', proxyPort: DEFAULT_DNS_PORT, proxyExtras: [] })
// 路由器在中国大陆时代理侧不能用上游 DNS:返回错误说明,没问题返回 null(dns 是合并之后的整份)
export const regionDnsError = (dns) => {
  if (!dns || dns.region === 'intl') return null
  const extras = Array.isArray(dns.proxyExtras) ? dns.proxyExtras : []
  if (isWanUpstream(dns.proxy) || extras.some((x) => x && isWanUpstream(x.server))) return '路由器在中国大陆时,代理 DNS 不能用上游 DNS:中国大陆的 DNS 对境外域名有污染'
  return null
}

export const isDnsProtocol = (value) => DNS_PROTOCOLS.includes(value)
export const isValidDnsPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535
export const dnsPortOr = (value, fallback = DEFAULT_DNS_PORT) => (isValidDnsPort(value) ? value : fallback)
export const dnsProtocolOr = (value, fallback) => (isDnsProtocol(value) ? value : fallback)

export const isValidDnsUpstream = (value) => {
  if (typeof value !== 'string') return false
  const host = value.trim()
  if (!host) return false
  if (IPV4_RE.test(host)) return host !== '0.0.0.0'
  if (!host.includes(':')) return false
  return IPV6_RE.test(host) && host !== '::' && host.split('::').length <= 2 && host.split(':').length <= 8
}

// "https://1.1.1.1/dns-query" → "1.1.1.1";"[2001:db8::1]" → "2001:db8::1";裸地址原样(去空白)。
// 折不出合法 IP(包括域名)就返回空串,调用方自己决定兜底值
export const normalizeDnsUpstream = (value) => {
  if (typeof value !== 'string') return ''
  let host = value.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try { host = new URL(host).hostname } catch { return '' }
  }
  host = host.replace(/^\[|\]$/g, '')
  return isValidDnsUpstream(host) ? host : ''
}

// 生成配置里的一条 DNS server:{ protocol, server, port } → sing-box 1.12+ 的 server 对象。端口是默认 53 就不写
export const dnsServerEntry = ({ protocol, server, port }, tag, detour = '') => ({
  type: protocol,
  tag,
  server,
  ...(isValidDnsPort(port) && port !== DEFAULT_DNS_PORT ? { server_port: port } : {}),
  ...(detour ? { detour } : {}),
})
