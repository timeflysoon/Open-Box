import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createMockContext } from './context.mjs'
import { createRealContext } from './context-real.mjs'
import { createPaths } from './paths.mjs'
import { writeNodeDirectSets } from './node-direct-files.mjs'
import { NODE_DIRECT_DOMAIN_TAG, NODE_DIRECT_IP_TAG, nodeDirectRuleSets } from '../engine/direct-hosts.mjs'

const binary = path.resolve(import.meta.dirname, '../../.tools/sing-box')
const available = await fs.access(binary).then(() => true, () => false)
const freePort = async () => { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise((r) => s.close(r)); return port }

test('writeNodeDirectSets:两份 source 规则集,内容和上次一样就不写;没有地址时是空规则集', async () => {
  const paths = createPaths('/opt/open-box')
  const ctx = createMockContext()
  assert.deepEqual((await writeNodeDirectSets(ctx, paths, { domains: ['a.example.com'], cidrs: [] })).changed, [NODE_DIRECT_DOMAIN_TAG, NODE_DIRECT_IP_TAG])
  assert.deepEqual(JSON.parse(ctx.files[`${paths.rulesetDir}/obnode-direct.json`]), { version: 3, rules: [{ domain: ['a.example.com'] }] })
  assert.deepEqual(JSON.parse(ctx.files[`${paths.rulesetDir}/obnode-direct-ip.json`]), { version: 3, rules: [] })
  ctx.writes.length = 0
  assert.deepEqual((await writeNodeDirectSets(ctx, paths, { domains: ['a.example.com'], cidrs: [] })).changed, [])
  assert.equal(ctx.writes.length, 0)
  assert.deepEqual((await writeNodeDirectSets(ctx, paths, { domains: ['a.example.com'], cidrs: ['1.2.3.4/32'] })).changed, [NODE_DIRECT_IP_TAG])
})

// 用户 2026-09-30:更新订阅节点不应该重启内核。节点服务器地址变了只改写规则集文件,运行中的内核自己重新加载
test('订阅和节点站点直连(真内核):改写规则集文件后,运行中的内核马上按新地址走直连,不用重启', { skip: !available, timeout: 30000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openbox-node-direct-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const paths = { rulesetDir: dir }
  const ctx = createRealContext()
  await writeNodeDirectSets(ctx, paths, { domains: [], cidrs: [] })
  const echo = net.createServer((socket) => { socket.end('hello\n') })
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening')
  t.after(() => echo.close())
  const inPort = await freePort(), api = await freePort()
  const config = {
    log: { level: 'warn' },
    inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: inPort }],
    outbounds: [{ type: 'direct', tag: '直连' }, { type: 'block', tag: '拒绝' }],
    // 内核自己不解析 localhost:给个 hosts 解析器,域名那份拿 echo.test 试
    dns: { servers: [{ type: 'hosts', tag: 'h', predefined: { 'echo.test': ['127.0.0.1'] } }] },
    route: { rules: [{ rule_set: [NODE_DIRECT_DOMAIN_TAG, NODE_DIRECT_IP_TAG], outbound: '直连' }], rule_set: nodeDirectRuleSets(dir), final: '拒绝', default_domain_resolver: 'h' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${api}` } },
  }
  const file = path.join(dir, 'config.json')
  await fs.writeFile(file, JSON.stringify(config))
  const core = spawn(binary, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; core.stderr.on('data', (d) => { output += d })
  t.after(async () => { if (core.exitCode === null) { core.kill(); await once(core, 'exit') } })
  for (let i = 0; i < 60; i++) {
    if (core.exitCode !== null) throw new Error(output)
    try { await fetch(`http://127.0.0.1:${api}/version`); break } catch { await new Promise((r) => setTimeout(r, 50)) }
  }
  // 经 mixed 入站(HTTP CONNECT)连目标,读到问候语才算通
  const connect = (target) => new Promise((resolve) => {
    const socket = net.connect(inPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    let data = ''
    socket.setTimeout(3000, () => { socket.destroy(); resolve(false) })
    socket.on('data', (d) => { data += d; if (data.includes('hello')) { socket.destroy(); resolve(true) } })
    socket.on('error', () => resolve(false))
    socket.on('close', () => resolve(data.includes('hello')))
  })
  const byIp = `127.0.0.1:${echo.address().port}`
  const byName = `echo.test:${echo.address().port}`
  assert.equal(await connect(byIp), false, '地址不在名单里:落到兜底拒绝')
  assert.equal(await connect(byName), false)
  await writeNodeDirectSets(ctx, paths, { domains: ['echo.test'], cidrs: ['127.0.0.1/32'] })
  let ok = false
  for (let i = 0; i < 40 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 100))
    ok = await connect(byIp)
  }
  assert.ok(ok, `按 IP 的那份应被运行中的内核加载:${output}`)
  assert.equal(await connect(byName), true, '按域名的那份同样生效')
  assert.equal(core.exitCode, null, '内核一直在跑')
})
