import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { deployConfig, rollbackToDirect, configMetaPath, TUN_DEVICE, AUTO_REDIRECT_FATAL, TRANSIENT_REDIRECT_FATAL, TUN_START_FATAL } from './deploy.mjs'
import { routingFingerprint } from '../engine/routing-model.mjs'
import { dnsTakeoverBackupPath } from './dns-takeover.mjs'

const paths = createPaths('/opt/open-box')
const config = { log: { level: 'warn' }, outbounds: [{ type: 'direct', tag: 'direct' }] }
const profile = { ipv6: true, dns: { mode: 'hijack' } }
const cmds = (ctx) => ctx.calls.map((c) => [c.cmd, ...c.args].join(' '))

const okCtx = (over = {}) => createMockContext({
  files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
  execResults: {
    '/etc/init.d/openbox status': { code: 0, stdout: 'running' },
    ...over,
  },
})

test('冲突时不改系统,明确说是哪个代理工具、为什么不启动、要先停用它', async () => {
  const ctx = createMockContext({
    files: { '/etc/init.d/openclash': '#!' },
    execResults: { '/etc/init.d/openclash status': { code: 0, stdout: 'running' } },
  })
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'conflict')
  assert.match(r.message, /^检测到 OpenClash 正在运行。同一台路由器上不能同时运行两个代理工具,会互相冲突,Open-Box 不启动内核。请先停用 OpenClash/)
  assert.equal(ctx.writes.length, 0)                      // 未写任何配置
  assert.ok(!cmds(ctx).some((c) => c.includes('openbox restart')))
})

test('校验失败:不写正式配置、不重启、给 badTags', async () => {
  const ctx = createMockContext({ defaultExec: { code: 1, stderr: 'FATAL: unknown method: x' } })
  const r = await deployConfig(ctx, paths, { config: { outbounds: [{ type: 'shadowsocks', tag: 'bad', server: 'a', server_port: 1, method: 'x' }] }, profile })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'validate')
  assert.deepEqual(r.badTags, ['bad'])
  assert.ok(!ctx.writes.some((w) => w.path === paths.configPath))
  assert.ok(!cmds(ctx).some((c) => c.includes('/etc/init.d/openbox restart')))
})

test('成功路径:写配置 + 防火墙 + 重启 + 验证', async () => {
  const ctx = okCtx()
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, true)
  assert.equal(r.stage, 'running')
  assert.ok(ctx.writes.some((w) => w.path === paths.configPath))
  const c = cmds(ctx)
  assert.ok(c.includes('uci set firewall.openbox_panel=rule'))
  assert.ok(c.includes('/etc/init.d/openbox restart'))
})

test('代理侧 DNS 上游按目标分流判出的线路记进元数据(规则页 / 诊断包看),判不出来的带原因', async () => {
  const ctx = okCtx()
  const r = await deployConfig(ctx, paths, { config, profile, dnsUpstreamRoutes: [
    { server: '1.1.1.1', port: 53, protocol: 'tcp', outbound: '国外', reject: false, owner: { kind: 'policy', name: '国外' }, chain: ['国外', 'HK-01'], ruleIndex: 49 },
    { server: '8.8.8.8', port: 53, protocol: 'tcp', error: 'rule set unreadable' },
  ] })
  assert.equal(r.ok, true)
  const meta = JSON.parse(ctx.files[configMetaPath(paths)])
  assert.deepEqual(meta.dnsUpstreamRoutes, [
    { server: '1.1.1.1', port: 53, protocol: 'tcp', outbound: '国外', reject: false, ruleIndex: 49, owner: { kind: 'policy', name: '国外' } },
    { server: '8.8.8.8', port: 53, protocol: 'tcp', outbound: '', reject: false, ruleIndex: null, owner: null, error: 'rule set unreadable' },
  ], '此刻的链路是运行时状态,不记')
})

test('带编号的坏节点直接定位，保留原配置且无需逐节点拆分校验', async () => {
  const ctx = okCtx({ '/opt/open-box/bin/sing-box check -c /opt/open-box/etc/config.candidate.json': { code: 1, stderr: 'FATAL initialize outbound [1]: invalid public_key' } })
  const r = await deployConfig(ctx, paths, { profile, config: { outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'vless', tag: 'HK' }] }, nodes: [{ tag: 'HK', subscriptionId: 'sub' }], subscriptions: [{ id: 'sub', name: '机场' }] })
  assert.equal(r.ok, false)
  assert.match(r.message, /节点「HK」，订阅「机场」/)
  assert.deepEqual(r.badTags, ['HK'])
  assert.equal(ctx.writes.filter((w) => w.path.endsWith('config.probe.json')).length, 0)
  assert.ok(!cmds(ctx).includes('/etc/init.d/openbox restart'))
})

test('DNS off 仍放行 LAN 到 TUN，DNS 不被重新接管，回滚撤掉转发规则', async () => {
  const ctx = okCtx()
  const r = await deployConfig(ctx, paths, { profile: { ...profile, dns: { mode: 'off' } }, config: { ...config, inbounds: [{ type: 'tun', interface_name: 'tun0' }] } })
  assert.equal(r.ok, true)
  assert.ok(cmds(ctx).includes('uci set firewall.openbox_tun_forward.device=tun0'))
  assert.ok(cmds(ctx).includes('uci set firewall.openbox_tun_input.device=tun0'))
  assert.ok(!cmds(ctx).some((c) => /uci (set|add_list) dhcp/.test(c)))
  await rollbackToDirect(ctx, paths)
  assert.ok(cmds(ctx).includes('uci -q delete firewall.openbox_tun_forward'))
  assert.ok(cmds(ctx).includes('uci -q delete firewall.openbox_tun_input'))
})

