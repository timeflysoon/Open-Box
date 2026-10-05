// 路由器在中国大陆还是中国大陆之外(档案 dns.region:cn / intl;用户 2026-10-02;港澳台算之外——geoip-cn 只含中国大陆)。它决定 DNS 上游的默认值、代理侧能不能用
// 上游 DNS(engine/dns-upstream.mjs 的 regionDnsDefaults / regionDnsError)。
//
// 老设备升级到这版、全新安装第一次启动时档案里还没有 dns.region:
//   1. prepareDnsRegion(启动时同步做):先按中国大陆记下,顺带把直连 DNS 换成「上游 DNS」——以前直连侧本来就是系统的上游 DNS
//      优先、档案里填的那台只在读不到时兜底,换过去生效的还是同一台;备用上游照留。再记一个「待判定」
//   2. startRegionDetect(后台,不挡启动):按出口公网 IP 判一次(用户选的)。临时 sing-box 实例只有 direct 出站、发的包
//      打内核的出站标记(和测速、DNS 上游测试一样,不经正在跑的内核),取两家国内 DDNS 的 IP 回显——开发路由器、ubuntu23、
//      英国 VPS 实测都回真实出口;myip.ipip.net、ipify、1.1.1.1 这类「IP 检测」站会被上一级路由器的分流送进代理,
//      回的是节点的 IP(开发路由器在正式路由器后面,同一时刻回出美国、香港两个地址)。IP 查随包的 geoip-cn。
//      判成中国大陆之外:代理 DNS 还是出厂那台(TCP 1.1.1.1:53、没有备用)的换成上游 DNS
//   3. 判不出(都取不到 / 没有 geoip 数据)隔一阵再试:30 秒、1 分钟、2 分钟、5 分钟、10 分钟、10 分钟,剩下的下次启动再判;
//      用户自己切过地区就不判了。升级时面板起来没多久升级脚本就重新部署、重启内核,第一次判正好撞上的话不能干等 10 分钟
//      (用户 2026-10-02:新加坡的路由器升级后没自动切到「中国之外」)
// 「DNS 上游」卡片的「恢复默认」也先判一次(api/dns-upstream-test.mjs 的 POST /dns/region-detect,用户 2026-10-02:
// 「恢复默认应该要自动检测地区,出口在中国境内要切回中国并恢复默认 DNS 设置」)
import net from 'node:net'
import { DEFAULT_DNS_PORT, DEFAULT_PROXY_UPSTREAM, DNS_REGIONS, WAN_UPSTREAM, dnsServerEntry, isWanUpstream } from '../engine/dns-upstream.mjs'
import { directUpstream } from '../engine/dns.mjs'
import { effectiveShareRegions } from '../engine/share-regions.mjs'
import { dropRuleSetIndex, ipIndexHas, loadRuleSetIndex } from './ruleset-index.mjs'
import { rulesetPath } from './rulesets.mjs'
import { readSystemDns } from './resolv.mjs'
import { PROBE_MARK } from './node-probe.mjs'

// 部署之前(升级脚本 / open-box start 调 cli/deploy.mjs)还没判出地区:当场判一次并落下,生成的配置直接用那个地区的 DNS
// 默认值——不然国外的路由器升级完,要等面板后台判完、改了代理 DNS,再手动重启一次内核(用户 2026-10-02,us-wv)。
// 判不出返回 null,照常部署,面板后台还会接着判
export const settleRegionBeforeDeploy = async ({ store, ctx, paths, platform = process.platform, timeoutMs = 8000, detect = (deps) => detectRouterRegion(deps) } = {}) => {
  prepareDnsRegion(store)
  if (!regionDetectPending(store)) return null
  const r = await detect({ store, ctx, paths, platform, timeoutMs })
  if (!r || !r.region || !regionDetectPending(store)) return null
  return { ...r, changed: applyDetectedRegion(store, r.region) }
}

// 「待判定」记在裸键里,不进档案(档案会被导出 / 备份,这个只是本机的进度)
export const REGION_DETECT_KEY = 'openbox/dns-region-detect'
export const EGRESS_IP_URLS = Object.freeze(['https://ip.3322.net', 'https://ddns.oray.com/checkip'])
const GEOIP_CN_TAG = 'geoip-cn'
// 临时配置每次一个文件:启动时的后台判定和「恢复默认」那次可能同时在跑,用同一个文件会互相改掉 / 删掉
let probeSeq = 0
const probeConfigName = () => `config.region-probe-${++probeSeq}.json`
const FETCH_TIMEOUT_MS = 15000

