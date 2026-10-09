import { existsSync, readFileSync } from 'node:fs'

// 面板跑在哪种系统上。Open-Box 原生是 OpenWrt 插件(procd / uci / ubus / dnsmasq / LuCI),2026-09 起也能装在
// Debian / Ubuntu(systemd)上:服务由 systemd 管、日志在 journald、没有 uci 防火墙和 dnsmasq 分流。
// 各系统层模块按这里的结果分叉;拿不准的(既没有 /etc/openwrt_release 也没有 systemd)按 OpenWrt 处理,
// 和以前的行为一样。OPENBOX_PLATFORM 环境变量可以强制指定(Debian 的 openbox-panel-run 会设;测试也用它)
export const PLATFORMS = ['openwrt', 'systemd']

export const detectPlatform = ({ env = process.env, exists = existsSync } = {}) => {
  const forced = String(env.OPENBOX_PLATFORM || '').trim()
  if (PLATFORMS.includes(forced)) return forced
  if (exists('/etc/openwrt_release')) return 'openwrt'
  if (exists('/run/systemd/system')) return 'systemd'
  return 'openwrt'
}

export const isOpenWrt = (platform) => platform !== 'systemd'

// /etc/openwrt_release、/etc/os-release 都是 shell 变量格式:KEY=值 / KEY='值' / KEY="值"
const parseReleaseFile = (text) => {
  const out = {}
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(['"]?)(.*)\2\s*$/.exec(line.trim())
    if (m) out[m[1]] = m[3]
  }
  return out
}

// 本机系统版本(后端设置版本卡「路由器端支持的平台」里本机那格的标签「本机版本:…」,用户 2026-10-09):
// OpenWrt 读 /etc/openwrt_release——官方固件只写版本号(24.10.0),iStoreOS、ImmortalWrt 这类衍生固件带上名字(iStoreOS 24.10.1);
// Debian / Ubuntu 读 /etc/os-release,写「Ubuntu 24.04」「Debian 12」(那格本来就写着 Ubuntu / Debian 两种)。读不到回空串,界面只标「本机」
export const readOsRelease = ({ platform = 'openwrt', readFile = (p) => readFileSync(p, 'utf8') } = {}) => {
  const read = (p) => {
    try {
      return parseReleaseFile(readFile(p))
    } catch {
      return {}
    }
  }
  if (platform === 'systemd') {
    const os = read('/etc/os-release')
    const id = String(os.ID || '').toLowerCase()
    const name = id === 'ubuntu' ? 'Ubuntu' : id === 'debian' ? 'Debian' : os.NAME || os.ID || ''
    return [name, os.VERSION_ID || ''].filter(Boolean).join(' ')
  }
  const wrt = read('/etc/openwrt_release')
  const release = wrt.DISTRIB_RELEASE || ''
  const id = wrt.DISTRIB_ID || ''
  if (!release) return ''
  return id && id.toLowerCase() !== 'openwrt' ? `${id} ${release}` : release
}