test('部署按启用的 DNS 重写源生成 dnsmasq 例外:固定 IPv4 / IPv6、域名目标都支持,停用规则不生成', async () => {
  const ctx = okCtx()
  const r = await deployConfig(ctx, paths, {
    config,
    profile: { ...profile, dns: { mode: 'dnsmasq', rewrite: { rules: [
      { source: '*.custom.example', addresses: ['192.168.77.1'] },
      { source: 'v6.custom.example', addresses: ['fd12::1'] },
      { source: 'alias.example', domain: 'target.custom.example' },
      { source: 'disabled.example', enabled: false, addresses: ['10.0.0.1'] },
    ] } } },
  })
  assert.equal(r.ok, true)
  const text = ctx.files[`${paths.dataDir}/dnsmasq-forward.conf`]
  assert.match(text, /rebind-domain-ok=\/custom\.example\//)
  assert.match(text, /rebind-domain-ok=\/v6\.custom\.example\//)
  assert.match(text, /rebind-domain-ok=\/alias\.example\//)
  assert.ok(!text.includes('disabled.example'))
  assert.ok(!cmds(ctx).some((c) => /uci .*rebind/.test(c)))
})

test('元数据带上"谁走直连、谁走代理"的判断:代理页改完出口靠它判 dns.rules 有没有过期', async () => {
  const ctx = okCtx()
  await deployConfig(ctx, paths, {
    config: { ...config, outbounds: [{ type: 'direct', tag: '直连' }, { type: 'selector', tag: '其他', outbounds: ['直连', '香港-自动'] }] },
    profile: { ...profile, routing: { fallbackDefault: 'proxy', policies: [{ name: '国内', default: 'direct', rulesets: ['geosite-cn'] }] } },
    selections: { 其他: '香港-自动' },
  })
  const meta = JSON.parse(ctx.writes.find((w) => w.path === configMetaPath(paths)).content)
  assert.deepEqual(meta.dnsPolicyClasses, { 国内: 'direct', 其他: 'proxy' })
  assert.deepEqual(meta.dnsPolicyMembers, ['直连', '香港-自动'])
  // 这次部署用的是哪份分流设置:规则页拿它和当前档案比,改了没重启就明说(见 api/penetration.mjs)
  assert.equal(
    meta.routingHash,
    routingFingerprint({ fallbackDefault: 'proxy', policies: [{ name: '国内', default: 'direct', rulesets: ['geosite-cn'] }] }),
  )
  // init 脚本靠 grep 这一行判 dnsmasq 模式,加字段不能把它挤走
  assert.match(JSON.stringify(meta, null, 2), /"dnsMode": "hijack"/)
})

test('IPv6 关闭时下发 v6 拦截规则', async () => {
  const ctx = okCtx()
  await deployConfig(ctx, paths, { config, profile: { ...profile, ipv6: false } })
  assert.ok(cmds(ctx).includes('uci set firewall.openbox_v6block=rule'))
})

test('内核二进制缺失 → 重启前预检拦截,精确归因而不依赖 procd 吞掉的退出码', async () => {
  // procd 的 rc_procd 包装会吞掉 start_service 的 return 1,二进制/配置缺失时
  // start 仍可能退出 0、以零实例注册。deployConfig 必须自己在重启内核前检查文件
  // 是否存在,把这种情况从笼统的"内核启动后未在运行"精确归因为"文件缺失"。
  const ctx = createMockContext({
    execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } },
    // 不放 paths.singbox 文件,模拟二进制未安装/未解压完成
  })
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'start')
  assert.match(r.message, /sing-box/)
  const c = cmds(ctx)
  assert.ok(!c.includes('/etc/init.d/openbox restart'), '二进制缺失时不应尝试重启内核')
  assert.ok(c.includes('/etc/init.d/openbox stop'), '预检失败也要回滚到直连')
})

test('重启失败 → 回滚恢复直连', async () => {
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: {
      '/etc/init.d/openbox restart': { code: 1, stderr: 'start failed' },
    },
  })
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'start')
  const c = cmds(ctx)
  assert.ok(c.includes('/etc/init.d/openbox stop'))          // 回滚停服务
  assert.ok(c.includes('uci -q delete firewall.openbox_v6block'))  // 撤代理规则(而非面板放行)
})

test('启动后未 running → 回滚', async () => {
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: { '/etc/init.d/openbox status': { code: 1, stdout: 'inactive' } },
  })
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'verify')
  assert.ok(cmds(ctx).includes('/etc/init.d/openbox stop'))
})

test('启动脚本直接返回节点错误时也显示节点和订阅名称', async () => {
  const ctx = okCtx({ '/etc/init.d/openbox restart': { code: 1, stderr: 'FATAL initialize outbound [1]: invalid public_key' } })
  const r = await deployConfig(ctx, paths, { profile, config: { outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'vless', tag: 'HK' }] }, nodes: [{ tag: 'HK', subscriptionId: 'sub' }], subscriptions: [{ id: 'sub', name: '机场' }] })
  assert.equal(r.stage, 'start')
  assert.match(r.message, /节点「HK」，订阅「机场」/)
  assert.deepEqual(r.badTags, ['HK'])
  assert.ok(cmds(ctx).includes('/etc/init.d/openbox stop'))
})

test('模式切换:切回 hijack 但上次 dnsmasq 接管的备份仍在 → 部署时先还原 dnsmasq 上游', async () => {
  const ctx = createMockContext({
    files: {
      [TUN_DEVICE]: '',
      [dnsTakeoverBackupPath(paths)]: "dhcp.cfg01411c.server='223.5.5.5'\ndhcp.cfg01411c.noresolv='0'\n",
      [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '',
    },
    execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } },
  })
  const r = await deployConfig(ctx, paths, { config, profile: { ...profile, dns: { mode: 'hijack' } } })
  assert.equal(r.ok, true)
  const c = cmds(ctx)
  // 不还原的话 dnsmasq 会继续指向 127.0.0.1#7853,而新配置已无 dns-in 入站 → LAN DNS 全断
  assert.ok(c.includes('uci -q delete dhcp.@dnsmasq[0].server'))
  assert.ok(c.includes('uci add_list dhcp.@dnsmasq[0].server=223.5.5.5'))
  assert.ok(c.includes('uci set dhcp.@dnsmasq[0].noresolv=0'))
  assert.equal(await ctx.exists(dnsTakeoverBackupPath(paths)), false)     // 备份已消费
})

test('落盘之后阶段抛出异常 → 回滚到直连并返回 stage:error', async () => {
  const ctx = okCtx()
  const realWriteFile = ctx.writeFile.bind(ctx)
  ctx.writeFile = async (path, content) => {
    if (path === paths.configPath) throw new Error('ENOSPC: no space left on device')
    return realWriteFile(path, content)
  }
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'error')
  assert.match(r.message, /ENOSPC/)
  assert.ok(cmds(ctx).includes('/etc/init.d/openbox stop'))    // 回滚:停服务
})

test('rollbackToDirect:每一步各自尽力、不抛,但失败要如实汇总,不再一律 ok:true', async () => {
  const ctx = createMockContext({ defaultExec: { code: 1, stderr: 'boom' } })   // 全失败也不抛
  const r = await rollbackToDirect(ctx, paths)
  assert.equal(r.ok, false)
  assert.deepEqual(r.actions, [])
  assert.deepEqual(r.failures.map((f) => f.step), ['stop-core', 'restore-dns', 'remove-firewall'])
  assert.ok(r.failures.every((f) => /boom|失败/.test(f.message)))
  // 三步都成功才是 ok
  const fine = await rollbackToDirect(createMockContext(), paths)
  assert.equal(fine.ok, true)
  assert.deepEqual(fine.actions, ['stop-core', 'restore-dns', 'remove-firewall'])
  assert.deepEqual(fine.failures, [])
})

