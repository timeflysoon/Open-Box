import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig, buildConfigDetailed } from './config.mjs'
import { parseSubscription } from './subscription.mjs'
import { renameNodes } from './rename.mjs'
import { groupNodesByRegion } from './groups.mjs'
import { buildRoute } from './routing.mjs'
import { builtinTags } from './user-groups.mjs'
import { FLIP_PLACEHOLDER_SRS_BASE64, flipFlagContent, isFlipBypassTag, isFlipNeedTag, isFlipTag } from './flip.mjs'
import { isNodeDirectTag, nodeDirectSources } from './direct-hosts.mjs'

const enginedir = path.dirname(fileURLToPath(import.meta.url))
const sbBin = path.resolve(enginedir, '../../.tools/sing-box')
const hasBin = fs.existsSync(sbBin)
// 本机没放二进制就跳过(开发机常态);设了 CI 就不许跳——全跳过还是绿的,拦不住配置和内核版本不兼容的发布。
// 发版是在本机打包(scripts/build-release.sh,发布前验收见 scripts/release-verify/README.md),panel/.tools/sing-box
// 放和发布包同一套补丁的内核。以前的 GitHub Actions 工作流(.github/workflows/release.yml)从来没在 GitHub 上跑过,已删
const inCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
const missingBin = `sing-box 二进制缺失（panel/.tools/sing-box）;运行 pnpm run check:config 前先放置二进制`
const skipIfNoBin = hasBin || inCI ? false : missingBin
const requireBin = () => { if (!hasBin) assert.fail(`${missingBin}——CI 上不允许跳过这项校验`) }

const compileSrs = (dir, tag) => {
  const src = path.join(dir, `${tag}.json`)
  const out = path.join(dir, `${tag}.srs`)
  fs.writeFileSync(src, JSON.stringify({ version: 1, rules: [{ domain: [`${tag}.example.com`] }] }))
  execFileSync(sbBin, ['rule-set', 'compile', '--output', out, src])
}

// 热切换的开关 / 旁路动态集(engine/flip.mjs):内核 check 时每个本地规则集文件都必须在。生成器默认把它们放在
// 规则集目录的同级 flip/ 下——测试里规则集目录是临时目录,同级就是系统临时目录,所以这里把路径改进临时目录再造文件:
// 开关一个 ON 一个 OFF 交替写(两种内容都让内核认一遍),旁路动态集和入口「进内核」名单(obflip-need-*,开着
// auto_redirect 时才有)放内嵌的占位 .srs——以前 need 集合被当成开关写成 JSON,内核读 .srs 直接 FATAL
// 订阅和节点站点直连的两份规则集(engine/direct-hosts.mjs,source 格式):同样得在。域名那份写上地址、IP 那份留空(两种都让内核认一遍)
const writeNodeDirect = (entry) => {
  const sources = nodeDirectSources({ domains: ['node.example.com'], cidrs: [] })
  fs.mkdirSync(path.dirname(entry.path), { recursive: true })
  fs.writeFileSync(entry.path, JSON.stringify(sources[entry.tag]))
}
const prepareFlip = (config, dir) => {
  let on = true
  for (const entry of (config.route && config.route.rule_set) || []) {
    if (isNodeDirectTag(entry.tag)) {
      writeNodeDirect(entry)
      continue
    }
    if (!isFlipTag(entry.tag)) continue
    entry.path = path.join(dir, 'flip', path.basename(entry.path))
    fs.mkdirSync(path.dirname(entry.path), { recursive: true })
    if (isFlipBypassTag(entry.tag) || isFlipNeedTag(entry.tag)) fs.writeFileSync(entry.path, Buffer.from(FLIP_PLACEHOLDER_SRS_BASE64, 'base64'))
    else { fs.writeFileSync(entry.path, flipFlagContent(on)); on = !on }
  }
}

