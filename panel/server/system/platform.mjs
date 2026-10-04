import { existsSync } from 'node:fs'

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