// 启动时:还没定地区就先按中国大陆记下 + 直连 DNS 换成上游 DNS + 记待判定。返回 true = 这次做了
export const prepareDnsRegion = (store) => {
  const dns = (store.getProfile() || {}).dns || {}
  if (DNS_REGIONS.includes(dns.region)) return false
  store.setProfile({ dns: { region: 'cn', direct: WAN_UPSTREAM } })
  store.setRaw(REGION_DETECT_KEY, 'pending')
  return true
}
export const regionDetectPending = (store) => store.getRaw(REGION_DETECT_KEY) === 'pending'
// 用户自己切了地区(api/profile.mjs 的 PUT):不再自动判
export const cancelRegionDetect = (store) => store.delRaw(REGION_DETECT_KEY)

// 私网 / 保留段不算出口:回显给的是这种地址,说明前面还有一层转发,判不了
const isPublicIpv4 = (ip) => {
  const [a, b] = ip.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}
// 回显正文里的第一个公网 IPv4(ip.3322.net 只回地址;oray 回「Current IP Address: x.x.x.x」)
export const parseEgressIp = (text) => {
  const m = String(text || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)
  return m && net.isIP(m[0]) === 4 && isPublicIpv4(m[0]) ? m[0] : ''
}

// 从路由器直连取出口公网 IP:几家一起取,哪家先给出合法 IP 就用哪家,不等慢的那家(us-wv 升级时一家卡到 15 秒超时,
// 判定拖到 30 秒,页面上一直是「中国」);都取不到返回 ''。域名用直连侧的解析器解析
export const fetchEgressIp = async ({ ctx, paths, profile = {}, systemDns = [], platform = process.platform, urls = EGRESS_IP_URLS, timeoutMs = FETCH_TIMEOUT_MS }) => {
  if (!(await ctx.exists(paths.singbox))) return ''
  const config = {
    log: { level: 'error', timestamp: false },
    dns: { servers: [dnsServerEntry(directUpstream(profile, { systemDns }), 'resolver')], final: 'resolver' },
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { default_domain_resolver: 'resolver', ...(platform === 'linux' ? { default_mark: PROBE_MARK } : {}) },
  }
  const configPath = `${paths.etc}/${probeConfigName()}`
  try {
    await ctx.mkdirp(paths.etc)
    await ctx.writeFile(configPath, JSON.stringify(config, null, 2))
  } catch {
    return ''
  }
  try {
    const pending = urls.map((url) => ctx.exec(paths.singbox, ['tools', 'fetch', '-c', configPath, url], { timeoutMs })
      .then((r) => (r && r.code === 0 ? parseEgressIp(r.stdout) : ''), () => ''))
    // 临时配置每个进程起来时就读完了,先拿到结果就可以删(慢的那家照样跑到它自己的超时)
    return await new Promise((resolve) => {
      let left = pending.length
      if (!left) resolve('')
      for (const p of pending) p.then((ip) => { if (ip) resolve(ip); else if (--left === 0) resolve('') })
    })
  } finally {
    try { await ctx.remove(configPath) } catch { /* 删不掉下次覆盖 */ }
  }
}

// IP 在不在 geoip-cn(和内核同一份,在安装包的 geo 目录):true / false;没有 geoip 数据返回 null
export const ipInChina = async ({ ctx, paths, ip, loadCnIndex = () => loadRuleSetIndex(ctx, paths, GEOIP_CN_TAG, rulesetPath(paths, GEOIP_CN_TAG)) }) => {
  const index = await loadCnIndex().catch(() => null)
  if (!index || !index.ip) return null
  return ipIndexHas(index.ip, ip)
}

// 判一次:{ region: 'cn' | 'intl' | null, ip }
export const detectRouterRegion = async ({ store, ctx, paths, platform = process.platform, systemDnsReader = readSystemDns, egressIp = fetchEgressIp, inChina = ipInChina, timeoutMs = FETCH_TIMEOUT_MS }) => {
  const systemDns = await systemDnsReader(ctx).catch(() => [])
  const ip = await egressIp({ ctx, paths, profile: store.getProfile() || {}, systemDns, platform, timeoutMs })
  if (!ip) return { region: null, ip: '' }
  const cn = await inChina({ ctx, paths, ip })
  if (cn === null) return { region: null, ip }
  return { region: cn ? 'cn' : 'intl', ip }
}