test('重启失败且回滚也没成 → 提示写明恢复直连未完成、哪一步、为什么;不再笼统说"已恢复直连"', async () => {
  // firewall reload 部署那次(第 6 步)成功,回滚撤规则那次才失败
  let reloads = 0
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: {
      '/etc/init.d/openbox restart': { code: 1, stderr: 'start failed' },
      '/etc/init.d/firewall reload': () => (++reloads === 1 ? { code: 0 } : { code: 1, stderr: 'fw4 broken' }),
    },
  })
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'start')
  assert.match(r.message, /start failed,恢复直连未完成（remove-firewall: firewall reload 失败.*fw4 broken）/)
  assert.equal(r.rollback.ok, false)
  // 回滚全成功时照旧说"已恢复直连"
  const fine = await deployConfig(createMockContext({ files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' }, execResults: { '/etc/init.d/openbox restart': { code: 1, stderr: 'start failed' } } }), paths, { config, profile })
  assert.match(fine.message, /start failed,已恢复直连$/)
  assert.equal(fine.rollback.ok, true)
})

test('部署途中 firewall reload 失败 → 不能报成功:stage:error、回滚到直连', async () => {
  const ctx = okCtx({ '/etc/init.d/firewall reload': { code: 1, stderr: 'fw4: syntax error' } })
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'error')
  assert.match(r.message, /firewall reload 失败/)
  assert.ok(cmds(ctx).includes('/etc/init.d/openbox stop'))
})

test('rollbackToDirect 不移除面板 LAN 放行规则（否则自断恢复通道）', async () => {
  const ctx = createMockContext({})
  const paths = createPaths('/opt/open-box')
  await rollbackToDirect(ctx, paths)
  const joined = ctx.calls.map((c) => `${c.cmd} ${(c.args || []).join(' ')}`).join('\n')
  assert.ok(joined.includes('delete firewall.openbox_v6block'), '应移除 v6 拦截')
  assert.ok(
    !joined.includes('delete firewall.openbox_panel'),
    '不得移除面板放行规则',
  )
})

// -------- 规则集补齐(部署第 2 步)--------
// 真机 192.168.3.35 上撞到的原始故障:rulesetDir 整个不存在,内核在校验阶段 FATAL
// "open /opt/open-box/data/rulesets/geosite-cn.srs: no such file or directory"。
// 此前全项目没有任何地方创建这些文件,默认档案永远部署不成功。

const configWithRulesets = {
  log: { level: 'warn' },
  outbounds: [{ type: 'direct', tag: 'direct' }],
  route: {
    rules: [{ rule_set: ['geosite-cn'], outbound: 'direct' }],
    rule_set: [{
      type: 'local', tag: 'geosite-cn', format: 'binary',
      path: '/opt/open-box/data/rulesets/geosite-cn.srs',
    }],
  },
}

test('新安装直接使用随包 Geo 数据，无需网络或旧来源标记', async () => {
  const ctx = okCtx()
  ctx.files[`${paths.geoDir}/geosite-cn.srs`] = Buffer.from('SRS-BINARY')
  const current = structuredClone(configWithRulesets)
  const r = await deployConfig(ctx, paths, { config: current, profile, fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(r.ok, true)
  assert.equal(r.stage, 'running')
  assert.equal(current.route.rule_set[0].path, `${paths.geoDir}/geosite-cn.srs`)
  assert.ok(!ctx.writes.some(w => w.path.endsWith('.srs')))
})

test('新安装开启 DNS 过滤：保留编译产物，补齐 Geo 后可通过部署启动', async () => {
  const ctx = okCtx()
  ctx.files[`${paths.geoDir}/geosite-cn.srs`] = Buffer.from('GEO-SRS')
  const tag = 'dns-filter-allow-26efdcf0c0739bae'
  const filterPath = `${paths.dataDir}/dns-filter/${tag}.srs`
  ctx.files[filterPath] = Buffer.from('COMPILED-FILTER')
  const filtering = structuredClone(configWithRulesets)
  filtering.route.rule_set.unshift({ type: 'local', tag, format: 'binary', path: filterPath })
  const fetched = []
  const result = await deployConfig(ctx, paths, { config: filtering, profile, fetchImpl: async (url) => {
    fetched.push(String(url))
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('GEO-SRS') }
  } })
  assert.equal(result.ok, true)
  assert.equal(result.stage, 'running')
  assert.ok(cmds(ctx).includes('/etc/init.d/openbox restart'))
  assert.ok(ctx.files[paths.configPath])
  assert.equal(ctx.files[filterPath].toString(), 'COMPILED-FILTER')
  assert.ok(fetched.every((url) => !url.includes('dns-filter')))
})

test('安装包缺少规则集 → stage:rulesets,且不动系统（没落盘、没改 DNS/防火墙、没重启内核）', async () => {
  const ctx = okCtx()
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  const r = await deployConfig(ctx, paths, { config: configWithRulesets, profile, fetchImpl })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'rulesets')
  assert.match(r.message, /geosite-cn/)
  // 这一步排在校验之前,系统状态必须完全没被碰过
  assert.equal(ctx.writes.length, 0)
  assert.ok(!cmds(ctx).some((c) => c.includes('restart')))
  assert.ok(!cmds(ctx).some((c) => c.includes('uci')))
})

