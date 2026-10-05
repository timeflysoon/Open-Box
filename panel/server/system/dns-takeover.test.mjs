import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'
import { applyDnsTakeover, restoreDnsTakeover, dnsmasqSafeDomain, dnsForwardFilePath, queryLogFailedPath } from './dns-takeover.mjs'
import { DNSMASQ_QUERY_LOG_PATH } from './dnsmasq-query-log.mjs'

const paths = createPaths('/opt/open-box')
const cmds = (ctx) => ctx.calls.map((c) => [c.cmd, ...c.args].join(' '))

// 会真实更新状态的 uci 桩:set / delete / add_list / del_list 改了之后,后面的 get / show 读到的
// 是改过的值。只记命令的桩看不出"从 all 切到 domains 时原上游早就被删光了"这类问题(复审 R4)
// grep:dnsmasq 别处已有日志设置时 grep -H 列出的「文件:那一行」;dnsmasqUp:pidof 找不找得到 dnsmasq(第几次查、返回真假)
const statefulUci = ({ servers = [], noresolv = null, files = {}, options = {}, grep = '', dnsmasqUp = () => true } = {}) => {
  const state = { servers: [...servers], noresolv }
  const ctx = createMockContext({ files })
  let pidofCalls = 0
  ctx.exec = async (cmd, args = []) => {
    ctx.calls.push({ cmd, args })
    if (cmd === 'pidof') return { code: dnsmasqUp(++pidofCalls) ? 0 : 1, stdout: '', stderr: '' }
    if (cmd === 'sh' && String(args[1]).includes('log-(facility|queries)')) return { code: 0, stdout: grep, stderr: '' }
    let stdout = ''
    if (cmd === 'uci') {
      const [verb, item = ''] = args.filter((v) => v !== '-q')
      const [key, ...rest] = item.split('=')
      const value = rest.join('=')
      if (verb === 'show') stdout = `dhcp.cfg=dnsmasq\n${state.servers.length ? `dhcp.cfg.server=${state.servers.map((x) => `'${x}'`).join(' ')}\n` : ''}${state.noresolv == null ? '' : `dhcp.cfg.noresolv='${state.noresolv}'\n`}`
      if (verb === 'get') stdout = key.endsWith('.server') ? state.servers.join(' ') : key.endsWith('.noresolv') ? (state.noresolv ?? '') : (options[key.split('.').pop()] ?? '')
      if (verb === 'delete' && key.endsWith('.server')) state.servers = []
      if (verb === 'delete' && key.endsWith('.noresolv')) state.noresolv = null
      if (verb === 'set' && key.endsWith('.noresolv')) state.noresolv = value
      if (verb === 'add_list' && key.endsWith('.server') && !state.servers.includes(value)) state.servers.push(value)
      if (verb === 'del_list' && key.endsWith('.server')) state.servers = state.servers.filter((v) => v !== value)
    }
    return { code: 0, stdout, stderr: '' }
  }
  return { ctx, state }
}

// conf-dir 里的转发文件(mock 的 uci show 段名是 cfg → /tmp/dnsmasq.cfg.d)
const INSTALLED = '/tmp/dnsmasq.cfg.d/open-box.conf'
const FORWARD_SRC = dnsForwardFilePath(paths)
const STATE = '/opt/open-box/data/dnsmasq-takeover.txt'
const BACKUP = '/opt/open-box/data/dnsmasq-backup.txt'
const writes = (ctx) => ctx.calls.filter((c) => c.cmd === 'uci' && !['get', 'show'].includes(c.args.filter((v) => v !== '-q')[0])).map((c) => [c.cmd, ...c.args].join(' '))

