// 直连应答放行:按域名访问的直连目标,入口不按 IP 名单把它拉进内核。
//
// 入口(nft)只看得到目标 IP。白名单模式下"必须进内核"的名单里有走代理的站点集的 geoip 集合(geoip-cloudflare、
// geoip-google 之类):它们只该管没有域名、直接按 IP 发起的连接(Telegram 那种),可挂在 Cloudflare / 谷歌云上的直连
// 网站(兜底直连的 config.immersivetranslate.com、Speed 站点集的 speedtest.net)解析出来的地址也在这些段里,入口分不
// 出域名,只好先送进内核,再由内核按域名走直连。
//
// 内核 tcp10 起(scripts/singbox-tcp-dns-hotfix 的 openbox_pkg*.go):DNS 直连侧解析器(dns-direct)的应答,在回给
// 客户端之前由内核同步写进 inet openbox 表里带超时的集合(system/entry-bypass.mjs 的 direct_answered4 / 6),命中的包
// 在入口打放行位放走(交给路由器自己的路由)。只写入口本来会送进内核的地址(tun 的 route_address_set 里有、
// route_exclude_address_set 里没有的),别的地址入口本来就放行,不用打。以前是面板盯内核日志事后补写,
// 客户端拿到地址立刻就连,第一条连接总抢在写入之前进内核;现在应答发出去时地址已经在集合里。
//
// 面板这边只管开关:有 nft 重定向、且部署算出来可以开(entryMode.directAnswer)时建开关文件 data/flip/direct-answer.on,
// 别的情况删掉、清空两个集合。入口白名单模式一直开;黑名单模式(兜底走代理)2026-09-29 起也开(#307,用户:选了直连的,
// 开着直连不进内核和 FakeIP 就不进内核),前提见 engine/routing-model.mjs 的 entryModePlan——有终端被指定走代理、前置
// 自定义分流按端口走代理时不开,按目标地址放行会放错。黑名单入口的进内核名单是 obflip-need-all(全部),内核 tcp10 起
// 就能按它写(2026-09-30 开发路由器上 tcp11 实测)。内核每次写之前读一下开关文件(服务脚本用环境变量
// OPENBOX_DIRECT_ANSWER_FLAG 把路径告诉它)。
//
// 内核 tcp11 起,元素按应答 TTL 活(最多一天:终端按 TTL 缓存,元素比缓存先到期的话连接又被拉进内核),内核退出时
// 把还没到期的元素存进同目录的 direct-answer.state,下次启动按剩余时间写回去(入口规则每次起内核都重建,集合是空的;
// 正式路由器升级后 a.nel.cloudflare.com 这种 TTL 十几个小时的连接全进了内核)。活得久了,旧的真实地址就不能一直
// 放行:开关文件的内容是一把「钥匙」(v1 <分流设置指纹> <时间戳>),分流设置改过、或者有站点集从直连切到代理 / 拒绝
// 时,面板清空两个集合、删掉存档、换一把钥匙、让 dnsmasq 丢掉缓存;内核读到钥匙变了就把自己的记录作废,存档里钥匙
// 对不上的也不恢复。反方向(代理 / 拒绝 → 直连)不用清:内核在入口名单变过之后自己删掉不再进内核的地址。
//
// 边界:终端自带加密 DNS(DoH)、或者用了路由器没见过的解析结果时,内核看不到这次解析,入口只能按 IP 判。
import { flushLocalDnsCaches } from './dns-cache.mjs'
import { signalDnsmasq } from './dnsmasq-signal.mjs'
import { DIRECT_ANSWERED_SET } from './entry-bypass.mjs'
import { flipDir } from './flip-files.mjs'

