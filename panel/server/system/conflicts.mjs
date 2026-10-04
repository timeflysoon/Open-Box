import { serviceStatus } from './service.mjs'

export const CONFLICT_SERVICES = Object.freeze([
  { id: 'openclash', label: 'OpenClash', initd: '/etc/init.d/openclash' },
  { id: 'nikki', label: 'Nikki', initd: '/etc/init.d/nikki' },
  { id: 'passwall', label: 'PassWall', initd: '/etc/init.d/passwall' },
  { id: 'passwall2', label: 'PassWall2', initd: '/etc/init.d/passwall2' },
  { id: 'shadowsocksr', label: 'ShadowSocksR Plus+', initd: '/etc/init.d/shadowsocksr' },
  { id: 'homeproxy', label: 'HomeProxy', initd: '/etc/init.d/homeproxy' },
])

export const detectConflicts = async (ctx) => {
  const conflicts = []
  for (const svc of CONFLICT_SERVICES) {
    if (!(await ctx.exists(svc.initd))) continue
    const { running } = await serviceStatus(ctx, svc.initd)
    if (running) conflicts.push({ id: svc.id, label: svc.label, running: true })
  }
  return { conflicts, hasRunning: conflicts.length > 0 }
}

// 谁占着 53 端口。上面那张表只认六个**代理插件**的 init 脚本,认不出 AdGuard Home、
// GL.iNet 固件的「覆盖所有客户端 DNS」这类东西 —— 它们不是代理,不该拦着部署,但它们抢了 53
// 就会让终端的查询不经内核,现象是「域名分流不生效 / 网页打不开」(GitHub #200 就是 GL-MT6000)。
// 所以这里只**如实记录**谁在听 53,放进诊断包,排查时一眼能看见;不做拦截、不猜品牌。
// dnsmasq 和 sing-box 是自己人:正常接管时本来就是它们在听。
const OURS = /^(dnsmasq|sing-box)$/
const PORT_53 = /(?:^|\s)(?:[0-9.]+|\[[0-9a-f:]+\]|\*):53\s/i

export const detectDnsHolders = async (ctx) => {
  const holders = []
  for (const cmd of [['ss', ['-lnp']], ['netstat', ['-lnp']]]) {
    let out = ''
    try {
      const r = await ctx.exec(cmd[0], cmd[1], { timeoutMs: 5000 })
      out = (r && r.stdout) || ''
    } catch {
      continue
    }
    if (!out.trim()) continue
    for (const line of out.split('\n')) {
      if (!PORT_53.test(line)) continue
      // 进程名:netstat 是 `1234/dnsmasq`,ss 是 `users:(("dnsmasq",pid=1234,fd=5))`
      const m = /(\d+)\/([\w.+-]+)/.exec(line) || /\(\("([\w.+-]+)"/.exec(line)
      const name = m ? (m[2] || m[1]) : ''
      if (!name || OURS.test(name)) continue
      if (!holders.some((h) => h.process === name)) holders.push({ process: name, line: line.trim().slice(0, 200) })
    }
    if (out.trim()) break
  }
  return holders
}