// 判出来了:记下地区、清掉待判定;判成中国大陆之外时,代理 DNS 还是出厂那台(TCP 1.1.1.1:53、没有备用)的换成上游 DNS;
// 判成中国大陆时代理侧不能留着上游 DNS(中国大陆的 DNS 对境外域名有污染,engine/dns-upstream.mjs 的 regionDnsError):主上游换回
// 中国大陆的默认(TCP 1.1.1.1),备用里的上游 DNS 去掉。返回这次改了档案的哪些字段
export const applyDetectedRegion = (store, region) => {
  const dns = (store.getProfile() || {}).dns || {}
  const patch = {}
  if (dns.region !== region) patch.region = region
  const extras = Array.isArray(dns.proxyExtras) ? dns.proxyExtras : []
  if (region === 'intl') {
    const untouched = dns.proxy === DEFAULT_PROXY_UPSTREAM && (dns.proxyProtocol || 'tcp') === 'tcp' && (dns.proxyPort ?? DEFAULT_DNS_PORT) === DEFAULT_DNS_PORT && !extras.length
    if (untouched) Object.assign(patch, { proxy: WAN_UPSTREAM, proxyProtocol: 'udp', proxyPort: DEFAULT_DNS_PORT })
  } else {
    if (isWanUpstream(dns.proxy)) Object.assign(patch, { proxy: DEFAULT_PROXY_UPSTREAM, proxyProtocol: 'tcp', proxyPort: DEFAULT_DNS_PORT })
    if (extras.some((x) => x && isWanUpstream(x.server))) patch.proxyExtras = extras.filter((x) => !(x && isWanUpstream(x.server)))
  }
  if (Object.keys(patch).length) store.setProfile({ dns: patch })
  store.delRaw(REGION_DETECT_KEY)
  return patch
}

// 后台判:启动后等几秒再判(判定的包打内核出站标记、不经内核,不用等内核起来);判不出按 retryDelaysMs 依次再试,用完就等下次启动。
// 判的时候用户切了地区(待判定被清掉)就不落结果
export const REGION_RETRY_DELAYS_MS = Object.freeze([30_000, 60_000, 120_000, 300_000, 600_000, 600_000])
export const startRegionDetect = ({ store, ctx, paths, log = () => {}, delayMs = 3_000, retryDelaysMs = REGION_RETRY_DELAYS_MS, detect = detectRouterRegion, platform = process.platform } = {}) => {
  let timer = null
  let tries = 0
  let stopped = false
  const schedule = (ms) => {
    timer = setTimeout(() => { run() }, ms)
    if (timer.unref) timer.unref()
  }
  const run = async () => {
    timer = null
    if (stopped || !regionDetectPending(store)) return null
    tries += 1
    let result
    try {
      result = await detect({ store, ctx, paths, platform })
    } catch (error) {
      result = { region: null, ip: '', error: error instanceof Error ? error.message : String(error) }
    }
    if (stopped || !regionDetectPending(store)) return null
    if (result.region) {
      const changed = applyDetectedRegion(store, result.region)
      const proxyNote = !changed.proxy ? '' : isWanUpstream(changed.proxy) ? ',代理 DNS 换成上游 DNS' : `,代理 DNS 换回 ${changed.proxyProtocol.toUpperCase()} ${changed.proxy}`
      log(`[dns-region] 出口 IP ${result.ip} → 路由器在${result.region === 'intl' ? '中国大陆之外' : '中国大陆'}${proxyNote}`)
      return result.region
    }
    log(`[dns-region] 第 ${tries} 次没判出路由器在哪:${result.ip ? `出口 IP ${result.ip} 查不了 geoip` : result.error || '取不到出口 IP'}`)
    if (tries <= retryDelaysMs.length && !stopped) schedule(retryDelaysMs[tries - 1])
    return null
  }
  if (regionDetectPending(store)) schedule(delayMs)
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    runNow: run,
  }
}

// ---- 出口 IP 在哪个国家 / 地区(设置 · 客户端「路由器标识」的地区,没手动选就按它;用户 2026-10-04)----
// 按随包的 geoip-xx 一份份查,只认两个字母的(geoip-cloudflare / google / telegram 这类不是国家,不然 Cloudflare 出口的 IP
// 会被判成 cloudflare)。常见的和地区分流里出现的先查、命中就停;每查完一份就放掉(正式路由器只有 1 GB,一份一次 decompile,
// 见 system/ruleset-index.mjs 开头)。结果按出口 IP 记在裸键里(本机的,不进档案、不进导出),出口 IP 没变就不再查
export const EGRESS_COUNTRY_KEY = 'openbox/egress-country'
export const COMMON_COUNTRIES = Object.freeze(['cn', 'hk', 'tw', 'mo', 'jp', 'sg', 'us', 'kr', 'gb', 'de', 'fr', 'nl', 'ca', 'au', 'ru', 'in', 'my', 'th', 'vn', 'ph', 'id', 'ae', 'tr', 'it', 'es'])

