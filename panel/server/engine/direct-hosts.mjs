// 「订阅和节点站点直连」:订阅链接的主机名、各节点的服务器地址,一律直连,不看站点集。
// 节点服务器本身如果被路由进代理,就是拿代理去连代理;订阅链接也经常和节点同域。
// 域名进 domain,IP 进 ip_cidr(/32、/128)。
import { cidrsOverlap } from '../system/local-subnets.mjs'

// Cloudflare 公布的全部地址段(https://www.cloudflare.com/ips/,多年不变)。优选 IP / 优选域名 / argo / Workers 这类节点
// 的服务器地址(或它的域名解析出来的地址)都落在这里——这是成千上万个网站共用的任播地址,chatgpt.com 也在里面。
// 按 IP 把它们算成「连节点服务器」一律直连,连到同一批地址的 ChatGPT 也跟着直连了(GitHub #304)。这些地址不进
// 按 IP 的那份;节点的域名照旧按域名直连
export const SHARED_CDN_CIDRS = Object.freeze([
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
])
export const isSharedCdnCidr = (cidr) => SHARED_CDN_CIDRS.some((range) => cidrsOverlap(range, cidr))
const isIpv4 = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v)
const isIpv6 = (v) => v.includes(':') && /^[0-9a-f:.]+$/i.test(v)

export const collectDirectHosts = (nodes = [], subscriptions = []) => {
  const domains = new Set()
  const cidrs = new Set()
  const add = (host) => {
    const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (!h || h === 'localhost') return
    if (isIpv4(h)) cidrs.add(`${h}/32`)
    else if (isIpv6(h)) cidrs.add(`${h}/128`)
    else if (/^[a-z0-9.-]+$/.test(h) && h.includes('.')) domains.add(h)
  }
  for (const n of nodes) add(n && n.server)
  for (const s of subscriptions) {
    // 一条订阅可以有多个地址(urls);老记录只有 url
    const urls = s && Array.isArray(s.urls) && s.urls.length ? s.urls : [s && s.url]
    for (const raw of urls) {
      const url = typeof raw === 'string' ? raw.trim() : ''
      if (!url) continue
      try { add(new URL(url).hostname) } catch { /* 不是合法 URL 就跳过 */ }
    }
  }
  return { domains: [...domains], cidrs: [...cidrs] }
}

// 部署的配置里,这些地址不写死在规则里,放进两份本地规则集(source 格式,和热切换的开关文件一样):域名一份、IP 一份。
// 订阅刷新、节点换了服务器地址,只改写这两个文件,内核盯着文件自己重新加载,不重启(用户 2026-09-30:更新订阅节点
// 不应该重启内核)。文件在规则集目录里(system/node-direct-files.mjs 写);规则页推算按文件内容判(api/penetration.mjs)
export const NODE_DIRECT_DOMAIN_TAG = 'obnode-direct'
export const NODE_DIRECT_IP_TAG = 'obnode-direct-ip'
export const isNodeDirectTag = (tag) => tag === NODE_DIRECT_DOMAIN_TAG || tag === NODE_DIRECT_IP_TAG
// 地址直接写进规则(推算、手机 App)又一个地址都没有时的占位:文档保留的域名 / 地址,真实流量碰不到
export const NODE_DIRECT_PLACEHOLDER = Object.freeze({ domain: 'obnode-direct.invalid', cidr: '192.0.2.255/32' })
export const nodeDirectFile = (rulesetDir, tag) => `${rulesetDir}/${tag}.json`
// 配置里引用它们的规则集条目
export const nodeDirectRuleSets = (rulesetDir) => [NODE_DIRECT_DOMAIN_TAG, NODE_DIRECT_IP_TAG]
  .map((tag) => ({ type: 'local', tag, format: 'source', path: nodeDirectFile(rulesetDir, tag) }))
// 两个文件的内容:没有地址时是空规则集(内核认,什么都不命中)
export const nodeDirectSources = (directHosts) => {
  const domains = directHosts && Array.isArray(directHosts.domains) ? directHosts.domains : []
  const cidrs = directHosts && Array.isArray(directHosts.cidrs) ? directHosts.cidrs : []
  return {
    [NODE_DIRECT_DOMAIN_TAG]: { version: 3, rules: domains.length ? [{ domain: domains }] : [] },
    [NODE_DIRECT_IP_TAG]: { version: 3, rules: cidrs.length ? [{ ip_cidr: cidrs }] : [] },
  }
}