for (const planMode of ['domains', 'all']) {
  test(`${planMode}:重写例外随规则增删,幂等,泛域名转成受支持的后缀,保留用户白名单和 rebind 保护`, async () => {
    const userConf = '/tmp/dnsmasq.cfg.d/user.conf'
    const uci = statefulUci({ servers: ['9.9.9.9'], files: { [userConf]: 'rebind-domain-ok=/existing.example/\n' } })
    const apply = (rewriteSources) => applyDnsTakeover(uci.ctx, paths, {
      mode: 'dnsmasq', forward: { mode: planMode, domains: ['example.test'] }, rewriteSources,
    })
    await apply(['*.Example.Test.', 'alias.example.net', '*.example.test', 'bad/#name'])
    const text = uci.ctx.files[INSTALLED]
    assert.match(text, /rebind-domain-ok=\/example\.test\//)
    assert.match(text, /rebind-domain-ok=\/alias\.example\.net\//)
    assert.equal(text.match(/rebind-domain-ok=/g).length, 2)
    assert.ok(!text.includes('bad/#name'))
    assert.equal(uci.ctx.files[FORWARD_SRC], text, '持久正本与运行文件一致,供开机重放')
    assert.equal((await apply(['alias.example.net', '*.example.test'])).changed, false)
    assert.equal((await apply(['new.example.org'])).changed, true)
    assert.ok(!uci.ctx.files[INSTALLED].includes('alias.example.net'))
    assert.match(uci.ctx.files[INSTALLED], /rebind-domain-ok=\/new\.example\.org\//)
    await apply([])
    assert.ok(!(uci.ctx.files[INSTALLED] || '').includes('rebind-domain-ok='))
    assert.ok(!(uci.ctx.files[FORWARD_SRC] || '').includes('rebind-domain-ok='))
    assert.equal(uci.ctx.files[userConf], 'rebind-domain-ok=/existing.example/\n')
    assert.ok(!writes(uci.ctx).some((c) => /rebind/.test(c)), '不能写用户的 UCI 白名单 / 保护开关')
  })
}

test('重写例外在 domains ↔ all 之间保留,none 和回滚只移除 Open-Box 的文件', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9'] })
  const apply = (mode) => applyDnsTakeover(uci.ctx, paths, {
    mode: 'dnsmasq', forward: { mode, domains: ['example.test'] }, rewriteSources: ['*.example.test'],
  })
  await apply('domains')
  assert.match(uci.ctx.files[INSTALLED], /server=/)
  await apply('all')
  assert.equal(uci.ctx.files[INSTALLED], 'rebind-domain-ok=/example.test/\n')
  await apply('domains')
  assert.match(uci.ctx.files[INSTALLED], /server=/)
  assert.match(uci.ctx.files[INSTALLED], /rebind-domain-ok=/)
  await apply('none')
  assert.equal(await uci.ctx.exists(INSTALLED), false)
  assert.equal(await uci.ctx.exists(FORWARD_SRC), false)
  await apply('all')
  await restoreDnsTakeover(uci.ctx, paths)
  assert.equal(await uci.ctx.exists(INSTALLED), false)
  assert.equal(await uci.ctx.exists(FORWARD_SRC), false)
  assert.deepEqual(uci.state.servers, ['9.9.9.9'])
})

test('hijack 模式不动系统', async () => {
  const ctx = createMockContext()
  const r = await applyDnsTakeover(ctx, paths, { mode: 'hijack' })
  assert.equal(r.changed, false)
  assert.deepEqual(ctx.calls, [])
})

test('dnsmasq 模式 all:备份用户基线 + 上游只剩内核 + noresolv=1 + 重启;状态文件记 plan=all', async () => {
  const uci = statefulUci({ servers: ['223.5.5.5'], noresolv: '0' })
  const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq' })
  assert.equal(r.changed, true)
  assert.deepEqual(r.effective, { mode: 'all', domains: [], reason: '' })
  assert.deepEqual(uci.state, { servers: ['127.0.0.1#7853'], noresolv: '1' })
  const c = cmds(uci.ctx)
  assert.ok(c.includes('uci commit dhcp'))
  assert.ok(c.includes('/etc/init.d/dnsmasq restart'))
  // 备份 = 接管前用户的设置(uci show 形态,段名沿用)
  assert.equal(uci.ctx.files[BACKUP], "dhcp.cfg=dnsmasq\ndhcp.cfg.server='223.5.5.5'\ndhcp.cfg.noresolv='0'\n")
  // 状态文件:开机时 init 脚本照抄的就是这份
  assert.equal(uci.ctx.files[STATE], 'plan=all\nserver=127.0.0.1#7853\nnoresolv=1\n')
})

test('dnsmasq 模式 all:已经接管过（备份里是 9.9.9.9）再应用 all,备份里的用户上游不会被此刻只剩内核的列表冲掉', async () => {
  const uci = statefulUci({ servers: ['127.0.0.1#7853'], noresolv: '1', files: { [BACKUP]: "dhcp.cfg=dnsmasq\ndhcp.cfg.server='9.9.9.9'\n", [STATE]: 'plan=all\nserver=127.0.0.1#7853\nnoresolv=1\n' } })
  const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq' })
  assert.deepEqual(r, { changed: false, actions: ['unchanged'], effective: { mode: 'all', domains: [], reason: '' }, queryLog: { active: false, reason: '' } })
  assert.ok(uci.ctx.files[BACKUP].includes("'9.9.9.9'"))
  assert.ok(!uci.ctx.files[BACKUP].includes('127.0.0.1#7853'))
})

test('还原:清除写入值并恢复备份,删备份文件', async () => {
  const ctx = createMockContext({
    files: { '/opt/open-box/data/dnsmasq-backup.txt': "dhcp.cfg01411c.server='223.5.5.5'\ndhcp.cfg01411c.noresolv='0'\n" },
  })
  const r = await restoreDnsTakeover(ctx, paths)
  assert.equal(r.restored, true)
  const c = cmds(ctx)
  assert.ok(c.includes('uci -q delete dhcp.@dnsmasq[0].server'))
  assert.ok(c.includes('uci add_list dhcp.@dnsmasq[0].server=223.5.5.5'))
  assert.ok(c.includes('uci set dhcp.@dnsmasq[0].noresolv=0'))
  assert.ok(c.includes('uci commit dhcp'))
  assert.equal(await ctx.exists('/opt/open-box/data/dnsmasq-backup.txt'), false)
})

test('还原:一并删掉开机照抄用的状态文件和转发文件,切模式 / 回滚后开机不再接管', async () => {
  const ctx = createMockContext({ files: { [BACKUP]: "dhcp.cfg.server='223.5.5.5'\n", [STATE]: 'plan=domains\n', [FORWARD_SRC]: 'x', ['/tmp/dnsmasq.d/open-box.conf']: 'x' } })
  await restoreDnsTakeover(ctx, paths)
  assert.equal(await ctx.exists(STATE), false)
  assert.equal(await ctx.exists(FORWARD_SRC), false)
  assert.equal(await ctx.exists('/tmp/dnsmasq.d/open-box.conf'), false)
})

test('还原:无备份时不删用户 server 列表,只精确撤销写入的上游', async () => {
  const ctx = createMockContext()
  const r = await restoreDnsTakeover(ctx, paths)
  assert.equal(r.restored, true)
  const c = cmds(ctx)
  assert.ok(!c.includes('uci -q delete dhcp.@dnsmasq[0].server'))
  assert.ok(c.includes('uci -q del_list dhcp.@dnsmasq[0].server=127.0.0.1#7853'))
  assert.ok(c.includes('uci commit dhcp'))
})

test('还原:多上游备份（同行多个引号值）全部恢复,而非只恢复第一个', async () => {
  const ctx = createMockContext({
    files: { '/opt/open-box/data/dnsmasq-backup.txt': "dhcp.cfg.server='1.1.1.1' '8.8.8.8'\ndhcp.cfg.noresolv='0'\n" },
  })
  const r = await restoreDnsTakeover(ctx, paths)
  assert.equal(r.restored, true)
  const c = cmds(ctx)
  assert.ok(c.includes('uci add_list dhcp.@dnsmasq[0].server=1.1.1.1'))
  assert.ok(c.includes('uci add_list dhcp.@dnsmasq[0].server=8.8.8.8'))
  assert.ok(c.includes('uci set dhcp.@dnsmasq[0].noresolv=0'))
})

test('按域名转发:转发文件写进 dnsmasq 的 conf-dir（一行一条）,uci 列表一个字不碰,noresolv 跟用户基线', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9'], noresolv: null })
  const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forwardDomains: ['google.com', 'youtube.com'] })
  assert.ok(r.changed)
  assert.ok(r.actions.includes('set-per-domain'))
  assert.deepEqual(r.effective, { mode: 'domains', domains: ['google.com', 'youtube.com'], reason: '' })
  assert.equal(uci.ctx.files[INSTALLED], uci.ctx.files[FORWARD_SRC])
  assert.match(uci.ctx.files[INSTALLED], /^server=\/google\.com\/127\.0\.0\.1#7853$/m)
  assert.match(uci.ctx.files[INSTALLED], /^server=\/youtube\.com\/127\.0\.0\.1#7853$/m)
  assert.deepEqual(uci.state, { servers: ['9.9.9.9'], noresolv: null })
  assert.ok(!writes(uci.ctx).some((c) => /add_list|delete|set/.test(c)), '用户的 uci 列表不该被改')
  assert.ok(cmds(uci.ctx).includes('/etc/init.d/dnsmasq restart'))
  assert.equal(uci.ctx.files[STATE], `plan=domains\nforward=${INSTALLED}\n`)
})

test('没有可枚举的域名时回落到全局转发（和以前一样）', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9'], noresolv: null })
  const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forwardDomains: [] })
  assert.ok(r.actions.includes('set-upstream'))
  assert.deepEqual(uci.state, { servers: ['127.0.0.1#7853'], noresolv: '1' })
})