export const DIRECT_ANSWER_FLAG_NAME = 'direct-answer.on'
export const DIRECT_ANSWER_STATE_NAME = 'direct-answer.state'
// 内核每次 DNS 查询最多等多久(sing-box constant/timeout.go 的 DNSTimeout,生成的配置不改它)
export const KERNEL_DNS_TIMEOUT_MS = 10_000
// 换钥匙之后隔多久再换一遍、清一遍。热切换先写规则文件、最后写部署元数据,这里看到元数据变了才换第一次钥匙;内核
// 重载规则之前按旧规则发出去的直连查询,应答最晚在重载之后 KERNEL_DNS_TIMEOUT_MS 回来、按新钥匙写进集合。补清一遍要
// 在那之后:比 DNS 超时多留 5 秒,内核重载比面板这一轮慢不到 5 秒就都清得掉(GPT 复核第一项:以前是整 10 秒,
// 应答卡在超时边上、内核又重载得慢一点就漏过去)
export const DIRECT_ANSWER_REPEAT_MS = KERNEL_DNS_TIMEOUT_MS + 5_000
export const DIRECT_ANSWER_FLAG_ENV = 'OPENBOX_DIRECT_ANSWER_FLAG'
export const directAnswerFlagPath = (paths) => `${flipDir(paths)}/${DIRECT_ANSWER_FLAG_NAME}`
export const directAnswerStatePath = (paths) => `${flipDir(paths)}/${DIRECT_ANSWER_STATE_NAME}`

// 集合元素的超时:按 TTL,至少 15 分钟,最多一天。内核按同一个区间写(openbox_pkg.go 的 DirectAnswerTimeout)
export const elementTimeoutSec = (ttl) => Math.min(86400, Math.max(900, Number(ttl) || 0))

// 钥匙:v1 <分流设置指纹> <时间戳>。解不出来(老版本写的是一行时间)就当没有指纹
export const directAnswerKey = (routingHash, stamp) => `v1 ${routingHash || '-'} ${stamp}\n`
export const keyRoutingHash = (content) => {
  const m = /^v1 (\S+) \S+/.exec(String(content || ''))
  return m ? m[1] : null
}

// 开关该不该开:入口白名单模式,并且有 nft 重定向(纯 tun 没有入口集合可写)
// 有 nft 重定向时:白名单入口一直开;黑名单入口看部署算好的 entryMode.directAnswer(engine/routing-model.mjs 的
// entryModePlan,#307)。老元数据没有这个字段就只认白名单
export const directAnswerWanted = (meta) => {
  const entry = meta && meta.autoRedirect && meta.firstLayer && meta.firstLayer.entryMode
  return Boolean(entry && (entry.mode === 'whitelist' || entry.directAnswer === true))
}