test('规则集已存在时不再下载（GitHub 连不上也能照常部署）', async () => {
  const ctx = okCtx()
  ctx.files[`${paths.geoDir}/geosite-cn.srs`] = Buffer.from('already-here')
  // 旧来源标记不参与选择，始终使用包内数据。
  ctx.files['/opt/open-box/data/rulesets/.source'] = 'metacubex\n'
  let called = false
  const fetchImpl = async () => { called = true; throw new Error('不该被调用') }
  const r = await deployConfig(ctx, paths, { config: configWithRulesets, profile, fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(called, false)
})

// 审查第 2 项:deployConfig 的取消检查点
test('isCancelled 在落盘前为真 → 直接退出、什么都不动;在 DNS / 防火墙之后为真 → 回滚到直连;内核起了之后为真 → 不报成功也不回滚', async () => {
  // 1) 落盘前
  const early = okCtx()
  const r1 = await deployConfig(early, paths, { config, profile, isCancelled: () => true })
  assert.equal(r1.stage, 'cancelled')
  assert.ok(!early.writes.some((w) => w.path === paths.configPath))
  assert.ok(!cmds(early).includes('/etc/init.d/openbox restart'))
  // 2) DNS / 防火墙改完、内核还没起:防火墙 reload 之后才取消
  let flipped = false
  const mid = okCtx({ '/etc/init.d/firewall reload': () => { flipped = true; return { code: 0 } } })
  const r2 = await deployConfig(mid, paths, { config, profile, isCancelled: () => flipped })
  assert.equal(r2.stage, 'cancelled')
  assert.match(r2.message, /已恢复直连/)
  assert.ok(!cmds(mid).includes('/etc/init.d/openbox restart'))
  assert.ok(cmds(mid).includes('/etc/init.d/openbox stop'))
  // 3) 内核已起(restart 之后)才取消:不报成功、不回滚,留给随后的停止动作
  let restarted = false
  const late = okCtx({ '/etc/init.d/openbox restart': () => { restarted = true; return { code: 0 } } })
  const r3 = await deployConfig(late, paths, { config, profile, isCancelled: () => restarted })
  assert.equal(r3.stage, 'cancelled')
  assert.equal(r3.ok, false)
  assert.ok(!cmds(late).includes('/etc/init.d/openbox stop'))
})

// 没加载 tun 模块的固件上内核直接 FATAL "open /dev/net/tun: no such file"(GitHub #12)。
// 部署前先试着 modprobe 一次;还是没有就用人话说清要装 kmod-tun,并回滚到直连。
test('tun 设备不存在:先 modprobe,还没有就明说要装 kmod-tun 并回滚直连', async () => {
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n' }, // 没有 /dev/net/tun
    execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } },
  })
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'start')
  assert.match(r.message, /kmod-tun/)
  assert.match(r.message, /\/dev\/net\/tun/)
  const c = cmds(ctx)
  assert.ok(c.includes('modprobe tun'), '应该先试着加载模块')
  assert.ok(!c.some((x) => /openbox restart/.test(x)), '没有 tun 设备就不该去重启内核')
  assert.ok(r.rollback, '要回滚到直连')
})

test('tun 设备一开始没有、modprobe 之后出现了:继续部署', async () => {
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n' },
    execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } },
  })
  // modprobe 成功后设备文件出现:桩里在 exec 到 modprobe 时把它加进 files
  const origExec = ctx.exec.bind(ctx)
  ctx.exec = async (cmd, args) => {
    const r = await origExec(cmd, args)
    if (cmd === 'modprobe') await ctx.writeFile(TUN_DEVICE, '')
    return r
  }
  const r = await deployConfig(ctx, paths, { config, profile })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(cmds(ctx).includes('modprobe tun'))
})

// ---------- auto_redirect 起不来:降级成纯 tun 再试一次(GitHub #12 #15) ----------
const REDIRECT_FATAL = 'FATAL[0002] start service: post-start inbound/tun[tun-in]: auto-redirect: setup nftables: flush nftables: conn.Receive: netlink receive: no such file or directory'
const tunProfile = { ipv6: false, dns: { mode: 'dnsmasq' }, tun: { autoRedirect: true } }
const withRedirect = { ...config, inbounds: [{ type: 'tun', tag: 'tun-in', auto_route: true, auto_redirect: true }] }
const withoutRedirect = { ...config, inbounds: [{ type: 'tun', tag: 'tun-in', auto_route: true }] }
// 内核状态跟着落盘的配置走:配置里还有 auto_redirect 就"起来又死"、每死一次日志里多一句新进程的 FATAL;去掉就一直在跑。
// 日志开头是上一次部署留下的一句 FATAL:不能被当成这次的原因
const OLD_FATAL_LINE = 'Mon Sep  7 09:00:00 2026 daemon.err sing-box[111]: \x1b[31mFATAL[0000] start service: initialize outbound/vless[old]: stale reason\x1b[0m'
const redirectCtx = (fatal = REDIRECT_FATAL) => {
  const log = [OLD_FATAL_LINE]
  const redirectOn = () => {
    const written = ctx.writes.filter((w) => w.path === paths.configPath).pop()
    return written ? JSON.parse(written.content).inbounds[0].auto_redirect : true
  }
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: {
      '/etc/init.d/openbox restart': () => {
        if (redirectOn()) log.push(`Tue Sep  8 13:48:11 2026 daemon.err sing-box[${32332 + log.length}]: \x1b[31m${fatal}\x1b[0m`)
        return { code: 0, stdout: '' }
      },
      '/etc/init.d/openbox status': () => (redirectOn() ? { code: 1, stdout: 'inactive' } : { code: 0, stdout: 'running' }),
      'logread -e sing-box': () => ({ code: 0, stdout: `${log.join('\n')}\n` }),
    },
  })
  return ctx
}

test('auto_redirect 在 nftables 层起不来 → 关掉 auto_redirect 重新生成配置再起一次,成功但带降级说明', async () => {
  const ctx = redirectCtx()
  const patches = []
  const r = await deployConfig(ctx, paths, {
    config: withRedirect, profile: tunProfile,
    rebuild: (patch) => { patches.push(patch); return withoutRedirect },
  })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.stage, 'running')
  assert.match(r.warning, /auto_redirect/)
  assert.match(r.warning, /netlink receive: no such file or directory/)
  assert.match(r.warning, /kmod-nft-nat|PassWall/)
  // 重生成时把 tun.autoRedirect 关掉,别的档案字段不动
  assert.deepEqual(patches, [{ tun: { autoRedirect: false } }])
  // 落盘的是不带 auto_redirect 的那份;元数据也如实记 autoRedirect:false
  const lastConfig = ctx.writes.filter((w) => w.path === paths.configPath).pop()
  assert.equal(JSON.parse(lastConfig.content).inbounds[0].auto_redirect, undefined)
  const lastMeta = ctx.writes.filter((w) => w.path === configMetaPath(paths)).pop()
  assert.equal(JSON.parse(lastMeta.content).autoRedirect, false)
  // 降级后入口只有黑名单,原因写进元数据(规则页「业务入口」照它说明;GitHub #225 那台就是这种情况)
  const entryMode = JSON.parse(lastMeta.content).firstLayer.entryMode
  assert.equal(entryMode.mode, 'blacklist')
  assert.match(entryMode.reason, /纯 tun/)
  assert.equal(JSON.parse(lastMeta.content).flip?.entryMode, undefined, '热切换那一侧纯 tun 没有 need / entryMode')
  // 降级后入口文件按纯 tun 重写:回包打放行位,端口映射的回包不被拉进 tun(#383)
  const lastEntry = ctx.writes.filter((w) => w.path === paths.entryBypassPath).pop()
  assert.match(lastEntry.content, /ct direction reply meta mark set meta mark or 0x02000000/)
  // 起了三次(原样重试一次、降级一次),没有回滚直连
  assert.equal(cmds(ctx).filter((c) => c === '/etc/init.d/openbox restart').length, 3)
  assert.ok(!cmds(ctx).includes('/etc/init.d/openbox stop'))
})