test('按域名转发:老版本留在 uci 里的按域名条目和全量上游都摘掉,用户的上游（AdGuard）原样保留', async () => {
  const uci = statefulUci({ servers: ['192.168.3.5', '/old.com/127.0.0.1#7853', '127.0.0.1#7853'], noresolv: null })
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forwardDomains: ['google.com'] })
  assert.deepEqual(uci.state, { servers: ['192.168.3.5'], noresolv: null })
  assert.match(uci.ctx.files[INSTALLED], /google\.com/)
})

test('域名规范化:中文域名按 IDNA 转成 punycode 照样按域名转发;真写不进 dnsmasq 的（带 / #）应用阶段降成 all,状态和返回值记的都是实际执行的 all（复审 S3）', async () => {
  assert.equal(dnsmasqSafeDomain('中文.com'), 'xn--fiq228c.com')
  assert.equal(dnsmasqSafeDomain('*.Example.COM'), 'example.com')
  assert.equal(dnsmasqSafeDomain('.example.com.'), 'example.com')
  assert.equal(dnsmasqSafeDomain('a/#b.com'), null)
  assert.equal(dnsmasqSafeDomain('x'.repeat(64) + '.com'), null)
  const ok = statefulUci({ servers: ['9.9.9.9'], noresolv: null })
  const r1 = await applyDnsTakeover(ok.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['xn--fiq228c.com'], reason: '' } })
  assert.equal(r1.effective.mode, 'domains')
  assert.match(ok.ctx.files[INSTALLED], /xn--fiq228c\.com/)
  const bad = statefulUci({ servers: ['9.9.9.9'], noresolv: null })
  const r2 = await applyDnsTakeover(bad.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['a/#b.com'], reason: '' } })
  assert.equal(r2.effective.mode, 'all')
  assert.match(r2.effective.reason, /写不进/)
  assert.deepEqual(bad.state, { servers: ['127.0.0.1#7853'], noresolv: '1' })
  assert.ok(bad.ctx.files[STATE].startsWith('plan=all\n'))
  assert.equal(await bad.ctx.exists(INSTALLED), false)
})

test('uci commit 失败（闪存写满）必须抛错,不能报部署成功', async () => {
  const ctx = createMockContext({ execResults: {
    'uci commit dhcp': { code: 1, stderr: 'uci: I/O error' },
  } })
  await assert.rejects(() => applyDnsTakeover(ctx, paths, { mode: 'dnsmasq' }), /uci commit dhcp 失败/)
})