test('生成的配置通过 sing-box check（全协议 + wireguard + DNS 分流 + 上游 TCP）', { skip: skipIfNoBin }, () => {
  requireBin()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-check-'))
  try {
    // 组织多协议订阅样本(分享链接)
    const sub = [
      'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@us.example.com:8388#US-01',
      'trojan://pw@jp.example.com:443?sni=jp.example.com#JP-01',
      'hysteria2://pw@hk.example.com:8443?sni=hk.example.com#HK-01',
      'anytls://pw@sg.example.com:23130/?insecure=1&sni=buylite.music.apple.com#SG-01',
      // 传输层按类型只留合法字段:grpc 的 serviceName 在 path 里、h2 带 host、ws 带 ?ed=
      'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'GRPC-01', add: 'g.example.com', port: '443', id: '11111111-1111-1111-1111-111111111111', aid: '0', net: 'grpc', path: '/mysvc', tls: 'tls', sni: 'g.example.com' })).toString('base64'),
      'vless://11111111-1111-1111-1111-111111111111@h.example.com:443?type=h2&path=%2Fh2&host=cdn.example.com&security=tls&sni=h.example.com#H2-01',
      'vless://11111111-1111-1111-1111-111111111111@w.example.com:443?type=ws&path=%2Fws%3Fed%3D2048&host=cdn.example.com&security=tls&sni=w.example.com#WS-ED-01',
    ].join('\n')
    const { nodes } = parseSubscription(sub)
    const renamed = renameNodes(nodes)
    const { groups } = groupNodesByRegion(renamed)
    const profile = {
      ipv6: true,
      // 两侧都选 TCP:内核得认 type=tcp 的 server 对象
      dns: { split: true, direct: '223.5.5.5', directProtocol: 'tcp', proxy: '1.1.1.1', proxyProtocol: 'tcp' },
      routing: { proxyTag: 'PROXY', categories: [{ ruleset: 'geosite-geolocation-!cn', target: groups[0]?.name || 'PROXY' }], directRulesets: ['geosite-cn', 'geoip-cn'], adBlock: true, adRuleset: 'geosite-category-ads-all', fallback: 'PROXY' },
      rulesetDir: dir,
      clashApiSecret: 'testsecret',
    }
    const config = buildConfig({ nodes: renamed, regionGroups: groups, profile, rulesetDir: dir })
    assert.deepEqual(config.dns.servers.find((x) => x.tag === 'dns-direct'), { type: 'tcp', tag: 'dns-direct', server: '223.5.5.5' })
    assert.equal(config.dns.servers.find((x) => x.tag === 'dns-proxy').type, 'tcp')
    // 为每个被引用的 rule_set tag 造 .srs fixture
    const { rulesetTags } = buildRoute(profile.routing, dir)
    for (const tag of rulesetTags) compileSrs(dir, tag)
    const cfgPath = path.join(dir, 'config.json')
    prepareFlip(config, dir)
    fs.writeFileSync(cfgPath, JSON.stringify(config))
    // 应通过
    execFileSync(sbBin, ['check', '-c', cfgPath])   // 非 0 会抛错 → 测试失败
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('热切换模式(档案关了「直连和代理切换重启内核」)生成的配置通过 sing-box check:成对的 logical 规则、开关规则集、旁路动态集', { skip: skipIfNoBin }, async () => {
  requireBin()
  const { flipFlagContent, flipPlaceholderSource, isFlipBypassTag, isFlipTag } = await import('./flip.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-check-flip-'))
  const flipDir = path.join(dir, 'flip')
  fs.mkdirSync(flipDir)
  try {
    const { nodes } = parseSubscription('ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@hk.example.com:8388#HK-01')
    const renamed = renameNodes(nodes)
    const userGroups = [{ id: 'g', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }]
    const profile = {
      ipv6: true, ipv6Proxy: 'ipv4', rejectQuic: true,
      dns: { split: true, mode: 'hijack', direct: '223.5.5.5', proxy: '1.1.1.1', proxyProtocol: 'tcp' },
      // 本机(macOS)的内核二进制不认 auto_redirect(Linux 才有),这里关着:校验的是成对规则和开关规则集。
      // 带 nft 重定向的旁路动态集在 Linux 容器端到端和开发路由器上校验
      tun: { autoRedirect: false },
      clientRoutes: [{ id: 'c1', enabled: true, sources: ['192.168.1.10'], outbound: '国内' }],
      routing: { fallbackDefault: 'direct', custom: { rules: [{ type: 'ipCidr', value: '10.8.0.0/16', outbound: '香港-自动' }, { type: 'geoip', value: 'telegram', outbound: 'block' }] }, policies: [
        { id: 'g', name: 'Google', default: '香港-自动', rulesets: ['geosite-google', 'geoip-google'], domainSuffix: ['gstatic.com'] },
        { id: 'cn', name: '国内', default: 'direct', rulesets: ['geoip-cn', 'geosite-cn'] },
        { id: 'ip', name: '纯IP', default: 'direct', ipCidr: ['203.0.113.0/24'] },
      ] },
      clashApiSecret: 'testsecret',
    }
    const config = buildConfig({ nodes: renamed, userGroups, profile, rulesetDir: dir, flipDir, localSubnets: ['192.168.1.0/24'] })
    assert.ok(config.dns.rules.some((r) => r.type === 'logical'), '确实生成了成对规则')
    assert.ok(config.route.rules.some((r) => r.type === 'logical'))
    // 站点集按 IP 判的那一份带「连接没有域名」的前提(取反的 domain_regex),连同挂开关的 v6 / QUIC 拒绝,都要让真内核认一遍
    const guarded = config.route.rules.filter((r) => r.type === 'logical' && r.rules.some((x) => x.invert === true && Array.isArray(x.domain_regex)))
    assert.ok(guarded.some((r) => r.outbound === 'Google') && guarded.some((r) => r.outbound === '纯IP'), '确实生成了带前提的 IP 规则')
    assert.ok(guarded.some((r) => r.outbound === '香港-自动'), '前置自定义分流的 IP 行也带前提')
    assert.ok(guarded.some((r) => r.action === 'reject'), '带前提的拒绝规则也在')
    // 造文件:普通规则集编个占位 .srs;开关写 source JSON(一个 ON 一个 OFF 都试);旁路动态集编占位
    fs.writeFileSync(path.join(dir, 'ph.json'), flipPlaceholderSource())
    execFileSync(sbBin, ['rule-set', 'compile', '--output', path.join(dir, 'ph.srs'), path.join(dir, 'ph.json')])
    let on = true
    for (const entry of config.route.rule_set) {
      if (isFlipBypassTag(entry.tag)) fs.copyFileSync(path.join(dir, 'ph.srs'), entry.path)
      else if (isFlipTag(entry.tag)) { fs.writeFileSync(entry.path, flipFlagContent(on)); on = !on }
      else if (isNodeDirectTag(entry.tag)) writeNodeDirect(entry)
      else compileSrs(dir, entry.tag)
    }
    const cfgPath = path.join(dir, 'config.json')
    prepareFlip(config, dir)
    fs.writeFileSync(cfgPath, JSON.stringify(config))
    execFileSync(sbBin, ['check', '-c', cfgPath])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('热切换旁路的占位 .srs:内嵌在代码里的字节,和真内核现编出来的一模一样', { skip: skipIfNoBin }, async () => {
  requireBin()
  const { FLIP_PLACEHOLDER_SRS_BASE64, FLIP_BYPASS_PLACEHOLDER, flipPlaceholderSource } = await import('./flip.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-check-ph-'))
  try {
    fs.writeFileSync(path.join(dir, 'ph.json'), flipPlaceholderSource())
    execFileSync(sbBin, ['rule-set', 'compile', '--output', path.join(dir, 'ph.srs'), path.join(dir, 'ph.json')])
    assert.equal(fs.readFileSync(path.join(dir, 'ph.srs')).toString('base64'), FLIP_PLACEHOLDER_SRS_BASE64)
    // 反过来:内嵌的字节内核解得开,解出来就是那两个占位地址
    fs.writeFileSync(path.join(dir, 'embedded.srs'), Buffer.from(FLIP_PLACEHOLDER_SRS_BASE64, 'base64'))
    execFileSync(sbBin, ['rule-set', 'decompile', '--output', path.join(dir, 'back.json'), path.join(dir, 'embedded.srs')])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'back.json'), 'utf8')).rules, [{ ip_cidr: FLIP_BYPASS_PLACEHOLDER }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('坏节点（缺 method）导致 check 失败', { skip: skipIfNoBin }, () => {
  requireBin()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-checkbad-'))
  try {
    const config = {
      log: { level: 'warn' },
      inbounds: [{ type: 'tun', tag: 't', address: ['172.19.0.1/30'], auto_route: true, stack: 'mixed' }],
      outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'shadowsocks', tag: 'bad', server: 'a.com', server_port: 8388 }],
    }
    const cfgPath = path.join(dir, 'bad.json')
    prepareFlip(config, dir)
    fs.writeFileSync(cfgPath, JSON.stringify(config))
    assert.throws(() => execFileSync(sbBin, ['check', '-c', cfgPath], { stdio: 'pipe' }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('生成的配置通过 sing-box check（sing-box JSON 订阅 → wireguard endpoint）', { skip: skipIfNoBin }, () => {
  requireBin()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-checkwg-'))
  try {
    // sing-box JSON 格式订阅:一个常规 outbound(shadowsocks)+ 一个 wireguard endpoint。
    // 私钥/对端公钥用 `panel/.tools/sing-box generate wg-keypair` 生成的标准 base64 32 字节密钥,
    // 确保 check 校验的是真实的 key 格式合法性,而不是随手写的占位符。
    const subJson = JSON.stringify({
      outbounds: [
        { type: 'shadowsocks', tag: 'US-SS', server: 'us.example.com', server_port: 8388, method: 'aes-256-gcm', password: 'secretpw' },
      ],
      endpoints: [
        {
          type: 'wireguard',
          tag: 'US-WG',
          address: ['10.0.0.2/32'],
          private_key: 'oIYbSZXnRnvpKgBZ20Fz6tZLetm9UqEiF0wNOgafXkk=',
          peers: [
            { address: 'wg.example.com', port: 51820, public_key: 'vhdYcThImW2+FL5SvTHUcSyX83lRk7mcyKoqAotE8C8=' },
          ],
        },
      ],
    })
    const { nodes, format } = parseSubscription(subJson)
    assert.equal(format, 'singbox')
    const renamed = renameNodes(nodes)
    const { groups } = groupNodesByRegion(renamed)
    const profile = {
      ipv6: true,
      dns: { split: true, direct: '223.5.5.5', proxy: '1.1.1.1' },
      routing: { proxyTag: 'PROXY', categories: [{ ruleset: 'geosite-geolocation-!cn', target: groups[0]?.name || 'PROXY' }], directRulesets: ['geosite-cn', 'geoip-cn'], adBlock: false, fallback: 'PROXY' },
      rulesetDir: dir,
      clashApiSecret: 'testsecret',
    }
    const config = buildConfig({ nodes: renamed, regionGroups: groups, profile, rulesetDir: dir })
    // 证明 wireguard 路径真的被走通了,而不是被静默丢弃
    assert.ok(Array.isArray(config.endpoints) && config.endpoints.length === 1)
    assert.equal(config.endpoints[0].type, 'wireguard')
    // 为每个被引用的 rule_set tag 造 .srs fixture
    const { rulesetTags } = buildRoute(profile.routing, dir)
    for (const tag of rulesetTags) compileSrs(dir, tag)
    const cfgPath = path.join(dir, 'config.json')
    prepareFlip(config, dir)
    fs.writeFileSync(cfgPath, JSON.stringify(config))
    // 应通过(非 0 会抛错 → 测试失败,不做 try/catch 吞掉)
    execFileSync(sbBin, ['check', '-c', cfgPath])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('生成的配置通过 sing-box check（dns.mode=dnsmasq;仅 dns-in 入站被劫持,防 hijack 回环回归）', { skip: skipIfNoBin }, () => {
  requireBin()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-checkdnsmasq-'))
  try {
    const sub = [
      'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@us.example.com:8388#US-01',
      'trojan://pw@jp.example.com:443?sni=jp.example.com#JP-01',
      'hysteria2://pw@hk.example.com:8443?sni=hk.example.com#HK-01',
      'anytls://pw@sg.example.com:23130/?insecure=1&sni=buylite.music.apple.com#SG-01',
    ].join('\n')
    const { nodes } = parseSubscription(sub)
    const renamed = renameNodes(nodes)
    const { groups } = groupNodesByRegion(renamed)
    const profile = {
      ipv6: true,
      dns: { split: true, mode: 'dnsmasq', direct: '223.5.5.5', proxy: '1.1.1.1' },
      routing: { proxyTag: 'PROXY', categories: [{ ruleset: 'geosite-geolocation-!cn', target: groups[0]?.name || 'PROXY' }], directRulesets: ['geosite-cn', 'geoip-cn'], adBlock: true, adRuleset: 'geosite-category-ads-all', fallback: 'PROXY' },
      rulesetDir: dir,
      clashApiSecret: 'testsecret',
    }
    const config = buildConfig({ nodes: renamed, regionGroups: groups, profile, rulesetDir: dir })
    // 结构性不变量断言:即便 sing-box check 通过,也要能单独捕捉 Critical 修复的回归。
    // 1) 存在仅限 dns-in 入站的 hijack-dns 规则
    const hijack = config.route.rules.find((r) => r.action === 'hijack-dns')
    assert.ok(hijack, '应存在 hijack-dns 规则')
    assert.ok(Array.isArray(hijack.inbound) && hijack.inbound.includes('dns-in'), 'hijack-dns 规则应限定 inbound: [dns-in]')
    // 2) 不存在全局 protocol:'dns' 劫持规则(这正是导致 tun→dns-in 转发查询自环的根因)
    assert.ok(!config.route.rules.some((r) => r.protocol === 'dns'), '不应存在 protocol:dns 的全局劫持规则（回环回归）')
    // 3) 存在监听 127.0.0.1:7853 的 direct 入站,供 dnsmasq 上游转发查询
    const dnsIn = config.inbounds.find((i) => i.type === 'direct' && i.tag === 'dns-in')
    assert.ok(dnsIn, '应存在 tag=dns-in 的 direct 入站')
    assert.ok(['0.0.0.0', '::'].includes(dnsIn.listen))
    assert.equal(dnsIn.listen_port, 7853)
    // 为每个被引用的 rule_set tag 造 .srs fixture
    const { rulesetTags } = buildRoute(profile.routing, dir)
    for (const tag of rulesetTags) compileSrs(dir, tag)
    const cfgPath = path.join(dir, 'config.json')
    prepareFlip(config, dir)
    fs.writeFileSync(cfgPath, JSON.stringify(config))
    // 应通过(非 0 会抛错 → 测试失败,不做 try/catch 吞掉)
    execFileSync(sbBin, ['check', '-c', cfgPath])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('节点服务器 / 终端分流「直连」「不进内核」的配置通过 sing-box check:首包预判的 bypass(取反的规则集 / 网段 / 端口)、按终端答的直连解析器、本地主机名交回 dnsmasq', { skip: skipIfNoBin }, () => {
  requireBin()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-checkterminal-'))
  try {
    const sub = 'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@us.example.com:8388#US-01'
    const renamed = renameNodes(parseSubscription(sub).nodes)
    const { groups } = groupNodesByRegion(renamed)
    const proxy = groups[0].name
    const profile = {
      ipv6: false,
      tun: { autoRedirect: true },
      dns: { split: true, mode: 'dnsmasq', direct: '223.5.5.5', proxy: '1.1.1.1', fakeIpForProxy: true },
      routing: {
        proxyTag: 'PROXY',
        policies: [{ id: 'g', name: '谷歌', default: proxy, rulesets: ['geosite-google', 'geoip-google'] }],
        custom: { rules: [
          { type: 'ipCidr', value: '10.77.0.0/16', outbound: proxy },
          { type: 'geoip', value: 'telegram', outbound: proxy },
          { type: 'port', value: '51820', outbound: proxy },
          { type: 'domainSuffix', value: 'x.test', outbound: proxy },
        ] },
        fallbackDefault: 'direct',
      },
      // 界面里「直连」存的是内置直连出站的真实名字(和选择器里的一样)
      clientRoutes: [
        { id: 'a', sources: ['192.168.3.18'], outbound: builtinTags([]).direct },
        { id: 'b', match: 'mac', macs: ['00:15:5d:03:0a:12'], outbound: builtinTags([]).direct },
        { id: 'c', match: 'mac', macs: ['aa:bb:cc:00:11:22'], bypass: true },
        // 「只让这些终端进内核」按 IP:名单外终端的查询转到直连 DNS 入站
        { id: 'd', match: 'ip', sources: ['10.99.0.8'], admit: true },
      ],
      rulesetDir: dir,
      clashApiSecret: 'testsecret',
    }
    // directHostCidrs:部署时节点域名解析出的地址,「订阅和节点站点直连」的首包预判也要过 check。配置里引用 IP 那份规则集
    // (地址变了只换文件,engine/direct-hosts.mjs),地址在交给部署写文件的 directHosts 里
    const { config, directHosts } = buildConfigDetailed({ nodes: renamed, regionGroups: groups, profile, rulesetDir: dir, directHostCidrs: ['203.0.113.7/32'] })
    assert.ok(directHosts.cidrs.includes('203.0.113.7/32'))
    const [nodesRule, ipRule, macRule, sniff] = config.route.rules
    assert.equal(nodesRule.action, 'bypass')
    assert.deepEqual(nodesRule.rules[0], { rule_set: ['obnode-direct-ip'] })
    assert.equal(ipRule.action, 'bypass')
    assert.equal(ipRule.outbound, undefined, '不带出口:只在首包预判里生效')
    assert.deepEqual(ipRule.rules[0], { source_ip_cidr: ['192.168.3.18/32'] })
    assert.deepEqual(macRule.rules[0], { source_mac_address: ['00:15:5d:03:0a:12'] })
    assert.deepEqual(sniff, { action: 'sniff' })
    assert.ok(config.dns.servers.some((x) => x.tag === 'dns-terminal-direct'))
    assert.ok(config.inbounds.some((i) => i.tag === 'dns-in-direct' && i.listen_port === 7855))
    assert.ok(config.dns.rules.some((r) => r.inbound && r.inbound[0] === 'dns-in-direct' && r.server === 'dns-terminal-direct'))
    assert.ok(config.dns.servers.some((x) => x.tag === 'dns-local'))
    const { rulesetTags } = buildRoute(profile.routing, dir)
    for (const tag of rulesetTags) compileSrs(dir, tag)
    const cfgPath = path.join(dir, 'config.json')
    prepareFlip(config, dir)
    // 规则是按开着 auto_redirect 生成的;auto_redirect 只有 Linux 能初始化(mac 版内核 check 时报 invalid argument),
    // 写给 check 的这份去掉它——要校验的是路由 / DNS 规则本身
    const tun = config.inbounds.find((i) => i.type === 'tun')
    if (process.platform !== 'linux' && tun) delete tun.auto_redirect
    fs.writeFileSync(cfgPath, JSON.stringify(config))
    execFileSync(sbBin, ['check', '-c', cfgPath])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('一个节点都没命中的用户组也能过 sing-box check（挂 direct 占位）', { skip: skipIfNoBin }, () => {
  requireBin()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-check-empty-'))
  try {
    const { nodes } = parseSubscription('trojan://pw@hk.example.com:443?sni=hk.example.com#HK-01')
    const renamed = renameNodes(nodes)
    const { groups } = groupNodesByRegion(renamed)
    compileSrs(dir, 'geosite-cn')
    compileSrs(dir, 'geoip-cn')
    const config = buildConfig({
      rulesetDir: dir,
      nodes: renamed,
      regionGroups: groups,
      profile: {
        ipv6: false,
        dns: { split: true, direct: '223.5.5.5', proxy: '1.1.1.1' },
        // 策略指向那个空组:这正是"组不能被丢掉"的理由——丢了它,策略的 default 就悬空
        routing: {
          proxyTag: 'PROXY',
          regionId: 'hkmo',
          policies: [{ id: 'ie', name: '爱尔兰站点', rulesets: ['geosite-cn'], default: '爱尔兰-自动' }],
        },
        rulesetDir: dir,
      },
      userGroups: [
        // 一个爱尔兰节点都没有,组照样要在
        { id: 'ie', name: '爱尔兰-自动', type: 'urltest', mode: 'dynamic', keywords: ['ie', '爱尔兰'], icon: 'IE' },
      ],
    })

    const ie = config.outbounds.find((o) => o.tag === '爱尔兰-自动')
    assert.ok(ie, '空组必须仍然出现在配置里')
    assert.deepEqual(ie.outbounds, ['直连'], '空组挂直连占位（内置直连默认叫「直连」）')
    const sel = config.outbounds.find((o) => o.tag === '爱尔兰站点')
    assert.equal(sel.default, '爱尔兰-自动', '策略的默认选中项就是那个空组')
    const rule = config.route.rules.find((r) => r.outbound === '爱尔兰站点')
    assert.ok(rule, '策略规则要在')

    const file = path.join(dir, 'config.json')
    prepareFlip(config, dir)
    fs.writeFileSync(file, JSON.stringify(config, null, 2))
    execFileSync(sbBin, ['check', '-c', file], { stdio: 'pipe' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 两种兜底各生成一份完整配置,交给真内核 check。这一组是整个改造的兜底:
// 规则顺序、站点集 selector、兜底 selector、block 出站、DNS 的 local/detour 写法,
// 任何一处写错 sing-box 都会在这里报出来,而不是等部署到路由器上才 FATAL。
for (const fallbackDefault of ['direct', 'proxy']) {
  test(`兜底=${fallbackDefault}:整份配置过 sing-box check`, { skip: skipIfNoBin }, () => {
  requireBin()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openbox-check-${fallbackDefault}-`))
    try {
      const { nodes } = parseSubscription(
        [
          'trojan://pw@hk.example.com:443?sni=hk.example.com#HK-01',
          'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@us.example.com:8388#US-01',
          // 认不出国别的节点会被分到「其他」那一桶——真机上就是它和兜底站点集「其他」
          // 撞了同一个出站 tag,内核 FATAL: duplicate outbound/endpoint tag
          'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@mystery.example.com:8388#Node-X',
        ].join('\n'),
      )
      const renamed = renameNodes(nodes)
      const { groups } = groupNodesByRegion(renamed)
      assert.ok(groups.some((g) => g.name === '其他地区'), '认不出国别的节点该落到「其他地区」组')
      const profile = {
        ipv6: false,
        // 直连 DNS 是上游 DNS:直连侧用读到的系统上游
        dns: { split: true, mode: 'dnsmasq', direct: 'wan', proxy: '1.1.1.1' },
        routing: {
          proxyTag: 'PROXY',
          fallbackDefault,
          adBlock: true,
          policies: [
            {
              id: 'g', name: '谷歌', default: 'direct',
              rulesets: ['geosite-google'],
              domain: ['example.com'],
              domainSuffix: ['google.com'],
              domainKeyword: ['gstatic'],
              ipCidr: ['8.8.8.8/32'],
            },
            { id: 'block-ad', name: '广告拦截', default: 'block', domainSuffix: ['ads.example.com'] },
            {
              id: 'cn', name: '中国', default: 'direct',
              // 上游有 348 个名字带 @/!,文件名和路径都得原样过内核
              rulesets: ['geosite-cn', 'geosite-36kr@ads', 'geosite-geolocation-!cn'],
              domainSuffix: ['nhk.or.jp'],
              ipCidr: ['133.0.0.0/8'],
            },
          ],
        },
        rulesetDir: dir,
      }
      const config = buildConfig({
        rulesetDir: dir,
        nodes: renamed,
        regionGroups: groups,
        userGroups: [{ id: 'all', name: '所有-自动', type: 'urltest', mode: 'dynamic', keywords: [] }],
        profile,
        systemDns: ['192.168.1.1'],
      })
      for (const entry of config.route.rule_set) compileSrs(dir, entry.tag)

      // 兜底永远是那个同名 selector;"其余流量走哪"是它的 default,不是 final
      assert.equal(config.route.final, '其他')
      const fb = config.outbounds.find((o) => o.tag === '其他')
      assert.equal(fb.default, fallbackDefault === 'direct' ? '直连' : '所有-自动')
      const sel = config.outbounds.find((o) => o.tag === '谷歌')
      // 顺序:直连 → 地区组(按节点顺序)→ 用户组 → 拒绝
      // 成员只剩用户自己建的节点组:按国家自动分的组和 PROXY 聚合已退役
      assert.deepEqual(sel.outbounds, ['直连', '所有-自动', '拒绝'])
      assert.ok(config.outbounds.some((o) => o.type === 'block'), '有策略选了拒绝,block 出站必须在')
      // dnsmasq 模式下直连侧不能是 local(会绕回 dnsmasq),上游 DNS 要用读到的系统上游
      // 不带 detour:显式 detour:'direct' 会在启动时被内核拒绝(check 查不出来,真机死循环过)
      assert.deepEqual(config.dns.servers[0], { type: 'udp', tag: 'dns-direct', server: '192.168.1.1' })

      const file = path.join(dir, 'config.json')
      prepareFlip(config, dir)
      fs.writeFileSync(file, JSON.stringify(config, null, 2))
      execFileSync(sbBin, ['check', '-c', file], { stdio: 'pipe' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

// hijack / off 两种 DNS 劫持方式也要过 sing-box check:直连侧用 WAN 上游 + (hijack)本地主机名交 local;
// (off)不劫持、不写 auto_redirect
for (const mode of ['hijack', 'off']) {
  test(`生成的配置通过 sing-box check（dns.mode=${mode}）`, { skip: skipIfNoBin }, () => {
  requireBin()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openbox-check-${mode}-`))
    try {
      const sub = [
        'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@us.example.com:8388#US-01',
        'trojan://pw@jp.example.com:443?sni=jp.example.com#JP-01',
      ].join('\n')
      const { nodes } = parseSubscription(sub)
      const renamed = renameNodes(nodes)
      const { groups } = groupNodesByRegion(renamed)
      const profile = {
        ipv6: false,
        tun: { autoRedirect: true },
        dns: { split: true, mode, direct: '223.5.5.5', proxy: '1.1.1.1' },
        routing: { proxyTag: 'PROXY', categories: [{ ruleset: 'geosite-geolocation-!cn', target: groups[0]?.name || 'PROXY' }], directRulesets: ['geosite-cn', 'geoip-cn'], adBlock: true, adRuleset: 'geosite-category-ads-all', fallback: 'PROXY' },
        rulesetDir: dir,
        clashApiSecret: 'testsecret',
      }
      const config = buildConfig({ nodes: renamed, regionGroups: groups, profile, rulesetDir: dir, systemDns: ['211.139.29.150', '2409:806c:2000::1'] })
      // 直连 DNS 填了 IP 就用它,不看系统的上游 DNS
      assert.deepEqual(config.dns.servers[0], { type: 'udp', tag: 'dns-direct', server: '223.5.5.5' })
      if (mode === 'hijack') {
        assert.ok(config.route.rules.some((r) => r.protocol === 'dns' && r.action === 'hijack-dns'))
        assert.ok(config.dns.servers.some((s) => s.tag === 'dns-local' && s.type === 'local'))
        assert.equal(config.dns.rules[0].server, 'dns-local')
        assert.equal(config.inbounds[0].auto_redirect, true)
      } else {
        assert.deepEqual(config.route.rules.filter((r) => r.action === 'hijack-dns'), [{ inbound: ['dns-in'], action: 'hijack-dns' }])
        assert.ok(!config.dns.servers.some((s) => s.tag === 'dns-local'))
        assert.equal(config.inbounds[0].auto_redirect, undefined)
      }
      assert.ok(config.inbounds.some((i) => i.tag === 'dns-in' && ['0.0.0.0', '::'].includes(i.listen)))
      // auto_redirect 只有 Linux(nftables)能初始化,本机 macOS 上 sing-box check 会直接
      // FATAL "initialize auto-redirect: invalid argument";上面已经断言过它的取值,校验时去掉
      delete config.inbounds[0].auto_redirect
      const { rulesetTags } = buildRoute(profile.routing, dir)
      for (const tag of rulesetTags) compileSrs(dir, tag)
      const cfgPath = path.join(dir, 'config.json')
      prepareFlip(config, dir)
      fs.writeFileSync(cfgPath, JSON.stringify(config))
      execFileSync(sbBin, ['check', '-c', cfgPath])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('代理 DNS 配了备用上游(并发竞速)生成的配置通过 sing-box check:evaluate + respond race 真内核认', { skip: skipIfNoBin }, async () => {
  requireBin()
  const { flipFlagContent, flipPlaceholderSource, isFlipBypassTag, isFlipTag } = await import('./flip.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-check-race-'))
  const flipDir = path.join(dir, 'flip')
  fs.mkdirSync(flipDir)
  try {
    const { nodes } = parseSubscription('ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@hk.example.com:8388#HK-01')
    const renamed = renameNodes(nodes)
    const userGroups = [{ id: 'g', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }]
    const profile = {
      ipv6: true, rejectQuic: true,
      dns: {
        split: true, mode: 'hijack', direct: '223.5.5.5',
        proxy: '1.1.1.1', proxyProtocol: 'tcp',
        // 主上游 + 两个备用:三家同时问,谁先回 NOERROR 用谁的(GitHub #151)
        proxyExtras: [{ server: '8.8.8.8', protocol: 'tcp' }, { server: '9.9.9.9', protocol: 'udp', port: 53 }],
      },
      tun: { autoRedirect: false },
      clientRoutes: [{ id: 'c1', enabled: true, sources: ['192.168.1.10'], outbound: '香港-自动' }],
      routing: { fallbackDefault: '香港-自动', custom: { enabled: true, rules: [{ type: 'domainSuffix', value: 'example.com', outbound: '香港-自动' }] }, policies: [
        { id: 'g', name: 'Google', default: '香港-自动', rulesets: ['geosite-google'], domainSuffix: ['gstatic.com'] },
        { id: 'cn', name: '国内', default: 'direct', rulesets: ['geoip-cn', 'geosite-cn'] },
      ] },
      clashApiSecret: 'testsecret',
    }
    const config = buildConfig({ nodes: renamed, userGroups, profile, rulesetDir: dir, flipDir, localSubnets: ['192.168.1.0/24'] })
    // 三条走代理的路径都要竞速:站点集(成对规则)、前置自定义分流 / 终端分流(普通规则)、兜底
    const evaluates = config.dns.rules.filter((r) => r.action === 'evaluate' || (r.type === 'logical' && r.action === 'evaluate'))
    const responds = config.dns.rules.filter((r) => r.action === 'respond' && r.race === true)
    assert.ok(evaluates.length >= 6, `并发发起的规则太少:${evaluates.length}`)
    assert.ok(responds.length >= 6, `竞速应答规则太少:${responds.length}`)
    // 每台解析器都要有自己的服务器条目(主 + 两个备用)
    const proxyServers = config.dns.servers.filter((x) => String(x.tag).startsWith('dns-proxy'))
    assert.ok(proxyServers.some((x) => x.server === '8.8.8.8') && proxyServers.some((x) => x.server === '9.9.9.9'), '备用上游要各自开一台解析器')
    // 兜底也要竞速,而且最后仍留一条普通规则兜住(几家都没给 NOERROR 时行为和单上游一样)
    assert.ok(config.dns.rules.some((r) => Array.isArray(r.rule_set) && r.server === 'dns-proxy'), '兜底要留普通规则')

    fs.writeFileSync(path.join(dir, 'ph.json'), flipPlaceholderSource())
    execFileSync(sbBin, ['rule-set', 'compile', '--output', path.join(dir, 'ph.srs'), path.join(dir, 'ph.json')])
    let on = true
    for (const entry of config.route.rule_set) {
      if (isFlipBypassTag(entry.tag)) fs.copyFileSync(path.join(dir, 'ph.srs'), entry.path)
      else if (isFlipTag(entry.tag)) { fs.writeFileSync(entry.path, flipFlagContent(on)); on = !on }
      else if (isNodeDirectTag(entry.tag)) writeNodeDirect(entry)
      else compileSrs(dir, entry.tag)
    }
    const cfgPath = path.join(dir, 'config.json')
    prepareFlip(config, dir)
    fs.writeFileSync(cfgPath, JSON.stringify(config))
    execFileSync(sbBin, ['check', '-c', cfgPath])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
