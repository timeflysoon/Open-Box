import { CLASH_API_BASE } from '../api/penetration.mjs'
import { signalDnsmasq } from './dnsmasq-signal.mjs'

// 清空内核的 DNS 缓存(clash_api 的 POST /cache/dns/flush,sing-box 1.13.14 实测回 204)。
//
// 为什么要清:走代理的域名是经节点问 1.1.1.1 的,内核把答案缓存下来——正式路由器实测
// 首次 67 到 246ms,命中缓存 1ms,所以缓存本身很值,平时不该关。但这份缓存不分线路:
// 换了节点,TTL 没过之前拿到的还是上一条线路问出来的地址,连上去的 CDN 就不是新线路
// 就近的那个。
//
// 所以只在两处清:换了出口之后(见 index.mjs),和用户点「重新测试」要看真实路由时
// (见 api/route-test.mjs)。清完下一次查询重新经当前线路问,几十毫秒,值。
export const flushDnsCache = async (fetchImpl = globalThis.fetch, secret = '', timeoutMs = 3000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${CLASH_API_BASE}/cache/dns/flush`, {
      method: 'POST',
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: controller.signal,
    })
    return res.ok
  } catch {
    // 内核没在跑、或者这个版本没有这个接口:清不了就算了,不该让调用方的主流程失败
    return false
  } finally {
    clearTimeout(timer)
  }
}

// 内核外面那两层缓存:dnsmasq——转发模式(domains / all)下局域网先问 dnsmasq,它自己也缓存一份;收到 SIGHUP 会清空缓存
// 并重读 hosts,不重启、不断服务——和 Debian / Ubuntu 上本机进程用的 systemd-resolved。没在跑 / 没有命令就跳过。
// 返回各自清掉没有。「清空 DNS 缓存」按钮和直连应答放行(清空入口放行集合之后,要让终端的下一次查询真的到达内核、
// 由内核重新写入,见 system/direct-answer-bypass.mjs)共用
// dnsmasq 的缓存用 SIGHUP 清,只发给真正的 dnsmasq 守护进程(dnsmasq-signal.mjs:killall 会连正在重启 dnsmasq 的 init 脚本一起打断)。
// 刚起来的那个缓存本来就是空的,不发也算清过
export const flushLocalDnsCaches = async (ctx, { signal = signalDnsmasq } = {}) => {
  let dnsmasq = false
  try {
    dnsmasq = signal('SIGHUP', { minAgeMs: 2000 }).found > 0
  } catch {
    // 看不了 /proc(不是 Linux)
  }
  let resolved = false
  try {
    if (await ctx.exists('/usr/bin/resolvectl')) resolved = (await ctx.exec('resolvectl', ['flush-caches'])).code === 0
  } catch {
    // 没有 systemd-resolved
  }
  return { dnsmasq, resolved }
}

// 「清空 DNS 缓存」按钮(DNS 设置页右上角,GitHub #148):用户觉得解析结果不对(换了线路、站点换了 CDN)时手动清一次。
// 内核的(上面那个接口)和外面两层(flushLocalDnsCaches)都清:只清内核的话终端拿到的还是 dnsmasq 手里的旧答案。
// 全都清不掉才算失败
export const registerDnsCacheRoutes = (app, { ctx, store, fetchImpl = globalThis.fetch, signal = signalDnsmasq }) => {
  app.post('/api/openbox/dns/flush-cache', async (_req, res) => {
    const kernel = await flushDnsCache(fetchImpl, store.getClashSecret())
    const { dnsmasq, resolved } = await flushLocalDnsCaches(ctx, { signal })
    if (!kernel && !dnsmasq && !resolved) return res.status(503).json({ kernel, dnsmasq, resolved, error: '内核没在运行,dnsmasq 也没在跑,没有可清的缓存' })
    return res.json({ kernel, dnsmasq, resolved })
  })
}
