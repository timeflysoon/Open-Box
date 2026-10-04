// 路由器的系统时区(后端设置 · 时区,用户 2026-10-03)。定时任务按路由器本地时间的钟点跑(system/scheduler.mjs 的
// now.getHours()):英国那台系统时区是上海、WFOS 那台 VPS 是 UTC,「每天 04:00」都不是用户以为的那个点。
//
// - OpenWrt:写 uci 的 zonename(时区名)和 timezone(POSIX 串,musl 靠它算本地时间),再 /etc/init.d/system reload——
//   和 LuCI「系统 → 时区」一样。LuCI 存 zonename 用空格代替下划线(America/New York),这里读写都照它。POSIX 串查随包的
//   resources/tz-posix.json(scripts/gen-tz-posix.mjs 从 tzdata 生成;很多固件没装 zoneinfo,路由器上取不到)。
// - Debian / Ubuntu:timedatectl set-timezone;没有 timedated 时退回直接换 /etc/localtime + /etc/timezone。
//
// 面板自己:常驻进程不会察觉系统时区变了,所以改完给自己设 process.env.TZ = 时区名(Node 改 TZ 立即生效,按 ICU 自带的
// 时区数据算,固件没装 zoneinfo、有夏令时的时区也对)。面板起的子进程不带这个 TZ(childEnv):musl 遇到时区名却找不到
// zoneinfo 文件会按 UTC 算,子进程照旧走系统自己的设置(/etc/TZ、/etc/localtime)才对。
import tzPosix from '../resources/tz-posix.json' with { type: 'json' }
import tzCountries from '../resources/tz-countries.json' with { type: 'json' }

export const TIMEZONES = Object.freeze(Object.keys(tzPosix))
// 时区 → 所在国家 / 地区的两字母代码(同一个生成脚本出自 tzdata 的 zone.tab;UTC 没有)。前端按本地化的国家名搜索用
export const TIMEZONE_COUNTRIES = Object.freeze({ ...tzCountries })
export const isKnownTimezone = (zone) => typeof zone === 'string' && Object.hasOwn(tzPosix, zone)
export const posixOf = (zone) => (isKnownTimezone(zone) ? tzPosix[zone] : '')

// 别名换成表里的名字:Etc/UTC、Universal → UTC;Asia/Calcutta 这类按 ICU 认的规范名
export const canonicalTimezone = (zone) => {
  const raw = String(zone || '').trim()
  if (!raw) return ''
  if (isKnownTimezone(raw)) return raw
  try {
    const resolved = new Intl.DateTimeFormat('en', { timeZone: raw }).resolvedOptions().timeZone
    return isKnownTimezone(resolved) ? resolved : raw
  } catch {
    return raw
  }
}

const toLuciName = (zone) => zone.replace(/_/g, ' ')
const fromLuciName = (name) => String(name || '').trim().replace(/ /g, '_')

// { zone, posix }:zone 是时区名(规范化过),posix 是系统实际在用的 POSIX 串(OpenWrt 的 uci timezone;Debian 没有,空)
export const readSystemTimezone = async (ctx, platform) => {
  if (platform !== 'systemd') {
    const [name, tz] = await Promise.all([
      ctx.exec('uci', ['-q', 'get', 'system.@system[0].zonename']),
      ctx.exec('uci', ['-q', 'get', 'system.@system[0].timezone']),
    ])
    return { zone: canonicalTimezone(fromLuciName(name.stdout)) || 'UTC', posix: String(tz.stdout || '').trim() }
  }
  const r = await ctx.exec('timedatectl', ['show', '-p', 'Timezone', '--value'])
  let zone = r.code === 0 ? String(r.stdout || '').trim() : ''
  if (!zone) {
    const link = await ctx.exec('readlink', ['-f', '/etc/localtime'])
    zone = (/zoneinfo\/(.+)$/.exec(String(link.stdout || '').trim()) || [])[1] || ''
  }
  return { zone: canonicalTimezone(zone) || 'UTC', posix: '' }
}

const run = async (ctx, cmd, args) => {
  const r = await ctx.exec(cmd, args)
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败:${String(r.stderr || r.stdout || '').trim() || `退出码 ${r.code}`}`)
  return r
}

export const applySystemTimezone = async (ctx, platform, zone) => {
  if (!isKnownTimezone(zone)) throw new Error(`不认识的时区:${zone}`)
  if (platform !== 'systemd') {
    await run(ctx, 'uci', ['set', `system.@system[0].zonename=${toLuciName(zone)}`])
    await run(ctx, 'uci', ['set', `system.@system[0].timezone=${posixOf(zone)}`])
    await run(ctx, 'uci', ['commit', 'system'])
    // 写 /tmp/TZ、换 /tmp/localtime(装了对应 zoneinfo 才有),新起的进程就按新时区
    await run(ctx, '/etc/init.d/system', ['reload'])
  } else {
    const r = await ctx.exec('timedatectl', ['set-timezone', zone])
    if (r.code !== 0) {
      await run(ctx, 'ln', ['-sf', `/usr/share/zoneinfo/${zone}`, '/etc/localtime'])
      await ctx.writeFile('/etc/timezone', `${zone}\n`)
    }
  }
  applyProcessTimezone(zone)
}

// 面板进程自己的时区。第一次设之前记下启动时的 TZ(通常没有),子进程还原成它
let panelTz = null
let originalTz
export const applyProcessTimezone = (zone) => {
  if (!isKnownTimezone(zone)) return false
  if (panelTz === null) originalTz = process.env.TZ
  panelTz = zone
  process.env.TZ = zone
  return true
}

// 启动时:OpenWrt 上时区名和系统实际的 POSIX 串对得上才按时区名设(只手动改过 timezone、zonename 还是默认 UTC 的,
// 按名字设反而把钟点带偏,不动它);Debian 的 glibc 本来就按 /etc/localtime 算,不用设
export const syncProcessTimezoneOnStartup = async (ctx, platform) => {
  if (platform === 'systemd') return null
  const { zone, posix } = await readSystemTimezone(ctx, platform)
  if (!isKnownTimezone(zone) || posixOf(zone) !== posix) return null
  return applyProcessTimezone(zone) ? zone : null
}

// 子进程的环境变量:去掉面板给自己设的 TZ
export const childEnv = (extra = {}) => {
  const env = { ...process.env, ...extra }
  if (panelTz !== null && !('TZ' in extra)) {
    if (originalTz === undefined) delete env.TZ
    else env.TZ = originalTz
  }
  return env
}

// 给页面看的:时区名、此刻的 UTC 偏移(+08:00)、路由器本地时间
export const describeTimezone = (zone, now = new Date()) => {
  let offset = ''
  let local = ''
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(now)
    offset = (parts.find((p) => p.type === 'timeZoneName')?.value || '').replace(/^GMT/, '') || '+00:00'
    local = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)
  } catch {
    // 不认识的名字:偏移和时间留空
  }
  return { zone, offset, local }
}
