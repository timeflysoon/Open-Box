import { serviceStatus } from './service.mjs'

// 同一台路由器上不能同时运行两个代理工具(用户 2026-10-05:检测到其他代理工具就禁止启动,并明确提示):两边都要接管防火墙、
// DNS、路由。GitHub #426:PassWall 的 7 个 sing-box 都在跑,它挂在 fw4 上的脚本让每次防火墙重载拖几十秒,内核卡在启动、
// 面板里看着在跑其实不工作。
// process:这个插件在跑时常驻进程命令行里会出现的运行目录。PassWall / OpenClash / SSR+ 的 init 脚本不是 procd 那套,
// 自己起进程,`init.d status` 认不出它们在跑,所以再按进程认一遍。只认运行目录(PassWall 的程序都从 /tmp/etc/passwall 起),
// 不认 /usr/share/passwall 这类脚本目录:插件关着时它的界面 / 定时任务也会临时跑那里的脚本。
// init 脚本(openwrt/initd/openbox 的 openbox_conflicts)有同一份名单,initd-contract 测试核对两边一致
export const CONFLICT_SERVICES = Object.freeze([
  { id: 'openclash', label: 'OpenClash', initd: '/etc/init.d/openclash', process: /\/etc\/openclash\// },
  { id: 'nikki', label: 'Nikki', initd: '/etc/init.d/nikki', process: /\/etc\/nikki\// },
  { id: 'passwall', label: 'PassWall', initd: '/etc/init.d/passwall', process: /\/(?:tmp|var)\/etc\/passwall\// },
  { id: 'passwall2', label: 'PassWall2', initd: '/etc/init.d/passwall2', process: /\/(?:tmp|var)\/etc\/passwall2\// },
  { id: 'shadowsocksr', label: 'ShadowSocksR Plus+', initd: '/etc/init.d/shadowsocksr', process: /\/(?:tmp|var)\/etc\/(?:ssrplus|shadowsocksr)\// },
  { id: 'homeproxy', label: 'HomeProxy', initd: '/etc/init.d/homeproxy', process: /\/(?:tmp|var)\/run\/homeproxy\// },
])

// 拒绝启动时给用户看的话:部署失败的提示、open-box start / LuCI 的输出都用它;init 脚本里是同样一句
export const conflictMessage = (conflicts) => {
  const names = conflicts.map((c) => c.label).join('、')
  return `检测到 ${names} 正在运行。同一台路由器上不能同时运行两个代理工具,会互相冲突,Open-Box 不启动内核。请先停用 ${names}(关掉它的主开关或卸载)再启动。`
}

// 两个同时在跑、Open-Box 内核被自动停掉(system/conflict-guard.mjs)时记进部署状态的话
export const autoStopMessage = (conflicts) => {
  const names = conflicts.map((c) => c.label).join('、')
  return `检测到 ${names} 和 Open-Box 同时在运行,两个代理工具会互相冲突,已自动停止 Open-Box 内核。要用 Open-Box,请先停用 ${names}(关掉它的主开关或卸载)再启动。`
}

// 全部进程的命令行,每个参数一行。直接读 /proc:`ps w` 在 BusyBox 上列全部进程,可有的固件装的是 procps 版的 ps
// (开发路由器就是),BSD 写法的 `ps w` 只列挂在终端上的进程,插件的后台进程一个都看不到
export const PROCESS_ARGS_SCRIPT = 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\000" "\\n"'

const readProcessArgs = async (ctx) => {
  try {
    const r = await ctx.exec('sh', ['-c', PROCESS_ARGS_SCRIPT], { timeoutMs: 5000 })
    return r && r.code === 0 ? String(r.stdout || '') : ''
  } catch {
    return ''
  }
}

// 只按进程认(不问各插件的 init 脚本):冲突守护每 20 秒用它。一个都没装(绝大多数机器)只看几个文件在不在,一条命令都不跑;
// 装着的才读一次进程表
export const detectRunningByProcess = async (ctx) => {
  const installed = []
  for (const svc of CONFLICT_SERVICES) {
    if (await ctx.exists(svc.initd)) installed.push(svc)
  }
  if (!installed.length) return []
  const lines = (await readProcessArgs(ctx)).split('\n')
  return installed.filter((svc) => lines.some((line) => svc.process.test(line))).map((svc) => ({ id: svc.id, label: svc.label, running: true }))
}

export const detectConflicts = async (ctx) => {
  const conflicts = []
  // 进程表只在有插件装着、status 又说没在跑时才读一次
  let processes = null
  const processList = async () => {
    if (processes === null) processes = await readProcessArgs(ctx)
    return processes
  }
  for (const svc of CONFLICT_SERVICES) {
    if (!(await ctx.exists(svc.initd))) continue
    const { running } = await serviceStatus(ctx, svc.initd)
    if (running || (await processList()).split('\n').some((line) => svc.process.test(line))) {
      conflicts.push({ id: svc.id, label: svc.label, running: true })
    }
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
