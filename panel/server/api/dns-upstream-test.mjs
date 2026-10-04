import express from 'express'
import net from 'node:net'
import { directUpstream, dnsStrategy } from '../engine/dns.mjs'
import { DEFAULT_DNS_PORT, DNS_PROTOCOLS, dnsRegionOf, dnsServerEntry, isValidDnsPort, isValidDnsUpstream, isWanUpstream, wanFallbackUpstream } from '../engine/dns-upstream.mjs'
import { DEFAULT_DIRECT_TEST_URL } from '../engine/test-url.mjs'
import { readSystemDns } from '../system/resolv.mjs'
import { routeForUpstream } from './dns-upstream-route.mjs'
import { upstreamOutbounds } from './node-latency.mjs'
import { builtinTags } from '../engine/user-groups.mjs'
import { PROBE_MARK } from '../system/node-probe.mjs'
import { cancelRegionDetect, detectRouterRegion, regionDetectPending } from '../system/router-region.mjs'

// DNS 上游测试:DNS 页「DNS 上游」卡片改完地址 / 协议自动保存,保存前真的用内核按选的协议向那台服务器
// 查一次,证明它确实说这个协议——TCP 53 不是每台 DNS 都开,选错了内核起来之后所有解析都超时。
// 做法和节点测速(api/node-latency.mjs)一样:写一份只含这台 DNS server 的临时配置,`sing-box tools fetch`
// 去取测速地址,取之前内核得先经这台服务器解析测速地址的域名——解析失败 stderr 里是
// "lookup <域名>: (...)",成功就是解析通了(取不到网页另说,那是线路问题不是 DNS 问题)。
//   · 直连侧:只有候选服务器一条,从路由器直接问
//   · 代理侧:连上游走哪条线路由「目标分流」按候选上游的地址判,和局域网终端访问这个地址、和部署时写进内核代理侧解析器的
//     是同一套(api/dns-upstream-route.mjs;用户 2026-09-28「全局就只有一个分流规则:目标分流」)。判出来的出口此刻落到
//     哪个节点(链式代理连同它的上游),就把那几个出站放进临时配置,候选服务器 detour 过去。fetch 本身仍走 direct 出站,
//     并把 direct 的 domain_resolver 钉在候选服务器上——不能让 fetch 从节点出去(-o):代理出站把域名原样交给远端解析,
//     候选 DNS 根本不会被问到,测出来永远"可用"(开发路由器实测 DoQ 打 1.1.1.1 也 200ms"通过")。
//     节点自己的域名用直连侧解析器(bootstrap)解析,和正式配置的 dns-direct 一个口径。
//     目标分流让这个地址走直连 → 就从路由器直连测(那就是真实路径);判成拒绝 → 不测,直接说内核不会去问它;
//     判不出来(规则集读不了)或出口此刻落在测不了的出站上(wireguard 等)→ 退回从路由器直连测,note 说明
// 临时实例自己发的包打上内核的出站标记(和节点测速 system/node-probe.mjs 一样,只 Linux 认):不打的话路由器上正在跑的内核
// 把它当本机流量接走,TUIC / Hysteria 这类走 UDP 的节点直接 sendmsg: operation not permitted(2026-09-28 正式路由器,
// 「国外」落在 TUIC 节点)。正式内核自己连上游本来就带这个标记
const probeRoute = (platform, route) => (platform === 'linux' ? { ...route, default_mark: PROBE_MARK } : route)
const PROBE_CONFIG = 'config.dns-probe.json'
const PROBE_SERVER = 'probe'
const BOOTSTRAP_SERVER = 'bootstrap'
// 内核 DNS 一次查询的期限是 10 秒(实测 tools fetch 对不应答的服务器 10.0s 报 context deadline exceeded),
// 进程上限给到 15 秒,再往上就是卡死
const DEFAULT_TIMEOUT_MS = 15000

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '')