test('已经是目标状态:all 不 commit、不重启 dnsmasq,只刷新状态文件;domains 转发文件和 uci 都没变也一样,差一个域名就得写', async () => {
  const all = statefulUci({ servers: ['127.0.0.1#7853'], noresolv: '1', files: { [BACKUP]: "dhcp.cfg=dnsmasq\ndhcp.cfg.server='9.9.9.9'\n", [STATE]: 'plan=all\nserver=127.0.0.1#7853\nnoresolv=1\n' } })
  const r = await applyDnsTakeover(all.ctx, paths, { mode: 'dnsmasq' })
  assert.deepEqual(r.actions, ['unchanged'])
  assert.ok(!all.ctx.calls.some((c) => c.cmd === '/etc/init.d/dnsmasq'), '不该重启 dnsmasq')
  assert.ok(!all.ctx.calls.some((c) => c.cmd === 'uci' && c.args[0] === 'commit'), '不该 commit')
  assert.ok(all.ctx.writes.some((w) => w.path === STATE), '状态文件照样写')

  const dom = statefulUci({ servers: ['223.5.5.5'], noresolv: null })
  assert.equal((await applyDnsTakeover(dom.ctx, paths, { mode: 'dnsmasq', forwardDomains: ['b.com', 'a.com'] })).changed, true)
  assert.equal((await applyDnsTakeover(dom.ctx, paths, { mode: 'dnsmasq', forwardDomains: ['a.com', 'b.com'] })).changed, false)
  assert.equal((await applyDnsTakeover(dom.ctx, paths, { mode: 'dnsmasq', forwardDomains: ['a.com', 'c.com'] })).changed, true)
})

test('dnsmasq 模式:dnsmasq 重启失败必须抛错,不能报部署成功', async () => {
  const ctx = createMockContext({ execResults: {
    '/etc/init.d/dnsmasq restart': { code: 1, stderr: 'dnsmasq: bad option' },
  } })
  await assert.rejects(() => applyDnsTakeover(ctx, paths, { mode: 'dnsmasq' }), /dnsmasq 重启 失败/)
})

test('还原:uci commit 失败要抛错,备份文件必须还在（下次还能重来）,暂存的半截改动要 revert', async () => {
  const ctx = createMockContext({
    files: { '/opt/open-box/data/dnsmasq-backup.txt': "dhcp.cfg01411c.server='9.9.9.9'\ndhcp.cfg01411c.noresolv='1'\n" },
    execResults: { 'uci commit dhcp': { code: 1, stderr: 'uci: I/O error' } },
  })
  await assert.rejects(() => restoreDnsTakeover(ctx, paths), /uci commit dhcp 失败.*I\/O error/)
  assert.equal(await ctx.exists('/opt/open-box/data/dnsmasq-backup.txt'), true)
  const c = cmds(ctx)
  assert.ok(c.includes('uci -q revert dhcp'))
  assert.ok(!c.includes('/etc/init.d/dnsmasq restart'))
})

test('还原:dnsmasq 重启失败同样抛错并保留备份', async () => {
  const ctx = createMockContext({
    files: { '/opt/open-box/data/dnsmasq-backup.txt': "dhcp.cfg01411c.server='9.9.9.9'\n" },
    execResults: { '/etc/init.d/dnsmasq restart': { code: 1, stderr: 'failed' } },
  })
  await assert.rejects(() => restoreDnsTakeover(ctx, paths), /dnsmasq 重启 失败/)
  assert.equal(await ctx.exists('/opt/open-box/data/dnsmasq-backup.txt'), true)
})

test('还原:重建原上游的 add_list 失败也抛错、留备份;delete / del_list 返回非零不算失败（目标不存在是常态）', async () => {
  const ctx = createMockContext({
    files: { '/opt/open-box/data/dnsmasq-backup.txt': "dhcp.cfg01411c.server='9.9.9.9'\n" },
    execResults: {
      'uci -q delete dhcp.@dnsmasq[0].server': { code: 1 },
      'uci -q delete dhcp.@dnsmasq[0].noresolv': { code: 1 },
      'uci add_list dhcp.@dnsmasq[0].server=9.9.9.9': { code: 1, stderr: 'uci: Invalid argument' },
    },
  })
  await assert.rejects(() => restoreDnsTakeover(ctx, paths), /add_list server=9\.9\.9\.9 失败/)
  assert.equal(await ctx.exists('/opt/open-box/data/dnsmasq-backup.txt'), true)
  // 只有 delete 返回非零的话是正常的
  const ok = createMockContext({
    files: { '/opt/open-box/data/dnsmasq-backup.txt': "dhcp.cfg01411c.server='9.9.9.9'\n" },
    execResults: { 'uci -q delete dhcp.@dnsmasq[0].server': { code: 1 }, 'uci -q delete dhcp.@dnsmasq[0].noresolv': { code: 1 } },
  })
  assert.deepEqual(await restoreDnsTakeover(ok, paths), { restored: true })
  assert.equal(await ok.exists('/opt/open-box/data/dnsmasq-backup.txt'), false)
})