test('降级之后还是起不来 → 只试一次,按普通崩溃回滚直连、带内核原话', async () => {
  const ctx = redirectCtx()
  const r = await deployConfig(ctx, paths, {
    config: withRedirect, profile: tunProfile,
    rebuild: () => withRedirect,   // "重生成"的还是带 auto_redirect 的,模拟降级后仍崩
  })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'verify')
  assert.match(r.message, /内核启动后崩溃/)
  assert.match(r.message, /netlink receive/)
  assert.equal(cmds(ctx).filter((c) => c === '/etc/init.d/openbox restart').length, 3)
  assert.ok(cmds(ctx).includes('/etc/init.d/openbox stop'))
})

// iStoreOS 用户 2026-10-05:升级时内核连着两次 flush nftables 撞上 ENOBUFS(确认塞满接收缓冲区),两次就降级成纯 tun,
// 旁路由的手机上不了外网。这一类是临时的:原样多起几次、间隔拉长,都不行才降级
const ENOBUFS_FATAL = 'FATAL[0001] start service: post-start inbound/tun[tun-in]: auto-redirect: setup nftables: flush nftables: netlink receive: recvmsg: no buffer space available'

test('auto_redirect 撞上 ENOBUFS → 原样隔 2 / 5 / 10 秒再起三次,都不行才降级', async () => {
  const ctx = redirectCtx(ENOBUFS_FATAL)
  const sleeps = []
  ctx.sleep = async (ms) => { sleeps.push(ms) }
  const r = await deployConfig(ctx, paths, { config: withRedirect, profile: tunProfile, rebuild: () => withoutRedirect })
  assert.equal(r.ok, true, r.message)
  assert.match(r.warning, /no buffer space available/)
  // 第一次 + 原样三次 + 降级一次;不再多走一遍普通的「原样再起一次」
  assert.equal(cmds(ctx).filter((c) => c === '/etc/init.d/openbox restart').length, 5)
  for (const ms of [2000, 5000, 10000]) assert.ok(sleeps.includes(ms), `要等过 ${ms} 毫秒再起`)
})

test('auto_redirect 撞上 ENOBUFS 一次、原样再起就好了 → 不降级,配置还是 auto_redirect', async () => {
  let restarts = 0
  const log = [OLD_FATAL_LINE]
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: {
      '/etc/init.d/openbox restart': () => {
        restarts += 1
        if (restarts === 1) log.push(`Mon Oct  5 23:30:38 2026 daemon.err sing-box[18688]: \x1b[31m${ENOBUFS_FATAL}\x1b[0m`)
        return { code: 0, stdout: '' }
      },
      '/etc/init.d/openbox status': () => (restarts === 1 ? { code: 1, stdout: 'inactive' } : { code: 0, stdout: 'running' }),
      'logread -e sing-box': () => ({ code: 0, stdout: `${log.join('\n')}\n` }),
    },
  })
  const rebuilt = []
  const r = await deployConfig(ctx, paths, { config: withRedirect, profile: tunProfile, rebuild: (patch) => { rebuilt.push(patch); return withoutRedirect } })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.warning, '')
  assert.deepEqual(rebuilt, [], '没有降级')
  assert.equal(restarts, 2)
  const lastConfig = ctx.writes.filter((w) => w.path === paths.configPath).pop()
  assert.equal(JSON.parse(lastConfig.content).inbounds[0].auto_redirect, true)
})

// 确认在跑之后才崩(GitHub #4:nft 那步排在 DNS 解析后面,第 5 秒才 FATAL):两眼确认时活着,后台再看时死了
const lateCtx = (fatal = REDIRECT_FATAL) => {
  const state = { crashed: false }
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: {
      '/etc/init.d/openbox status': () => {
        const written = ctx.writes.filter((w) => w.path === paths.configPath).pop()
        const redirect = written ? JSON.parse(written.content).inbounds[0].auto_redirect : true
        return state.crashed && redirect ? { code: 1, stdout: 'inactive' } : { code: 0, stdout: 'running' }
      },
      // 崩了才有这一句(重启前的日志里没有它)
      'logread -e sing-box': () => ({ code: 0, stdout: `${OLD_FATAL_LINE}\n${state.crashed ? `Tue Sep  8 15:18:47 2026 daemon.err sing-box[10798]: \x1b[31m${fatal}\x1b[0m\n` : ''}` }),
    },
  })
  return { ctx, state }
}
const noSleep = async () => {}

test('确认在跑之后才崩、且是 auto_redirect 那类 → 后台盯到后降级重来一次,降级说明从 lateCrashWatch 回来', async () => {
  const { ctx, state } = lateCtx()
  const patches = []
  const r = await deployConfig(ctx, paths, { config: withRedirect, profile: tunProfile, rebuild: (patch) => { patches.push(patch); return withoutRedirect } })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.warning, '')
  assert.equal(typeof r.lateCrashWatch, 'function')
  assert.equal(cmds(ctx).filter((c) => c === '/etc/init.d/openbox restart').length, 1)
  state.crashed = true
  const late = await r.lateCrashWatch({ sleep: noSleep })
  assert.equal(late.ok, true)
  assert.equal(late.stage, 'running')
  assert.match(late.warning, /auto_redirect/)
  assert.match(late.warning, /DNS 重定向/)
  assert.deepEqual(patches, [{ tun: { autoRedirect: false } }])
  const lastConfig = ctx.writes.filter((w) => w.path === paths.configPath).pop()
  assert.equal(JSON.parse(lastConfig.content).inbounds[0].auto_redirect, undefined)
  assert.equal(cmds(ctx).filter((c) => c === '/etc/init.d/openbox restart').length, 2)
  assert.ok(!cmds(ctx).includes('/etc/init.d/openbox stop'))
})