// 常驻的开关管理:每 2 秒按部署元数据对一次(热切换改入口模式 / 站点集类别时元数据跟着变)
// signal:给 dnsmasq 发 HUP 的办法(dnsmasq-signal.mjs),测试换成假的
// repeatMs:换钥匙之后隔多久再换一遍、清一遍(见 DIRECT_ANSWER_REPEAT_MS)
export const createDirectAnswerSwitch = ({ ctx, paths, readMeta, log = () => {}, intervalMs = 2000, now = Date.now, signal = signalDnsmasq, repeatMs = DIRECT_ANSWER_REPEAT_MS }) => {
  let timer = null
  let stopped = true
  let checking = false
  let inflight = null
  let state = null // null:还没对过;true / false:上一次对完的结果
  let lastClasses = null // 上一次看到的各站点集类别:用来发现「从直连切到代理 / 拒绝」
  let repeatAt = 0 // 上一次换钥匙之后,到这个时刻再换一遍、清一遍(0 = 没有要补的)
  const flag = directAnswerFlagPath(paths)
  const stateFile = directAnswerStatePath(paths)
  const flushSets = async () => {
    for (const family of [4, 6]) await ctx.exec('nft', ['flush', 'set', 'inet', 'openbox', DIRECT_ANSWERED_SET[family]]).catch(() => {})
  }
  const writeKey = async (hash) => {
    await ctx.mkdirp(flipDir(paths))
    await ctx.writeFile(flag, directAnswerKey(hash, now()))
  }
  // 换钥匙:先写新钥匙,再清集合、删存档,最后让 dnsmasq 丢掉缓存。内核每次写之前读钥匙,读到新的就作废自己的记录;
  // 在这之前按旧状态写进去的(内核在锁外算好候选、还没写完的也算)这一清都没了。以前是先清再换,两步之间内核按旧
  // 钥匙写进去的会一直留着(审查第五项)。dnsmasq 不清的话终端的下一次查询由它拿缓存直接答了(TTL 长的要十几个小时),
  // 内核看不到、写不回去。返回清了哪几层缓存
  const rotate = async (hash) => {
    await writeKey(hash)
    await flushSets()
    await ctx.remove(stateFile)
    const flushed = await flushLocalDnsCaches(ctx, { signal })
    return [flushed.dnsmasq && 'dnsmasq', flushed.resolved && 'systemd-resolved'].filter(Boolean)
  }
  const tick = () => {
    if (checking || stopped) return inflight || Promise.resolve()
    checking = true
    inflight = check().finally(() => { checking = false; inflight = null })
    return inflight
  }
  const check = async () => {
    try {
      const meta = await readMeta()
      const want = directAnswerWanted(meta)
      const exists = await ctx.exists(flag)
      if (!want) {
        if (exists) {
          // 先关开关、再清集合:内核每次写之前都读开关,关掉之后不会再写
          await ctx.remove(flag)
          await ctx.remove(stateFile)
          await flushSets()
          log('[direct-answer] 入口不是白名单模式:关掉直连应答放行,清空入口放行集合')
        } else if (state === null) {
          // 面板刚起来、开关本来就是关的:集合里可能还有上次留下的(内核重启时服务脚本会重建表,这里只是兜底)
          await flushSets()
        }
        lastClasses = null
        repeatAt = 0
        state = false
        return
      }
      const hash = String(meta.routingHash || '-')
      const classes = (meta.firstLayer && meta.firstLayer.policyClasses) || {}
      if (!exists) {
        // 刚进白名单模式(离开时已经清过集合、删过存档)
        await writeKey(hash)
        log('[direct-answer] 入口白名单模式:打开直连应答放行(内核写入口放行集合)')
      } else {
        const lostDirect = lastClasses ? Object.keys(lastClasses).filter((name) => lastClasses[name] === 'direct' && classes[name] && classes[name] !== 'direct') : []
        const keyHash = keyRoutingHash(await ctx.readFile(flag).catch(() => ''))
        if (keyHash !== hash || lostDirect.length) {
          const caches = await rotate(hash)
          // 翻面之前发出去的直连查询,应答可能这之后才回来、按新钥匙写进去:隔一会儿再换一遍、清一遍
          repeatAt = now() + repeatMs
          log(`[direct-answer] ${lostDirect.length ? `站点集「${lostDirect.join('」「')}」从直连切走了` : '分流设置改过'}:换一把钥匙,清空入口放行集合${caches.length ? `,清 ${caches.join(' / ')} 的缓存` : ''}`)
        } else if (repeatAt && now() >= repeatAt) {
          repeatAt = 0
          await rotate(hash)
          log('[direct-answer] 再换一遍钥匙、清一遍入口放行集合(翻面之前发出去的查询晚到的应答)')
        }
      }
      lastClasses = { ...classes }
      state = true
    } catch (err) {
      log(`[direct-answer] 开关暂不可用:${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    start: () => {
      stopped = false
      tick()
      timer = setInterval(tick, intervalMs)
      timer.unref?.()
    },
    // 停掉之后不再开始新的一次;正在进行的那次(可能正在换钥匙、清集合)等它做完,不停在半路。返回它的 Promise
    stop: () => { stopped = true; clearInterval(timer); return inflight || Promise.resolve() },
    status: () => ({ enabled: state === true }),
    tick,
  }
}