// 把内核 stderr 的最后一行翻成人话。返回 { dnsFailed, reason }:dnsFailed=false 表示解析通了、
// 是后面取网页失败(或根本没报错)
export const describeFetchFailure = (stderr, host) => {
  const lines = stripAnsi(stderr).split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines.at(-1) || ''
  const at = host ? last.indexOf(`lookup ${host}: `) : -1
  if (at < 0) return { dnsFailed: false, reason: last.replace(/^FATAL\[\d+\]\s*/, '').slice(0, 200) }
  let inner = last.slice(at + `lookup ${host}: `.length).trim()
  if (inner.startsWith('(') && inner.endsWith(')')) inner = inner.slice(1, -1)
  // A / AAAA 两路各报一次,取第一路的原因就够了
  const first = inner.split(' | ')[0].replace(/^exchange[46]:\s*/, '')
  let reason
  if (/context deadline exceeded|i\/o timeout/i.test(first)) reason = '超时没有应答:该地址可能不支持此协议,或这条线路不通'
  else if (/connection refused/i.test(first)) reason = '连接被拒绝:该地址在此协议的端口上没有服务'
  else if (/reset by peer/i.test(first)) reason = '连接被重置:该地址在此协议的端口上没有服务,或被拦'
  else if (/x509|certificate|tls|handshake/i.test(first)) reason = `TLS 握手失败:${first}`
  else if (/^(NXDOMAIN|SERVFAIL|REFUSED|FORMERR|NOTIMP)/.test(first)) reason = `上游回了 ${first.split(/\s/)[0]}:它不认测速地址的域名,换一台上游`
  else reason = first
  return { dnsFailed: true, reason: reason.slice(0, 200) }
}

const hostOfUrl = (url) => {
  try { return new URL(url).hostname } catch { return '' }
}
// 测速地址必须带域名,否则根本不会发生解析;用户把测速地址改成了 IP 就退回默认那条
const probeUrl = (configured, fallback) => {
  const url = typeof configured === 'string' && configured.trim() ? configured.trim() : fallback
  const host = hostOfUrl(url)
  return host && !net.isIP(host) ? { url, host } : { url: fallback, host: hostOfUrl(fallback) }
}

// routeFor / outboundsFor 换成假的给测试用:按目标分流判线路(api/dns-upstream-route.mjs)、把出口此刻落到的节点(连同链式
// 代理的上游)生成出站(api/node-latency.mjs,节点测速同一套)
// 「恢复默认」那次判地区等多久:界面上有人等着,比启动时后台判的短
const REGION_DETECT_TIMEOUT_MS = 8000

