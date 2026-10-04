// 给 dnsmasq 发信号(HUP 清缓存、USR2 重开日志),只发给真正的 dnsmasq 守护进程。
// 不能用 killall / pidof:它们按进程名认,OpenWrt 上叫 dnsmasq 的还有两个——ujail 外壳(-n dnsmasq),以及正在跑的
// /etc/init.d/dnsmasq 脚本(shebang 脚本的进程名就是脚本文件名)。脚本收到 HUP / USR2 直接退出:正好碰上它在重启 dnsmasq
// (部署时 DNS 接管重启 dnsmasq,同时面板清缓存 / 接查询日志),停掉旧的、还没起新的就被打断,dnsmasq 就一直停着,
// 全 LAN 没有解析(2026-09-27 开发路由器实测)。这里按 /proc/<pid>/exe 认二进制;刚起来不到 minAgeMs 的也先不发——
// 信号处理还没装好时收到 HUP / USR2 同样会退出,而刚起来的 dnsmasq 缓存本来就是空的、日志也刚打开
import fs from 'node:fs'
import path from 'node:path'

// /proc/<pid>/stat 的起始时刻单位是时钟滴答,Linux 用户态固定 100 / 秒
const CLK_TCK = 100

export const dnsmasqDaemons = ({ procRoot = '/proc' } = {}) => {
  let uptime = null
  try { uptime = Number(fs.readFileSync(`${procRoot}/uptime`, 'utf8').split(/\s+/)[0]) } catch { uptime = null }
  let pids = []
  try { pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name)) } catch { return [] }
  const out = []
  for (const pid of pids) {
    try {
      if (fs.readFileSync(`${procRoot}/${pid}/comm`, 'utf8').trim() !== 'dnsmasq') continue
      if (path.basename(fs.readlinkSync(`${procRoot}/${pid}/exe`)) !== 'dnsmasq') continue
      // 第 22 项是起来的时刻;进程名在括号里、可能带空格,从最后一个 ")" 后面数(那里是第 3 项)
      const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
      const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]) / CLK_TCK
      out.push({ pid: Number(pid), ageMs: uptime !== null && Number.isFinite(start) ? Math.max(0, uptime - start) * 1000 : Infinity })
    } catch { /* 进程刚退出、或者看不了 */ }
  }
  return out
}

// 返回 { found, sent, young }:找到几个 dnsmasq、发出去几个、几个太新没发
export const signalDnsmasq = (signal, { procRoot = '/proc', minAgeMs = 0, kill = (pid, sig) => process.kill(pid, sig) } = {}) => {
  const daemons = dnsmasqDaemons({ procRoot })
  let sent = 0
  let young = 0
  for (const d of daemons) {
    if (d.ageMs < minAgeMs) { young++; continue }
    try { kill(d.pid, signal); sent++ } catch { /* 刚退出 */ }
  }
  return { found: daemons.length, sent, young }
}
