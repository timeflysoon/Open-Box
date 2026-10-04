// 代理 DNS 上游走哪条线路:由「目标分流」按上游的地址判,和局域网终端访问这个地址走同一套规则
// (用户 2026-09-28:「访问规则应该统一」「全局就只有一个分流规则:目标分流」)。以前代理侧每个站点集各开一台解析器、
// 各自 detour 到自己的 selector,同一个 1.1.1.1 查 Dola 的域名经新加坡、查「国外」的经香港,和规则页查 1.1.1.1 的结论对不上。
// 判法就是规则页的推算(api/penetration.mjs 的 predictRoute),按上游选的协议当一条 TCP / UDP 连接判;部署时算一次写进解析器的
// detour(engine/dns.mjs 的 applyProxyUpstreamRoutes),「DNS 上游」卡片的测试按钮也用它(api/dns-upstream-test.mjs)。
// 命中站点集 / 兜底时出口是那个 selector:代理页换线路、站点集直连 / 代理翻面,解析器跟着走,不用重新部署
import { proxyExtraUpstreams, proxyUpstream } from '../engine/dns.mjs'
import { predictRoute } from './penetration.mjs'
import { builtinTags } from '../engine/user-groups.mjs'

// 返回 { server, port, protocol, outbound, reject, owner, chain, ruleIndex, error }:
//   outbound 命中规则的出口(站点集 / 兜底的 selector、前置自定义那一行的出口,内置直连也照写);reject 命中的是拒绝;
//   owner 命中的规则归谁(和规则页第 4 步同一套);chain 此刻从出口一路下钻到的节点;error 推算不出来(规则集读不了等)
export const routeForUpstream = async (deps, { server, port, protocol }) => {
  const base = { server, port, protocol }
  let result
  try {
    result = await predictRoute(deps, { target: server, port, network: protocol === 'udp' ? 'udp' : 'tcp' })
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
  const body = result.body || {}
  if (result.status !== 200) return { ...base, error: body.message || '推算失败' }
  if (body.matchError) return { ...base, error: body.matchError }
  // 拒绝有两种写法:动作 reject,或出口是内置的拒绝出站(前置自定义分流选「拒绝」的行)
  const builtin = builtinTags(deps.store && deps.store.getGroups ? deps.store.getGroups() : [])
  const reject = Boolean(body.matched && body.matched.action === 'reject') || body.finalOutbound === builtin.block
  return {
    ...base,
    outbound: reject ? '' : String(body.finalOutbound || ''),
    reject,
    owner: body.owner || null,
    chain: Array.isArray(body.chain) ? body.chain : [],
    ruleIndex: body.matched ? body.matched.index : null,
  }
}

// 档案里的代理侧上游(主上游 + 备用上游)各判一次。上游 DNS(deps.systemDns 是部署时读到的系统上游 DNS)固定直连,
// 不按目标分流判,直接记成直连
export const routeProxyDnsUpstreams = async (deps, profile) => {
  const options = { systemDns: Array.isArray(deps.systemDns) ? deps.systemDns : [] }
  const builtin = builtinTags(deps.store && deps.store.getGroups ? deps.store.getGroups() : [])
  const out = []
  for (const up of [proxyUpstream(profile, options), ...proxyExtraUpstreams(profile, options)]) {
    if (up.wan) out.push({ server: up.server, port: up.port, protocol: up.protocol, outbound: builtin.direct, reject: false, owner: null, chain: [], ruleIndex: null, wan: true })
    else out.push(await routeForUpstream(deps, { server: up.server, port: up.port, protocol: up.protocol }))
  }
  return out
}