// GitHub #426:装着 PassWall / OpenClash 的路由器上,起 auto_redirect 要 fw4 reload,每次都重跑它们的规则,nft 那一步拖到第 89 秒
// 才 FATAL;procd 又立刻把内核拉起来,后台看状态一直是「在跑」。按日志里新进程的 FATAL 认出来,照样降级纯 tun;
// 旧进程(重启前就在日志里的进程号)被停时晚到的 FATAL 不算
test('auto_redirect 拖到一分多钟才 FATAL、procd 又拉起来了(状态一直在跑)→ 按新进程的 FATAL 认出来降级;旧进程的不算(#426)', async () => {
  const lines = [OLD_FATAL_LINE]
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: {
      '/etc/init.d/openbox status': { code: 0, stdout: 'running' },
      'logread -e sing-box': () => ({ code: 0, stdout: lines.join('\n') }),
    },
  })
  const r = await deployConfig(ctx, paths, { config: withRedirect, profile: tunProfile, rebuild: () => withoutRedirect })
  assert.equal(r.ok, true, r.message)
  const sleeps = []
  const late = await r.lateCrashWatch({
    sleep: async (ms) => {
      sleeps.push(ms)
      if (sleeps.length === 2) lines.push('Mon Oct  5 13:44:59 2026 daemon.err sing-box[111]: FATAL[0051] start service: post-start inbound/tun[tun-in]: auto-redirect: setup nftables: flush nftables: netlink receive: recvmsg: no buffer space available')
      if (sleeps.length === 3) lines.push('Mon Oct  5 13:46:30 2026 daemon.err sing-box[23812]: FATAL[0089] start service: post-start inbound/tun[tun-in]: auto-redirect: setup nftables: flush nftables: netlink receive: recvmsg: no buffer space available')
    },
  })
  assert.equal(late.ok, true)
  assert.match(late.warning, /auto_redirect/)
  assert.match(late.warning, /no buffer space available/)
  assert.deepEqual(sleeps.slice(0, 3), [6000, 6000, 20000], '第二眼时只有旧进程的 FATAL,不降级;第三眼新进程的才算')
  const lastConfig = ctx.writes.filter((w) => w.path === paths.configPath).pop()
  assert.equal(JSON.parse(lastConfig.content).inbounds[0].auto_redirect, undefined)
  assert.equal(cmds(ctx).filter((c) => c === '/etc/init.d/openbox restart').length, 2)
})

test('确认在跑之后才崩、不是 auto_redirect 那类 → 回滚直连,带内核原话;一直在跑 / 又有新部署时后台什么都不做', async () => {
  const other = 'FATAL[0005] start service: initialize outbound/hysteria2[x]: bad config'
  const { ctx, state } = lateCtx(other)
  const r = await deployConfig(ctx, paths, { config: withRedirect, profile: tunProfile, rebuild: () => withoutRedirect })
  assert.equal(r.ok, true)
  state.crashed = true
  const late = await r.lateCrashWatch({ sleep: noSleep })
  assert.equal(late.ok, false)
  assert.equal(late.stage, 'verify')
  assert.match(late.message, /bad config/)
  assert.ok(cmds(ctx).includes('/etc/init.d/openbox stop'))
  // 一直在跑:两眼都没事就回 null
  const alive = lateCtx()
  const r2 = await deployConfig(alive.ctx, paths, { config: withRedirect, profile: tunProfile, rebuild: () => withoutRedirect })
  assert.equal(await r2.lateCrashWatch({ sleep: noSleep }), null)
  // 已经有新的部署开始:不看、不动
  const stale = lateCtx()
  const r3 = await deployConfig(stale.ctx, paths, { config: withRedirect, profile: tunProfile, rebuild: () => withoutRedirect })
  stale.state.crashed = true
  const before = cmds(stale.ctx).length
  assert.equal(await r3.lateCrashWatch({ sleep: noSleep, isStale: () => true }), null)
  assert.equal(cmds(stale.ctx).length, before)
})

test('不是 auto_redirect 那类崩溃、或没开 auto_redirect、或没给 rebuild → 不降级,照旧回滚', async () => {
  const other = 'FATAL[0000] start service: initialize outbound/hysteria2[x]: bad config'
  // 没给 rebuild 时 auto_redirect 那类照样先原样重试一次(撞上旧状态的第二次就好),再起不来才回滚
  for (const [ctx, profile, rebuild, restarts] of [
    [redirectCtx(other), tunProfile, () => withoutRedirect, 1],
    [redirectCtx(), { ...tunProfile, tun: { autoRedirect: false } }, () => withoutRedirect, 1],
    [redirectCtx(), tunProfile, undefined, 2],
  ]) {
    const r = await deployConfig(ctx, paths, { config: withRedirect, profile, rebuild })
    assert.equal(r.ok, false)
    assert.equal(r.stage, 'verify')
    assert.equal(cmds(ctx).filter((c) => c === '/etc/init.d/openbox restart').length, restarts)
    assert.ok(cmds(ctx).includes('/etc/init.d/openbox stop'))
    assert.doesNotMatch(r.message, /stale reason/, '上一次部署留下的 FATAL 不能当成这次的原因')
  }
  assert.ok(AUTO_REDIRECT_FATAL.test(REDIRECT_FATAL))
  assert.ok(AUTO_REDIRECT_FATAL.test('FATAL[0000] start service: post-start inbound/tun[tun-in]: auto-redirect: setup nftables: flush nftables: conn.Receive: netlink receive: file exists'))
  // GitHub #137:固件没有 nf_tables 时 sing-tun 的原话不一样,同样要降级
  assert.ok(AUTO_REDIRECT_FATAL.test('FATAL[0000] start service: post-start inbound/tun[tun-in]: auto-redirect: missing nftables support: netlink receive: invalid argument'))
  assert.ok(!AUTO_REDIRECT_FATAL.test(other))
  // 临时性的那一类只认缓冲区塞满 / 分不到内存;缺模块、规则冲突不算
  assert.ok(TRANSIENT_REDIRECT_FATAL.test(ENOBUFS_FATAL))
  assert.ok(!TRANSIENT_REDIRECT_FATAL.test(REDIRECT_FATAL))
})

// #386:旧内核被 procd 到点强杀、tun 网卡还在注销新进程就起来了,建路由失败。原样再起一次就好,不回滚、不降级
test('起 tun 撞上上一个内核没拆完的状态(set routes 失败)→ 原样再起一次,起来了就算成功', async () => {
  const tunFatal = 'FATAL[0000] start service: post-start inbound/tun[tun-in]: starting TUN interface: set routes: add route 56: no route to host'
  assert.ok(TUN_START_FATAL.test(tunFatal))
  assert.ok(TUN_START_FATAL.test('FATAL[0000] start service: initialize inbound/tun[tun-in]: configure tun interface: device or resource busy'))
  assert.ok(!TUN_START_FATAL.test(REDIRECT_FATAL))
  const log = [OLD_FATAL_LINE]
  let restarts = 0
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: {
      '/etc/init.d/openbox restart': () => {
        restarts += 1
        if (restarts === 1) log.push(`Sat Oct  3 10:09:15 2026 daemon.err sing-box[24437]: \x1b[31m${tunFatal}\x1b[0m`)
        return { code: 0, stdout: '' }
      },
      '/etc/init.d/openbox status': () => (restarts === 1 ? { code: 1, stdout: 'inactive' } : { code: 0, stdout: 'running' }),
      'logread -e sing-box': () => ({ code: 0, stdout: `${log.join('\n')}\n` }),
    },
  })
  const r = await deployConfig(ctx, paths, { config: withRedirect, profile: tunProfile, rebuild: () => withoutRedirect })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.warning, '', '没有降级')
  assert.equal(restarts, 2)
  const lastConfig = ctx.writes.filter((w) => w.path === paths.configPath).pop()
  assert.equal(JSON.parse(lastConfig.content).inbounds[0].auto_redirect, true, '配置还是 auto_redirect 那份')
  assert.ok(!cmds(ctx).includes('/etc/init.d/openbox stop'))
})