test('转发计划 none（全部直连）:接管过就还原到接管前的上游;状态文件写 plan=none;没接管过就一个字不动', async () => {
  // 接管过:备份在,uci 里是我们写的全量转发
  const uci = statefulUci({ servers: ['127.0.0.1#7853'], noresolv: '1', files: { '/opt/open-box/data/dnsmasq-backup.txt': "dhcp.cfg01411c.server='223.5.5.5' '192.168.3.5'\ndhcp.cfg01411c.noresolv='0'\n", '/opt/open-box/data/dnsmasq-takeover.txt': 'plan=all\nserver=127.0.0.1#7853\nnoresolv=1\n' } })
  const ctx = uci.ctx
  const r = await applyDnsTakeover(ctx, paths, { mode: 'dnsmasq', forward: { mode: 'none', domains: [], reason: '' } })
  assert.equal(r.changed, true)
  assert.deepEqual(r.actions, ['restore:none'])
  assert.deepEqual(uci.state, { servers: ['223.5.5.5', '192.168.3.5'], noresolv: '0' })
  const c = cmds(ctx)
  assert.ok(c.includes('uci add_list dhcp.@dnsmasq[0].server=223.5.5.5'))
  assert.ok(c.includes('uci add_list dhcp.@dnsmasq[0].server=192.168.3.5'))
  assert.ok(c.includes('uci set dhcp.@dnsmasq[0].noresolv=0'))
  assert.ok(c.includes('uci commit dhcp'))
  assert.equal(await ctx.exists('/opt/open-box/data/dnsmasq-backup.txt'), false)
  // 状态文件留着、写明 plan=none:init 脚本开机 / 面板 restart 时看到它就不再"没有条目 → 全量接管兜底"(复审 R1)
  assert.equal(ctx.files['/opt/open-box/data/dnsmasq-takeover.txt'], 'plan=none\n')
  assert.ok(!c.some((x) => x.includes('127.0.0.1#7853') && x.startsWith('uci add_list')))

  // 没接管过:uci 只读不写,只写 plan=none
  const ctx2 = createMockContext()
  const r2 = await applyDnsTakeover(ctx2, paths, { mode: 'dnsmasq', forward: { mode: 'none', domains: [] } })
  assert.equal(r2.changed, false)
  assert.deepEqual(writes(ctx2), [])
  assert.equal(ctx2.files['/opt/open-box/data/dnsmasq-takeover.txt'], 'plan=none\n')
})

test('转发计划 domains / all 和老的名单参数等价', async () => {
  const a = statefulUci({ servers: ['223.5.5.5'], noresolv: null }); await applyDnsTakeover(a.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['google.com'] } })
  assert.match(a.ctx.files[INSTALLED], /google\.com/)
  assert.deepEqual(a.state, { servers: ['223.5.5.5'], noresolv: null })
  const b = statefulUci({ servers: ['223.5.5.5'], noresolv: null }); await applyDnsTakeover(b.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [], reason: 'x' } })
  assert.deepEqual(b.state, { servers: ['127.0.0.1#7853'], noresolv: '1' })
})

// ---------- 复审 R4:all ↔ domains ↔ none 的完整状态机,原 DNS 基线全程保留 ----------
test('all → domains:原上游、定向域名上游和 noresolv=1 都从备份基线里恢复,再叠加我们的按域名条目', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9', '/corp.example/192.168.3.5'], noresolv: '1' })
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] } })
  assert.deepEqual(uci.state, { servers: ['127.0.0.1#7853'], noresolv: '1' })
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['youtube.com'] } })
  assert.deepEqual(uci.state, { servers: ['9.9.9.9', '/corp.example/192.168.3.5'], noresolv: '1' })
  assert.match(uci.ctx.files[INSTALLED], /youtube\.com/)
  assert.equal(uci.ctx.files['/opt/open-box/data/dnsmasq-takeover.txt'], `plan=domains\nforward=${INSTALLED}\nnoresolv=1\n`)
  // 再切回 none:完整还原到接管前
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'none', domains: [] } })
  assert.deepEqual(uci.state, { servers: ['9.9.9.9', '/corp.example/192.168.3.5'], noresolv: '1' })
  assert.equal(uci.ctx.files['/opt/open-box/data/dnsmasq-takeover.txt'], 'plan=none\n')
  assert.equal(await uci.ctx.exists(INSTALLED), false)
  // none 之后再 domains:基线是此刻的原配置(备份已消费,重新备份),照样对
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['youtube.com'] } })
  assert.deepEqual(uci.state, { servers: ['9.9.9.9', '/corp.example/192.168.3.5'], noresolv: '1' })
  assert.match(uci.ctx.files[INSTALLED], /youtube\.com/)
})

test('domains:用户原本 noresolv=0 / 没设,目标也不设;原本 noresolv=1 就保留——server 和 no-resolv 是两件事', async () => {
  const a = statefulUci({ servers: ['9.9.9.9'], noresolv: null })
  await applyDnsTakeover(a.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['g.com'] } })
  assert.deepEqual(a.state, { servers: ['9.9.9.9'], noresolv: null })
  const b = statefulUci({ servers: ['9.9.9.9'], noresolv: '1' })
  await applyDnsTakeover(b.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['g.com'] } })
  assert.deepEqual(b.state, { servers: ['9.9.9.9'], noresolv: '1' })
})

test('domains 期间用户自己加了一个上游:下一次部署把它算进基线、备份跟着刷新,none 还原时它还在', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9'], noresolv: null })
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['g.com'] } })
  uci.state.servers.push('192.168.3.5')   // 用户在 LuCI 里加了 AdGuard
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['g.com', 'y.com'] } })
  assert.deepEqual(uci.state.servers, ['9.9.9.9', '192.168.3.5'])
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'none', domains: [] } })
  assert.deepEqual(uci.state.servers, ['9.9.9.9', '192.168.3.5'])
})

