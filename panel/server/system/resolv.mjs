// 读路由器"系统默认"的 DNS 上游:「DNS 上游」卡片里的「上游 DNS」(档案记号 wan)就是它。
//
// 不能让 sing-box 去问系统解析器:dnsmasq 接管模式下 dnsmasq 的上游已经被指向 sing-box,
// 再问 /etc/resolv.conf → dnsmasq 就成了死循环。要拿的是接口上分配 / 指定的那几台——主路由一般是
// WAN 口下发的,旁路由可能没有 WAN 口,是 LAN 口 DHCP 分配或手动指定的;OpenWrt 把所有接口的都写在
// /tmp/resolv.conf.d/resolv.conf.auto —— 那个文件才是"上游",/etc/resolv.conf 里只有 127.0.0.1(dnsmasq 自己)。
//
// 读不到就返回空数组,调用方按地区退回随包默认(engine/dns-upstream.mjs 的 wanFallbackUpstream);这一步永远不该让部署失败。

import net from 'node:net'

const AUTO_RESOLV = '/tmp/resolv.conf.d/resolv.conf.auto'
// Debian / Ubuntu 用 systemd-resolved 时 /etc/resolv.conf 里只有 127.0.0.53(stub),真正的上游在这份
const SYSTEMD_RESOLV = '/run/systemd/resolve/resolv.conf'
const ETC_RESOLV = '/etc/resolv.conf'

// 127.0.0.1 / ::1 要排除:那就是 dnsmasq 自己,填进去等于把回环写死进配置。
const isLoopback = (ip) => ip === '::1' || /^127\./.test(ip)
// 链路本地 v6(fe80::/10)只在本链路有效,netifd 会写成 fe80::1%wan6 带 zone:内核的 DNS
// 服务器和 node 的 Resolver 都不认,后者直接同步抛 ERR_INVALID_IP_ADDRESS 让部署失败。
// 上级路由器用 RA 下发 RDNSS 的双层路由环境里这行必然存在,所以要在这里就丢掉。
const isLinkLocalV6 = (ip) => /^fe[89ab][0-9a-f]:/i.test(ip)
// 内核自己的地址也要排除:tun 网段(172.19.0.0/30、fdfe:dcba:9876::/126,内核的 DNS 听在 172.19.0.2)和 FakeIP 占位段
// (198.18.0.0/15、fc00::/18)。Debian / Ubuntu 上 sing-box 起了 tun 之后会把 172.19.0.2 登记成那条链路的 DNS,
// systemd-resolved 就把它写进 /run/systemd/resolve/resolv.conf 的第一行——下一次部署再把它当"系统上游"读回来,
// 直连侧解析器就指向了内核自己:查询打环、query ID 耗尽、全机 DNS 失效、UDP 风暴(2026-09-24 在 Ubuntu 上实测)
const isKernelOwn = (ip) => /^172\.19\.0\.[0-3]$/.test(ip) || /^198\.1[89]\./.test(ip)
  || /^fdfe:dcba:9876:/i.test(ip) || /^fc[0-3][0-9a-f]:/i.test(ip)
const isUsable = (ip) => net.isIP(ip) !== 0 && !isLoopback(ip) && !isLinkLocalV6(ip) && !isKernelOwn(ip)

// IPv4 排前面:OpenWrt 的 resolv.conf.auto 按接口分段,wan_6 段常常写在 wan 段前面,
// 直接取第一个会拿到 IPv6 上游;内核默认 ipv4_only、IPv6 关着时那台根本拨不通。
export const parseResolvConf = (text) => {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*nameserver\s+(\S+)/)
    if (!m) continue
    const ip = m[1]
    if (!isUsable(ip) || out.includes(ip)) continue
    out.push(ip)
  }
  const isV4 = (ip) => net.isIPv4(ip)
  return [...out.filter(isV4), ...out.filter((ip) => !isV4(ip))]
}

export const readSystemDns = async (ctx) => {
  for (const path of [AUTO_RESOLV, SYSTEMD_RESOLV, ETC_RESOLV]) {
    try {
      if (!(await ctx.exists(path))) continue
      const servers = parseResolvConf(await ctx.readFile(path))
      if (servers.length) return servers
    } catch {
      // 读不到就试下一个;拿不到上游不是部署失败的理由
    }
  }
  return []
}