test('新进程没留 FATAL 就死了(被杀、OOM):日志里以前的 auto_redirect FATAL 不算数,不重试不降级,原因说不清就照实说', async () => {
  const ctx = createMockContext({
    files: { [paths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: {
      '/etc/init.d/openbox status': { code: 1, stdout: 'inactive' },
      // 只有上一次降级时留下的那句,这次重启之后没有新行
      'logread -e sing-box': { code: 0, stdout: `Tue Sep  8 13:48:11 2026 daemon.err sing-box[32332]: \x1b[31m${REDIRECT_FATAL}\x1b[0m\n` },
    },
  })
  const patches = []
  const r = await deployConfig(ctx, paths, { config: withRedirect, profile: tunProfile, rebuild: (patch) => { patches.push(patch); return withoutRedirect } })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'verify')
  assert.deepEqual(patches, [], '不能拿老的那句去降级')
  assert.match(r.message, /内核启动后未在运行/)
  assert.equal(cmds(ctx).filter((c) => c === '/etc/init.d/openbox restart').length, 1)
})

test('config.meta.json 记下第一层的判定:DNS 转发计划、入口原生旁路、终端来源 DNS 规则是否生效', async () => {
  const ctx = okCtx()
  const r = await deployConfig(ctx, paths, {
    // 兜底 selector 的成员用内核里的真实 tag(内置直连叫「直连」),部署就是从它身上读成员表的
    config: { ...config, outbounds: [{ type: 'direct', tag: '直连' }, { type: 'selector', tag: '其他', outbounds: ['直连'], default: '直连' }] },
    profile: {
      ipv6: false, dns: { mode: 'dnsmasq' }, tun: { autoRedirect: true },
      routing: { fallbackDefault: 'direct', policies: [{ id: 'cn', name: '国内', default: 'direct', rulesets: ['geoip-cn'] }] },
      clientRoutes: [],
    },
  })
  assert.equal(r.ok, true, r.message)
  const meta = JSON.parse(ctx.writes.filter((w) => w.path === configMetaPath(paths)).pop().content)
  assert.equal(meta.firstLayer.dnsMode, 'dnsmasq')
  assert.equal(meta.firstLayer.dnsForward, 'none')             // 全部直连:一个域名都不转发
  assert.match(meta.firstLayer.dnsForwardReason, /原有上游/)
  assert.equal(meta.firstLayer.nativeBypass.enabled, true)
  assert.deepEqual(meta.firstLayer.nativeBypass.sets, ['geoip-cn'])
  assert.equal(meta.firstLayer.nativeBypass.via, 'nft')
  // 计划阶段(纯函数)的结论、指纹和出口类别表也记下来:选择同步时按同口径比;FakeIP 试验没开
  assert.deepEqual(meta.firstLayer.nativeBypassPlanned, { sets: ['geoip-cn'], pending: [] })
  assert.equal(typeof meta.firstLayer.nativeBypassPlanKey, 'string')
  assert.deepEqual(meta.firstLayer.policyClasses, { 国内: 'direct', 其他: 'direct' })
  assert.equal(meta.firstLayer.fakeIp, false)
  assert.equal(meta.firstLayer.dnsSourceRules, false)
  // 全部直连时 dnsmasq 不被接管:没有 add_list 127.0.0.1#7853
  assert.ok(!cmds(ctx).some((c) => c.includes('add_list') && c.includes('127.0.0.1#7853')))
})

test('部署时把走代理站点集的 geosite 解码进转发名单:元数据记实际 domains、条目数和超集说明;解不开就 all 并说明（第三轮 阶段 2）', async () => {
  const withRulesets = (json) => {
    const ctx = okCtx({ 'uci -q show dhcp.@dnsmasq[0]': { code: 0, stdout: 'dhcp.cfg=dnsmasq\n' } })
    // 路由器自己的上游在 netifd 写的解析文件里(没有它就只能全量转发,#412)
    ctx.files['/tmp/resolv.conf.d/resolv.conf.auto'] = '# Interface wan\nnameserver 192.168.1.1\n'
    ctx.files[`${paths.geoDir}/geosite-youtube.srs`] = 'srs'
    ctx.files[`${paths.dataDir}/tmp/geosite-youtube.dns-forward.json`] = JSON.stringify(json)
    return ctx
  }
  const profile = {
    ipv6: false, dns: { mode: 'dnsmasq' }, tun: { autoRedirect: true },
    routing: { fallbackDefault: 'direct', policies: [{ id: 'y', name: 'Youtube', default: '香港-自动', rulesets: ['geosite-youtube'] }, { id: 'cn', name: '国内', default: 'direct', rulesets: ['geoip-cn'] }] },
  }
  const cfg = { ...config, outbounds: [{ type: 'direct', tag: '直连' }, { type: 'selector', tag: '香港-自动', outbounds: ['直连'] }, { type: 'selector', tag: '其他', outbounds: ['直连', '香港-自动'], default: '直连' }] }
  const ctx = withRulesets({ rules: [{ domain_suffix: ['youtube.com', 'googlevideo.com'], domain_regex: ['^r+[0-9]+\\.googlevideo\\.com$'] }] })
  const r = await deployConfig(ctx, paths, { config: cfg, profile })
  assert.equal(r.ok, true, r.message)
  const meta = JSON.parse(ctx.writes.filter((w) => w.path === configMetaPath(paths)).pop().content)
  assert.equal(meta.firstLayer.dnsForwardPlanned, 'domains')
  assert.equal(meta.firstLayer.dnsForward, 'domains')
  assert.equal(meta.firstLayer.dnsForwardDomains, 2)
  assert.deepEqual(meta.firstLayer.dnsForwardExpanded, ['geosite-youtube:2'])
  assert.deepEqual(meta.firstLayer.dnsForwardSuperset, ['geosite-youtube:googlevideo.com'])
  // 转发文件写了、装进了 conf-dir;uci 列表没动
  assert.ok(ctx.writes.some((w) => w.path === '/tmp/dnsmasq.cfg.d/open-box.conf' && /server=\/youtube\.com\/127\.0\.0\.1#7853/.test(w.content)))
  assert.ok(!cmds(ctx).some((c) => c.includes('add_list dhcp.@dnsmasq[0].server')))
  // 关键词展不开 → 实际 all,元数据记 all + 原因,计划阶段仍是 domains
  const ctx2 = withRulesets({ rules: [{ domain_keyword: ['youtube'] }] })
  const r2 = await deployConfig(ctx2, paths, { config: cfg, profile })
  assert.equal(r2.ok, true, r2.message)
  const meta2 = JSON.parse(ctx2.writes.filter((w) => w.path === configMetaPath(paths)).pop().content)
  assert.equal(meta2.firstLayer.dnsForwardPlanned, 'domains')
  assert.equal(meta2.firstLayer.dnsForward, 'all')
  assert.match(meta2.firstLayer.dnsForwardReason, /geosite-youtube.*关键词/)
  assert.ok(cmds(ctx2).includes('uci add_list dhcp.@dnsmasq[0].server=127.0.0.1#7853'))
})

test('config.meta.json 的 firstLayer 记 IPv6 分层模式:关 → off,开 → node,开 + 降为 IPv4 → ipv4', async () => {
  const run = async (over) => {
    const ctx = okCtx()
    const r = await deployConfig(ctx, paths, {
      config: { ...config, outbounds: [{ type: 'direct', tag: '直连' }, { type: 'selector', tag: '其他', outbounds: ['直连'], default: '直连' }] },
      profile: { ipv6: false, dns: { mode: 'dnsmasq' }, tun: { autoRedirect: true }, routing: { fallbackDefault: 'direct', policies: [] }, clientRoutes: [], ...over },
    })
    assert.equal(r.ok, true, r.message)
    return JSON.parse(ctx.writes.filter((w) => w.path === configMetaPath(paths)).pop().content).firstLayer.ipv6
  }
  assert.equal(await run({ ipv6: false, ipv6Proxy: 'ipv4' }), 'off')
  assert.equal(await run({ ipv6: true }), 'node')
  assert.equal(await run({ ipv6: true, ipv6Proxy: 'ipv4' }), 'ipv4')
})

// Debian / Ubuntu(system/platform.mjs 的 systemd):没有 uci 防火墙和 dnsmasq 可接管,回滚只剩停内核;
// 服务脚本换成 debian/bin/openbox-ctl。硬跑 uci 的话回滚步骤会失败,一次干净的回滚被报成"恢复直连未完成"
const sdPaths = createPaths('/opt/open-box', { platform: 'systemd' })

test('systemd 平台:rollbackToDirect 只停内核,不碰 uci / dnsmasq', async () => {
  const ctx = createMockContext()
  const r = await rollbackToDirect(ctx, sdPaths)
  assert.equal(r.ok, true)
  assert.deepEqual(r.actions, ['stop-core'])
  assert.deepEqual(r.failures, [])
  const c = cmds(ctx)
  assert.ok(c.includes('/opt/open-box/debian/bin/openbox-ctl stop'))
  assert.ok(!c.some((x) => /^uci |^\/etc\/init\.d\//.test(x)), c.join('\n'))
})

test('systemd 平台:部署不写 uci 防火墙、不接管 dnsmasq,内核用 debian/bin/openbox-ctl 重启', async () => {
  const ctx = createMockContext({
    files: { [sdPaths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: { '/opt/open-box/debian/bin/openbox-ctl status': { code: 0, stdout: 'running' } },
  })
  const r = await deployConfig(ctx, sdPaths, { config, profile })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.stage, 'running')
  const c = cmds(ctx)
  assert.ok(c.includes('/opt/open-box/debian/bin/openbox-ctl restart'))
  assert.ok(!c.some((x) => /^uci |^\/etc\/init\.d\//.test(x)), c.join('\n'))
  assert.ok(ctx.writes.some((w) => w.path === sdPaths.configPath))
})

test('systemd 平台:入口白名单只认局域网口,内核自己的 openbox-tun 不在 iifname 里(tun 回灌的包不能被打放行位)', async () => {
  const ctx = createMockContext({
    files: { [sdPaths.singbox]: '#!/bin/sh\n', [TUN_DEVICE]: '' },
    execResults: {
      '/opt/open-box/debian/bin/openbox-ctl status': { code: 0, stdout: 'running' },
      'ip -4 -o addr': { code: 0, stdout: '2: eth0    inet 192.168.3.23/24 brd 192.168.3.255 scope global eth0\n31: openbox-tun    inet 172.19.0.1/30 brd 172.19.0.3 scope global openbox-tun\n' },
    },
  })
  const r = await deployConfig(ctx, sdPaths, {
    config,
    profile: {
      // 黑名单那份填的 22 不能跟着进白名单:只有选中的那份生效
      ipv6: false, dns: { mode: 'hijack' }, tun: { autoRedirect: true }, bypassPorts: '22', bypassPortsWhitelist: '443', bypassPortsMode: 'whitelist',
      clientRoutes: [{ id: 'a', admit: true, match: 'ip', sources: ['192.168.3.50'] }],
    },
  })
  assert.equal(r.ok, true, r.message)
  const nft = ctx.writes.filter((w) => w.path === sdPaths.entryBypassPath).pop().content
  assert.match(nft, /iifname \{ "eth0" \} meta l4proto \{ tcp, udp \} th dport != \{ 443 \}/)
  assert.doesNotMatch(nft, /\b22\b/)
  assert.match(nft, /iifname \{ "eth0" \} meta nfproto ipv4 ip saddr != \{ 192\.168\.3\.50\/32 \}/)
  assert.doesNotMatch(nft, /openbox-tun/)
})

test('systemd 平台:内核起不来时 tun 缺失的提示不再让人 opkg', async () => {
  const ctx = createMockContext({ files: { [sdPaths.singbox]: '#!/bin/sh\n' } })
  const r = await deployConfig(ctx, sdPaths, { config, profile })
  assert.equal(r.ok, false)
  assert.match(r.message, /modprobe tun/)
  assert.doesNotMatch(r.message, /opkg/)
})

test('动态集编不出来:校验失败时先报校验的归因;校验过了才报编译错误,内核不重启', async () => {
  const boom = async () => { throw new Error('动态集合「进内核 obflip-need-all」编不出来,先按占位处理:exit 1') }
  // 校验也失败(全部命令失败):用户看到的是校验归因,不是编译错误
  const bad = createMockContext({ defaultExec: { code: 1, stderr: 'FATAL: unknown method: x' } })
  const r1 = await deployConfig(bad, paths, { config: { outbounds: [{ type: 'shadowsocks', tag: 'bad', server: 'a', server_port: 1, method: 'x' }] }, profile, writeFlip: boom })
  assert.equal(r1.stage, 'validate')
  assert.deepEqual(r1.badTags, ['bad'])
  // 校验过了:按原样报编译错误,不落盘、不重启
  const ok = okCtx()
  const r2 = await deployConfig(ok, paths, { config, profile, writeFlip: boom })
  assert.equal(r2.ok, false)
  assert.equal(r2.stage, 'error')
  assert.match(r2.message, /编不出来/)
  assert.ok(!ok.writes.some((w) => w.path === paths.configPath))
  assert.ok(!cmds(ok).includes('/etc/init.d/openbox restart'))
})