test('老版本留下的现场:uci 已被全量接管却没有备份 → 基线不能把 127.0.0.1#7853 和它带来的 noresolv=1 当成用户的设置', async () => {
  // WAN 给的 DNS 在解析文件里(netifd 写的),去掉 noresolv=1 后 dnsmasq 就用它
  const uci = statefulUci({ servers: ['127.0.0.1#7853'], noresolv: '1', files: { '/tmp/resolv.conf.d/resolv.conf.auto': '# Interface wan\nnameserver 192.168.1.1\n' } })
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['g.com'] } })
  assert.deepEqual(uci.state, { servers: [], noresolv: null })
  assert.match(uci.ctx.files[INSTALLED], /g\.com/)
})

// #412:按域名转发时没进名单的域名交给路由器自己解析;它一个上游都没有(上游 DNS 没设、又忽略了解析文件)就全 LAN 没网,
// 用户手动加的 127.0.0.1#7853 又被当成我们的条目摘掉。这种按全量转发
test('按域名转发:路由器自己没有可用上游 → 改成全量转发给内核,返回值和状态文件记实际执行的 all 和原因(#412)', async () => {
  for (const setup of [
    { servers: [], noresolv: '1' },                               // 忽略解析文件、一个上游都没有
    { servers: ['127.0.0.1#7853'], noresolv: '1' },               // 用户手动加的内核地址(当成我们的条目)
    { servers: ['/lan/', '/example.com/10.0.0.1'], noresolv: '1' }, // 只有按域名的,没有全局的
    { servers: [], noresolv: null },                              // 没忽略解析文件,但解析文件不在
    { servers: [], noresolv: null, files: { '/tmp/resolv.conf.d/resolv.conf.auto': '# Interface wan\n' } }, // 解析文件里没有服务器
  ]) {
    const uci = statefulUci(setup)
    const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['google.com'] } })
    assert.equal(r.effective.mode, 'all', JSON.stringify(setup))
    assert.match(r.effective.reason, /没有可用的 DNS 上游/)
    assert.deepEqual(uci.state, { servers: ['127.0.0.1#7853'], noresolv: '1' }, JSON.stringify(setup))
    assert.match(uci.ctx.files[STATE], /^plan=all$/m)
  }
})

test('按域名转发:路由器自己有上游就照常只转名单——uci 里的全局上游、/#/ 写法、或解析文件里有服务器(含 uci 改过的解析文件路径)', async () => {
  for (const setup of [
    { servers: ['223.5.5.5'], noresolv: '1' },
    { servers: ['/#/192.168.3.5'], noresolv: '1' },
    { servers: [], noresolv: null, files: { '/tmp/resolv.conf.d/resolv.conf.auto': '# Interface wan\nnameserver 192.168.1.1\n' } },
    { servers: [], noresolv: null, options: { resolvfile: '/tmp/my-resolv.conf' }, files: { '/tmp/my-resolv.conf': 'nameserver 2400:3200::1\n' } },
  ]) {
    const uci = statefulUci(setup)
    const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['google.com'] } })
    assert.equal(r.effective.mode, 'domains', JSON.stringify(setup))
    assert.match(uci.ctx.files[INSTALLED], /^server=\/google\.com\/127\.0\.0\.1#7853$/m)
  }
})

// ---------- 第三轮 S2:用户基线的两条丢失路径 ----------
test('S2a:同一个 domains 计划重复应用（unchanged）时,用户新加的上游照样进备份,随后 none 不会把它丢掉', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9'], noresolv: null })
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['youtube.com'] } })
  uci.state.servers.push('192.168.3.5')
  const again = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['youtube.com'] } })
  assert.deepEqual(again.actions, ['unchanged'])
  assert.ok(uci.ctx.files[BACKUP].includes("'192.168.3.5'"), uci.ctx.files[BACKUP])
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'none', domains: [] } })
  assert.deepEqual(uci.state, { servers: ['9.9.9.9', '192.168.3.5'], noresolv: null })
})

test('S2b:all 期间用户新加上游再切 domains:基线 = 备份里的原上游 ∪ 新加的,noresolv 用备份的（all 设的 1 不是用户的）;none 还原完整', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9'], noresolv: null })
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] } })
  uci.state.servers.push('192.168.3.5')
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['youtube.com'] } })
  assert.deepEqual(uci.state, { servers: ['9.9.9.9', '192.168.3.5'], noresolv: null })
  assert.ok(uci.ctx.files[BACKUP].includes("'9.9.9.9' '192.168.3.5'"))
  assert.ok(!uci.ctx.files[BACKUP].includes("noresolv='1'"))
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'none', domains: [] } })
  assert.deepEqual(uci.state, { servers: ['9.9.9.9', '192.168.3.5'], noresolv: null })
})

test('S2:domains 期间用户删掉一个上游,再应用时基线跟着删（domains 下 uci 就是用户的）;all 期间看不见用户的列表,不推断删除', async () => {
  const d = statefulUci({ servers: ['9.9.9.9', '8.8.8.8'], noresolv: null })
  await applyDnsTakeover(d.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['a.com'] } })
  d.state.servers = d.state.servers.filter((v) => v !== '8.8.8.8')
  await applyDnsTakeover(d.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['a.com', 'b.com'] } })
  assert.ok(!d.ctx.files[BACKUP].includes('8.8.8.8'))
  await applyDnsTakeover(d.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'none', domains: [] } })
  assert.deepEqual(d.state.servers, ['9.9.9.9'])
  const a = statefulUci({ servers: ['9.9.9.9', '8.8.8.8'], noresolv: null })
  await applyDnsTakeover(a.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] } })
  await applyDnsTakeover(a.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] } })
  await applyDnsTakeover(a.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'none', domains: [] } })
  assert.deepEqual(a.state.servers, ['9.9.9.9', '8.8.8.8'])
})