export const registerDnsUpstreamTestRoutes = (app, { ctx, paths, store, fetchImpl = globalThis.fetch, systemDnsReader = readSystemDns, routeFor = routeForUpstream, outboundsFor = upstreamOutbounds, platform = process.platform, detectRegion = detectRouterRegion } = {}) => {
  const router = express.Router({ caseSensitive: true })
  router.use(express.json({ limit: '64kb' }))

  // GET /api/openbox/dns/wan → { servers }:系统此刻的上游 DNS(接口上 DHCP 分配或手动指定的;「上游 DNS」那一行显示用)
  router.get('/dns/wan', async (_req, res) => {
    let servers = []
    try { servers = await systemDnsReader(ctx) } catch { servers = [] }
    res.json({ servers: Array.isArray(servers) ? servers : [] })
  })

  // GET /api/openbox/dns/region-detect → { pending, region }:启动时那次后台判地区(system/router-region.mjs)还没做完、
  // 档案里此刻的地区。「DNS 上游」卡片打开时还没做完就显示「正在判断」、隔几秒问一次,做完了重新读档案;已经做完但和页面上
  // 的地区不一样(恰好在页面读档案之后判完)也重新读——不然页面停在判之前的「中国」(用户 2026-10-02,新加坡 / us-wv)
  router.get('/dns/region-detect', (_req, res) => {
    res.json({ pending: regionDetectPending(store), region: dnsRegionOf(store.getProfile() || {}) })
  })

  // POST /api/openbox/dns/region-detect → { region: 'cn' | 'intl' | null, ip }:按出口公网 IP 判一次路由器在哪
  // (system/router-region.mjs)。「DNS 上游」卡片的「恢复默认」先调它,再把两侧换成那个地区的默认值;判不出 region 是 null。
  // 判出来的和档案里的地区一样就顺手清掉启动时那次的待判定(不一样的由卡片保存地区时清,api/profile.mjs)
  router.post('/dns/region-detect', async (_req, res) => {
    let result
    try {
      result = await detectRegion({ store, ctx, paths, platform, systemDnsReader, timeoutMs: REGION_DETECT_TIMEOUT_MS })
    } catch (err) {
      result = { region: null, ip: '', error: (err && err.message) || String(err) }
    }
    if (result.region && result.region === dnsRegionOf(store.getProfile() || {})) cancelRegionDetect(store)
    res.json({ region: result.region || null, ip: result.ip || '', ...(result.error ? { error: result.error } : {}) })
  })

  // POST /api/openbox/dns/upstream-test  { side: 'direct' | 'proxy', server, protocol, port? }
  //   → { ok, ms, server, protocol, port, via, policy?, note?, error?, warning?, wan? }
  //   via:经哪个节点测的(空 = 从路由器直连测);policy:那个节点是哪个站点集 / 兜底此刻选中的。
  //   server 可以是「上游 DNS」记号 wan:测的是系统此刻上游 DNS 的第一台(读不到按地区退回),固定直连,回的 server 是那台的地址
  router.post('/dns/upstream-test', async (req, res) => {
    const body = req.body || {}
    const side = body.side === 'proxy' ? 'proxy' : body.side === 'direct' ? 'direct' : ''
    const raw = typeof body.server === 'string' ? body.server.trim() : ''
    const wan = isWanUpstream(raw)
    // 上游 DNS 固定 UDP 53(协议、端口跟着上游走,传了别的也不认)
    const protocol = wan ? 'udp' : body.protocol
    const port = wan || body.port === undefined ? DEFAULT_DNS_PORT : body.port
    if (!side) return res.status(400).json({ error: 'side must be direct or proxy' })
    if (!wan && !isValidDnsUpstream(raw)) return res.status(400).json({ error: '只填 IP 地址' })
    if (!DNS_PROTOCOLS.includes(protocol)) return res.status(400).json({ error: `protocol must be one of ${DNS_PROTOCOLS.join(', ')}` })
    if (!isValidDnsPort(port)) return res.status(400).json({ error: '端口填 1~65535' })
    if (!(await ctx.exists(paths.singbox))) return res.status(503).json({ error: `内核还没装好:${paths.singbox}` })

    const profile = store.getProfile() || {}
    let systemDns = []
    try { systemDns = await systemDnsReader(ctx) } catch { systemDns = [] }
    const server = wan ? ((Array.isArray(systemDns) ? systemDns : []).find(Boolean) || wanFallbackUpstream(dnsRegionOf(profile))) : raw
    const candidate = { protocol, server, port }
    let config
    let url
    let via = ''
    let chain = []
    let policy = ''
    let note = ''
    let host
    if (side === 'direct' || wan) {
      // 直连侧、以及代理侧的上游 DNS(固定直连):候选服务器一条,从路由器直接问
      if (side === 'proxy') note = '上游 DNS 固定直连,从路由器直接测'
      ;({ url, host } = probeUrl(profile.directTestUrl, DEFAULT_DIRECT_TEST_URL))
      config = {
        log: { level: 'error', timestamp: false },
        dns: { servers: [dnsServerEntry(candidate, PROBE_SERVER)], final: PROBE_SERVER, strategy: dnsStrategy(profile) },
        outbounds: [{ type: 'direct', tag: 'direct' }],
        route: probeRoute(platform, { default_domain_resolver: PROBE_SERVER }),
      }
    } else {
      // 取网页那步从路由器直连出去,所以两侧都用直连测速地址;解析那步才是经线路的
      ;({ url, host } = probeUrl(profile.directTestUrl, DEFAULT_DIRECT_TEST_URL))
      const builtin = builtinTags(store.getGroups ? store.getGroups() : [])
      const directConfig = () => ({
        log: { level: 'error', timestamp: false },
        dns: { servers: [dnsServerEntry(candidate, PROBE_SERVER)], final: PROBE_SERVER, strategy: dnsStrategy(profile) },
        outbounds: [{ type: 'direct', tag: 'direct' }],
        route: probeRoute(platform, { default_domain_resolver: PROBE_SERVER }),
      })
      const route = await routeFor({ store, ctx, paths, fetchImpl }, candidate)
      // 命中的是哪个站点集 / 前置自定义分流:和规则页第 4 步一样的名字
      const ownerName = route.owner && (route.owner.kind === 'policy' || route.owner.kind === 'custom') ? route.owner.name : ''
      if (route.error) {
        note = `按目标分流判不出 ${server} 走哪条线路(${route.error}),这次从路由器直连测`
        config = directConfig()
      } else if (route.reject) {
        return res.json({ ok: false, ms: 0, server, protocol, port, via: '', error: `目标分流拒绝访问 ${server}(第 ${Number(route.ruleIndex) + 1} 条${ownerName ? `,「${ownerName}」` : ''}),内核不会去问它` })
      } else if (!route.outbound || route.outbound === builtin.direct || (route.chain.length && route.chain[route.chain.length - 1] === builtin.direct)) {
        note = `按目标分流,${server} 走直连${ownerName ? `(「${ownerName}」)` : ''}`
        config = directConfig()
      } else {
        // 规则页那样显示:出口是站点集 / 兜底时去掉链路开头的站点集,只写它此刻下钻到的那一串
        const hops = route.chain.length ? route.chain : [route.outbound]
        const shown = ownerName && hops[0] === ownerName && hops.length > 1 ? hops.slice(1) : hops
        let up = null
        try {
          up = await outboundsFor({ store, fetchImpl, upstream: route.outbound })
        } catch (err) {
          note = `目标分流给 ${server} 的线路「${route.outbound}」此刻测不了(${(err && err.message) || err}),这次从路由器直连测`
        }
        if (up) {
          via = shown.join(' → ')
          // 逐跳交给前端显示:故障转移的内部子组(__fo:…)要换成页签名,和规则页一样
          chain = shown
          policy = ownerName || route.outbound
          config = {
            log: { level: 'error', timestamp: false },
            dns: {
              servers: [dnsServerEntry(directUpstream(profile, { systemDns }), BOOTSTRAP_SERVER), dnsServerEntry(candidate, PROBE_SERVER, up.via), ...up.dnsServers],
              final: BOOTSTRAP_SERVER,
              // 地址族和正式内核一样(没开 IPv6 只要 A):节点域名从运营商 DNS 拿到 AAAA 往 v6 发包,路由器上是
              // sendmsg: operation not permitted(2026-09-28 正式路由器,TUIC 节点)
              strategy: dnsStrategy(profile),
            },
            // direct 排第一就是默认出站;它解析目标域名只问候选服务器(经线路),节点自己的域名按 route 的默认解析器(bootstrap)
            outbounds: [{ type: 'direct', tag: 'direct', domain_resolver: { server: PROBE_SERVER } }, ...up.outbounds],
            route: probeRoute(platform, { default_domain_resolver: BOOTSTRAP_SERVER, final: 'direct' }),
          }
        } else {
          config = directConfig()
        }
      }
    }

    const configPath = `${paths.etc}/${PROBE_CONFIG}`
    try {
      await ctx.mkdirp(paths.etc)
      await ctx.writeFile(configPath, JSON.stringify(config, null, 2))
    } catch (err) {
      return res.status(500).json({ error: `写不了临时配置:${(err && err.message) || err}` })
    }
    const startedAt = Date.now()
    let result
    try {
      result = await ctx.exec(paths.singbox, ['tools', 'fetch', '-c', configPath, url], { timeoutMs: DEFAULT_TIMEOUT_MS })
    } finally {
      // 临时配置里有节点凭据,用完就删
      try { await ctx.remove(configPath) } catch { /* 删不掉下次会覆盖 */ }
    }
    const ms = Date.now() - startedAt
    const base = { server, protocol, port, via, ...(wan ? { wan: true } : {}), ...(chain.length ? { chain } : {}), ...(policy ? { policy } : {}), ...(note ? { note } : {}) }
    if (result.code === 0) return res.json({ ok: true, ms, ...base })
    if (!String(result.stderr || '').trim()) return res.json({ ok: false, ms, ...base, error: '超时没有应答:该地址可能不支持此协议,或这条线路不通' })
    const failure = describeFetchFailure(result.stderr, host)
    if (failure.dnsFailed) return res.json({ ok: false, ms, ...base, error: failure.reason })
    // 解析通了,是取网页那步没成:DNS 本身没问题
    return res.json({ ok: true, ms, ...base, warning: `解析成功,但取测速地址失败:${failure.reason}` })
  })

  app.use('/api/openbox', router)
}