// 随包 geoip 里的国家(规则库清单 manifest.json 的 files);读不到清单就只查常见的
const geoipCountries = async (ctx, paths) => {
  try {
    const manifest = JSON.parse(await ctx.readFile(`${paths.geoDir}/manifest.json`))
    return Object.keys(manifest.files || {}).map((file) => (/^geoip-([a-z]{2})\.srs$/.exec(file) || [])[1]).filter(Boolean)
  } catch {
    return [...COMMON_COUNTRIES]
  }
}

// IP 在哪个国家:两位代码(大写);判不出 ''。first:先查的几个(地区分流里出现的)
export const ipCountry = async ({
  ctx, paths, ip, first = [],
  countries = () => geoipCountries(ctx, paths),
  load = (tag) => loadRuleSetIndex(ctx, paths, tag, rulesetPath(paths, tag)),
  drop = dropRuleSetIndex,
}) => {
  const all = await countries()
  const order = [...new Set([...first.map((c) => String(c).toLowerCase()), ...COMMON_COUNTRIES, ...all])].filter((c) => all.includes(c))
  for (const cc of order) {
    const tag = `geoip-${cc}`
    const index = await load(tag).catch(() => null)
    const hit = Boolean(index && index.ip && ipIndexHas(index.ip, ip))
    drop([tag])
    if (hit) return cc.toUpperCase()
  }
  return ''
}

// 记下的结果:{ ip, country, at };没有 / 坏了是 null
export const readEgressCountry = (store) => {
  try {
    const value = JSON.parse(store.getRaw(EGRESS_COUNTRY_KEY) || 'null')
    return value && /^[A-Z]{2}$/.test(value.country) ? value : null
  } catch {
    return null
  }
}

// 判一次:取出口 IP(和 DNS 判地区同一个 fetchEgressIp);和上次同一个 IP 就用上次的国家,不再查规则集。
// 回 { country, ip, at }:取不到出口 IP / 查不出时 country 是上次记下的(没有就 '')
export const detectEgressCountry = async ({
  store, ctx, paths, platform = process.platform, systemDnsReader = readSystemDns, egressIp = fetchEgressIp, country = ipCountry,
  now = Date.now, timeoutMs = FETCH_TIMEOUT_MS,
}) => {
  const last = readEgressCountry(store)
  const systemDns = await systemDnsReader(ctx).catch(() => [])
  const ip = await egressIp({ ctx, paths, profile: store.getProfile() || {}, systemDns, platform, timeoutMs })
  if (!ip) return { country: last ? last.country : '', ip: '', at: last ? last.at : 0 }
  if (last && last.ip === ip) {
    const record = { ...last, at: now() }
    store.setRaw(EGRESS_COUNTRY_KEY, JSON.stringify(record))
    return record
  }
  const first = effectiveShareRegions(store.getProfile() || {}).flatMap((g) => g.regions || [])
  const cc = await country({ ctx, paths, ip, first })
  if (!cc) return { country: last ? last.country : '', ip, at: last ? last.at : 0 }
  const record = { ip, country: cc, at: now() }
  store.setRaw(EGRESS_COUNTRY_KEY, JSON.stringify(record))
  return record
}

// 启动后在后台判一次(不挡启动):还没判过、或者上次判已经超过一周。判不出就算了,打开「客户端」页签时会再判
export const startEgressCountryDetect = ({ store, ctx, paths, log = () => {}, delayMs = 60_000, maxAgeMs = 7 * 24 * 3600 * 1000, detect = detectEgressCountry, now = Date.now, platform = process.platform } = {}) => {
  const last = readEgressCountry(store)
  if (last && now() - last.at < maxAgeMs) return null
  const timer = setTimeout(async () => {
    try {
      const r = await detect({ store, ctx, paths, platform })
      if (r.country) log(`[egress-country] 出口 IP ${r.ip || '(取不到)'} → ${r.country}`)
    } catch (error) {
      log(`[egress-country] 没判出出口国家:${error instanceof Error ? error.message : String(error)}`)
    }
  }, delayMs)
  if (timer.unref) timer.unref()
  return { stop: () => clearTimeout(timer) }
}