// dnsmasq 查询日志(「域名解析查询」认终端用,system/dnsmasq-query-log.mjs):开着域名过滤时受管文件里带那两行
const LOG_LINES = `log-queries=extra\nlog-facility=${DNSMASQ_QUERY_LOG_PATH}\n`
// 重启 dnsmasq 那一刻日志文件在不在(面板部署时先建好普通文件,dnsmasq 启动那几行才留得住)
const watchRestart = (uci) => {
  const seen = []
  const exec = uci.ctx.exec
  uci.ctx.exec = async (cmd, args = []) => {
    if (cmd === '/etc/init.d/dnsmasq') seen.push(uci.ctx.files[DNSMASQ_QUERY_LOG_PATH])
    return exec(cmd, args)
  }
  return seen
}

test('查询日志:all 带上日志那两行、重启 dnsmasq 前先建好空的日志文件;关掉后拿掉那两行和日志文件', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9'] })
  const restarts = watchRestart(uci)
  const apply = (queryLog, rewriteSources = []) => applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] }, rewriteSources, queryLog })
  const on = await apply(true, ['*.example.test'])
  assert.deepEqual(on.queryLog, { active: true, reason: '' })
  assert.equal(uci.ctx.files[INSTALLED], `rebind-domain-ok=/example.test/\n${LOG_LINES}`)
  assert.equal(uci.ctx.files[FORWARD_SRC], uci.ctx.files[INSTALLED], '开机重放的正本也带')
  assert.deepEqual(restarts, [''], '重启时日志文件已经是个空的普通文件')
  // 面板在读(或者面板停着、指向 /dev/null):重复部署不动它、不重启 dnsmasq
  uci.ctx.files[DNSMASQ_QUERY_LOG_PATH] = 'reading'
  const again = await apply(true, ['*.example.test'])
  assert.equal(again.changed, false)
  assert.equal(uci.ctx.files[DNSMASQ_QUERY_LOG_PATH], 'reading')
  // 关掉:受管文件只剩重写例外,重启 dnsmasq 之后日志文件拿掉
  const off = await apply(false, ['*.example.test'])
  assert.equal(off.changed, true)
  assert.deepEqual(off.queryLog, { active: false, reason: '' })
  assert.equal(uci.ctx.files[INSTALLED], 'rebind-domain-ok=/example.test/\n')
  assert.equal(DNSMASQ_QUERY_LOG_PATH in uci.ctx.files, false)
  assert.equal(restarts.at(-1), 'reading', '先按不带日志的配置重启,再删文件')
  // 只剩日志那两行时关掉:受管文件整个拿掉
  await apply(true)
  assert.equal(uci.ctx.files[INSTALLED], LOG_LINES)
  await apply(false)
  assert.equal(INSTALLED in uci.ctx.files, false)
})

test('查询日志:domains 也带;用户自己在 uci 里开了查询日志或改了日志位置就不接管', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9'] })
  const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'domains', domains: ['example.test'] }, queryLog: true })
  assert.deepEqual(r.queryLog, { active: true, reason: '' })
  assert.ok(uci.ctx.files[INSTALLED].endsWith(LOG_LINES))
  assert.match(uci.ctx.files[INSTALLED], /^# Open-Box/)
  // 查询日志写进系统日志(没设 log-facility,或设的是 syslog 设施名):带 syslog,面板改读 logread 认终端(#322);写到文件的不带
  for (const [options, grep, syslog] of [
    [{ logqueries: '1' }, '', true],
    [{ logqueries: '1', logfacility: 'LOCAL0' }, '', true],
    [{ logfacility: '/tmp/dnsmasq.log' }, '', false],
    [{ logqueries: '1', logfacility: '/tmp/dnsmasq.log' }, '', false],
    [{}, '/var/etc/dnsmasq.conf.cfg01411c:log-queries\n', true],
    [{}, '/etc/dnsmasq.conf:log-queries=extra\n/etc/dnsmasq.conf:log-facility=-\n', false],
  ]) {
    const user = statefulUci({ servers: ['9.9.9.9'], options, grep })
    const got = await applyDnsTakeover(user.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] }, queryLog: true })
    assert.deepEqual(got.queryLog, { active: false, reason: 'user', ...(syslog ? { syslog: true } : {}) }, JSON.stringify([options, grep]))
    assert.ok(!(user.ctx.files[INSTALLED] || '').includes('log-queries'))
    assert.equal(DNSMASQ_QUERY_LOG_PATH in user.ctx.files, false)
  }
  // none:一个都不转发,不记
  const none = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'none', domains: [] }, queryLog: true })
  assert.deepEqual(none.queryLog, { active: false, reason: '' })
  // 不是 dnsmasq 模式
  assert.deepEqual((await applyDnsTakeover(uci.ctx, paths, { mode: 'hijack', queryLog: true })).queryLog, { active: false, reason: '' })
})

test('查询日志:还原接管时和受管文件一起拿掉', async () => {
  const uci = statefulUci({ servers: ['9.9.9.9'] })
  await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] }, queryLog: true })
  uci.ctx.files[DNSMASQ_QUERY_LOG_PATH] = 'reading'
  await restoreDnsTakeover(uci.ctx, paths)
  assert.equal(DNSMASQ_QUERY_LOG_PATH in uci.ctx.files, false)
  assert.equal(INSTALLED in uci.ctx.files, false)
  assert.deepEqual(uci.state.servers, ['9.9.9.9'])
})

