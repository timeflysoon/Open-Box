import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createMockContext } from './context.mjs'
import {
  TIMEZONES, TIMEZONE_COUNTRIES, applySystemTimezone, canonicalTimezone, childEnv, describeTimezone, isKnownTimezone, posixOf, readSystemTimezone,
  syncProcessTimezoneOnStartup,
} from './timezone.mjs'

// 这些用例会改 process.env.TZ,跑完还原
const savedTz = process.env.TZ
after(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

test('随包时区表:常用时区都有 POSIX 串;别名换成表里的名字', () => {
  assert.ok(TIMEZONES.length > 400)
  assert.equal(posixOf('Asia/Shanghai'), 'CST-8')
  assert.equal(posixOf('Europe/London'), 'GMT0BST,M3.5.0/1,M10.5.0')
  assert.equal(posixOf('UTC'), 'UTC0')
  assert.equal(canonicalTimezone('Etc/UTC'), 'UTC')
  assert.equal(isKnownTimezone('Mars/Olympus'), false)
})

test('随包国家表:除了 UTC 每个时区都有国家;zone.tab 的新名字(Asia/Kolkata)对到名单里的旧名字(Asia/Calcutta)', () => {
  assert.deepEqual(TIMEZONES.filter((zone) => !TIMEZONE_COUNTRIES[zone]), ['UTC'])
  assert.equal(Object.keys(TIMEZONE_COUNTRIES).every((zone) => isKnownTimezone(zone)), true)
  assert.equal(TIMEZONE_COUNTRIES['Asia/Shanghai'], 'CN')
  assert.equal(TIMEZONE_COUNTRIES['America/New_York'], 'US')
  assert.equal(TIMEZONE_COUNTRIES['Europe/Paris'], 'FR')
  assert.equal(TIMEZONE_COUNTRIES['Asia/Calcutta'], 'IN')
  assert.equal(TIMEZONE_COUNTRIES['America/Buenos_Aires'], 'AR')
})

test('readSystemTimezone(OpenWrt):LuCI 的空格写法换回下划线,带上系统实际的 POSIX 串', async () => {
  const ctx = createMockContext({
    execResults: {
      'uci -q get system.@system[0].zonename': { stdout: 'America/New York\n' },
      'uci -q get system.@system[0].timezone': { stdout: 'EST5EDT,M3.2.0,M11.1.0\n' },
    },
  })
  assert.deepEqual(await readSystemTimezone(ctx, 'openwrt'), { zone: 'America/New_York', posix: 'EST5EDT,M3.2.0,M11.1.0' })
  const bare = createMockContext({ defaultExec: { code: 1, stdout: '' } })
  assert.deepEqual(await readSystemTimezone(bare, 'openwrt'), { zone: 'UTC', posix: '' })
})

test('readSystemTimezone(Debian):timedatectl 报的 Etc/UTC 换成 UTC;没有 timedated 时看 /etc/localtime 指向哪', async () => {
  const ctx = createMockContext({ execResults: { 'timedatectl show -p Timezone --value': { stdout: 'Etc/UTC\n' } } })
  assert.equal((await readSystemTimezone(ctx, 'systemd')).zone, 'UTC')
  const noTimedated = createMockContext({
    execResults: {
      'timedatectl show -p Timezone --value': { code: 1 },
      'readlink -f /etc/localtime': { stdout: '/usr/share/zoneinfo/Asia/Hong_Kong\n' },
    },
  })
  assert.equal((await readSystemTimezone(noTimedated, 'systemd')).zone, 'Asia/Hong_Kong')
})

test('applySystemTimezone(OpenWrt):照 LuCI 写 zonename(空格)和 timezone(POSIX)、提交、reload;面板自己的 TZ 跟着换', async () => {
  const ctx = createMockContext()
  await applySystemTimezone(ctx, 'openwrt', 'America/New_York')
  assert.deepEqual(ctx.calls.map((c) => [c.cmd, ...c.args].join(' ')), [
    'uci set system.@system[0].zonename=America/New York',
    'uci set system.@system[0].timezone=EST5EDT,M3.2.0,M11.1.0',
    'uci commit system',
    '/etc/init.d/system reload',
  ])
  assert.equal(process.env.TZ, 'America/New_York')
  // 改完立刻按新时区算
  assert.equal(describeTimezone('America/New_York', new Date('2026-07-01T12:00:00Z')).offset, '-04:00')
})

test('applySystemTimezone:不认识的时区不动系统;某一步失败报出来', async () => {
  const ctx = createMockContext()
  await assert.rejects(applySystemTimezone(ctx, 'openwrt', 'Mars/Olympus'), /不认识的时区/)
  assert.equal(ctx.calls.length, 0)
  const failing = createMockContext({ execResults: { 'uci commit system': { code: 1, stderr: 'read-only file system' } } })
  await assert.rejects(applySystemTimezone(failing, 'openwrt', 'Asia/Shanghai'), /uci commit system 失败:read-only file system/)
})

test('applySystemTimezone(Debian):timedatectl set-timezone;用不了就直接换 /etc/localtime 和 /etc/timezone', async () => {
  const ctx = createMockContext()
  await applySystemTimezone(ctx, 'systemd', 'Asia/Hong_Kong')
  assert.deepEqual(ctx.calls.map((c) => [c.cmd, ...c.args].join(' ')), ['timedatectl set-timezone Asia/Hong_Kong'])
  const noTimedated = createMockContext({ execResults: { 'timedatectl set-timezone Asia/Hong_Kong': { code: 1 } } })
  await applySystemTimezone(noTimedated, 'systemd', 'Asia/Hong_Kong')
  assert.ok(noTimedated.calls.some((c) => [c.cmd, ...c.args].join(' ') === 'ln -sf /usr/share/zoneinfo/Asia/Hong_Kong /etc/localtime'))
  assert.equal(noTimedated.files['/etc/timezone'], 'Asia/Hong_Kong\n')
})

test('启动时:OpenWrt 上时区名和实际的 POSIX 串对得上才按时区名设;只改过 timezone、名字还是 UTC 的不动;Debian 不设', async () => {
  const consistent = createMockContext({
    execResults: {
      'uci -q get system.@system[0].zonename': { stdout: 'Asia/Shanghai' },
      'uci -q get system.@system[0].timezone': { stdout: 'CST-8' },
    },
  })
  assert.equal(await syncProcessTimezoneOnStartup(consistent, 'openwrt'), 'Asia/Shanghai')
  assert.equal(process.env.TZ, 'Asia/Shanghai')
  const manualPosix = createMockContext({
    execResults: {
      'uci -q get system.@system[0].zonename': { stdout: 'UTC' },
      'uci -q get system.@system[0].timezone': { stdout: 'CST-8' },
    },
  })
  assert.equal(await syncProcessTimezoneOnStartup(manualPosix, 'openwrt'), null)
  assert.equal(await syncProcessTimezoneOnStartup(createMockContext(), 'systemd'), null)
})

test('childEnv:子进程不带面板给自己设的 TZ(照旧走系统的时区设置),显式传的 TZ 照给', () => {
  process.env.TZ = 'Asia/Shanghai'
  const env = childEnv({ GOGC: '25' })
  assert.equal(env.GOGC, '25')
  assert.equal('TZ' in env, savedTz !== undefined)
  assert.equal(childEnv({ TZ: 'UTC' }).TZ, 'UTC')
})

test('describeTimezone:偏移写成 +08:00,本地时间按那个时区', () => {
  const at = new Date('2026-10-03T04:00:00Z')
  assert.deepEqual(describeTimezone('Asia/Shanghai', at), { zone: 'Asia/Shanghai', offset: '+08:00', local: '2026-10-03 12:00:00' })
  assert.equal(describeTimezone('UTC', at).offset, '+00:00')
})