// GitHub #286:dnsmasq-full 自带的 /etc/dnsmasq.conf 里有 log-facility=/dev/null,再加一行 log-facility,dnsmasq 2.93 拒绝启动
// (illegal repeated keyword),DNS 和 DHCP 一起停——v0.1.259~261 开着域名过滤的 dnsmasq 转发模式全断网
test('查询日志:dnsmasq 别处(固件的 /etc/dnsmasq.conf、生成的配置、conf-dir 里别的文件)已经设了日志就不加', async () => {
  for (const grep of ['/etc/dnsmasq.conf:log-facility=/dev/null\n', '/var/etc/dnsmasq.conf.cfg01411c:log-facility=/tmp/q.log\n', '/tmp/dnsmasq.cfg.d/custom.conf:log-facility=/var/log/dnsmasq.log\n']) {
    const uci = statefulUci({ servers: ['9.9.9.9'], grep })
    const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] }, queryLog: true })
    assert.deepEqual(r.queryLog, { active: false, reason: 'user' }, grep)
    assert.ok(!(uci.ctx.files[INSTALLED] || '').includes('log-'), grep)
  }
  // 只有自己那份受管文件里有(上一版加的):不算冲突
  const own = statefulUci({ servers: ['9.9.9.9'], grep: '/tmp/dnsmasq.cfg.d/open-box.conf:log-queries=extra\n' })
  assert.deepEqual((await applyDnsTakeover(own.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] }, queryLog: true })).queryLog, { active: true, reason: '' })
})

test('查询日志:上一版加上后 dnsmasq 起不来的现场,升级后第一次部署就把那两行拿掉', async () => {
  // 上一版装进去的受管文件带着那两行;这次发现 /etc/dnsmasq.conf 里有 log-facility
  const uci = statefulUci({ servers: ['127.0.0.1#7853'], noresolv: '1', grep: '/etc/dnsmasq.conf:log-facility=/dev/null\n', files: { [INSTALLED]: LOG_LINES, [FORWARD_SRC]: LOG_LINES, [STATE]: 'plan=all\nserver=127.0.0.1#7853\nnoresolv=1\n', [DNSMASQ_QUERY_LOG_PATH]: '' } })
  const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] }, queryLog: true })
  assert.equal(r.changed, true)
  assert.equal(INSTALLED in uci.ctx.files, false, '受管文件只剩那两行:整个拿掉')
  assert.ok(cmds(uci.ctx).includes('/etc/init.d/dnsmasq restart'))
  assert.equal(DNSMASQ_QUERY_LOG_PATH in uci.ctx.files, false)
})

test('查询日志:加上后 dnsmasq 没起来 → 撤掉那两行、再重启一次、记下失败;之后不再加', async () => {
  // 第一次重启后一直查不到 dnsmasq,撤掉之后又能查到
  let rolledBack = false
  const uci = statefulUci({ servers: ['9.9.9.9'], dnsmasqUp: () => rolledBack })
  const exec = uci.ctx.exec
  let restarts = 0
  uci.ctx.exec = async (cmd, args = []) => {
    if (cmd === '/etc/init.d/dnsmasq') { restarts++; if (restarts > 1) rolledBack = true }
    return exec(cmd, args)
  }
  const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] }, queryLog: true, rewriteSources: ['*.example.test'] })
  assert.deepEqual(r.queryLog, { active: false, reason: 'failed' })
  assert.equal(restarts, 2, '撤掉之后再重启一次')
  assert.equal(uci.ctx.files[INSTALLED], 'rebind-domain-ok=/example.test/\n', '只剩重写例外')
  assert.equal(uci.ctx.files[FORWARD_SRC], uci.ctx.files[INSTALLED], '开机重放的正本也撤掉')
  assert.equal(DNSMASQ_QUERY_LOG_PATH in uci.ctx.files, false)
  assert.ok(queryLogFailedPath(paths) in uci.ctx.files, '记下失败')
  // 之后的部署 / 热切换:不再加、不再重启
  const again = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] }, queryLog: true, rewriteSources: ['*.example.test'] })
  assert.deepEqual(again.queryLog, { active: false, reason: 'failed' })
  assert.equal(again.changed, false)
  assert.equal(restarts, 2)
})

test('查询日志:受管文件没变、但 dnsmasq 此刻根本没在跑(上一版加上就没起来)→ 同样撤掉', async () => {
  let fixed = false
  const uci = statefulUci({ servers: ['127.0.0.1#7853'], noresolv: '1', dnsmasqUp: () => fixed, files: { [INSTALLED]: LOG_LINES, [FORWARD_SRC]: LOG_LINES, [STATE]: 'plan=all\nserver=127.0.0.1#7853\nnoresolv=1\n' } })
  const exec = uci.ctx.exec
  uci.ctx.exec = async (cmd, args = []) => {
    if (cmd === '/etc/init.d/dnsmasq') fixed = true
    return exec(cmd, args)
  }
  const r = await applyDnsTakeover(uci.ctx, paths, { mode: 'dnsmasq', forward: { mode: 'all', domains: [] }, queryLog: true })
  assert.deepEqual(r.queryLog, { active: false, reason: 'failed' })
  assert.equal(INSTALLED in uci.ctx.files, false)
  assert.ok(cmds(uci.ctx).includes('/etc/init.d/dnsmasq restart'))
})
