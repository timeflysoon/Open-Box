import { createHash } from 'node:crypto'

// 热切换:站点集在直连 / 代理之间翻面时不重启内核。这是唯一的模式——v0.1.207 / v0.1.208 有过一个开关
// 「直连和代理切换重启内核」(档案键 restartOnClassFlip / restartOnFlip)可以退回老的重启路径,v0.1.210 起去掉。
//
// sing-box 没有热加载(SIGHUP = 关掉整个实例再新起),运行中能变的只有 selector 的选择和**本地规则集文件的内容**
// (内核盯着文件,变了自己重载)。所以把「这个站点集此刻走直连还是走代理」从配置结构里拿出来,放进一个很小的
// 开关规则集里:按类别分叉的规则成对写进配置——
//     logical AND(站点集匹配, 开关[, 附加条件])  → 代理那一支
//     站点集匹配                                 → 直连那一支
// 翻面时只改写开关文件。入口旁路同理:每个候选 geoip 集合配一份内容可换的动态规则集。
// 2026-09-19 在隔离容器里用 1.14.0-openbox-tcp5 验证过:DNS(含 AAAA 空应答、兜底)、路由(三条件 AND)、
// nft 旁路集合都能在线切换,≤ 0.5 秒生效,已建立的连接不断。
// 这个文件只有纯函数;写文件和翻面流程在 system/flip-files.mjs。

export const FLIP_TAG_PREFIX = 'obflip-'
export const FLIP_FALLBACK_TAG = `${FLIP_TAG_PREFIX}fallback`
export const FLIP_BYPASS_PREFIX = `${FLIP_TAG_PREFIX}byp-`
export const FLIP_DIR_NAME = 'flip'

export const isFlipTag = (tag) => typeof tag === 'string' && tag.startsWith(FLIP_TAG_PREFIX)
export const isFlipBypassTag = (tag) => typeof tag === 'string' && tag.startsWith(FLIP_BYPASS_PREFIX)

// 站点集的开关 tag:按站点集 id 取(normalizeRouting 保证有 id;改名、调序都不变),兜底是固定的名字。
// tag 会拼进文件路径,只用十六进制
export const flipFlagTag = (policy) => `${FLIP_TAG_PREFIX}${createHash('sha256').update(String((policy && (policy.id || policy.name)) || '')).digest('hex').slice(0, 12)}`
export const flipBypassTag = (geoTag) => `${FLIP_BYPASS_PREFIX}${geoTag}`
// 入口白名单那一侧(engine/routing-model.mjs 的 entryModePlan):"必须进内核"的动态集。和旁路动态集一样每个 geoip
// 候选一份(站点集走代理 / 拒绝时满、直连时空),另外三份固定的:
//   obflip-need-all     黑名单模式时是"全部"(0.0.0.0/0 + ::/0),白名单模式时只剩 ::/0(v6 这一版照旧进内核)
//   obflip-need-fakeip  FakeIP 占位池(FakeIP 开着就满)
//   obflip-need-cidr    走代理 / 拒绝的站点集手写的网段 + 前置自定义分流里走代理的 IP 行(编成一份)
export const FLIP_NEED_PREFIX = `${FLIP_TAG_PREFIX}need-`
export const flipNeedTag = (geoTag) => `${FLIP_NEED_PREFIX}${geoTag}`
export const FLIP_NEED_ALL = `${FLIP_NEED_PREFIX}all`
export const FLIP_NEED_FAKEIP = `${FLIP_NEED_PREFIX}fakeip`
export const FLIP_NEED_CIDR = `${FLIP_NEED_PREFIX}cidr`
export const FLIP_NEED_FIXED = [FLIP_NEED_ALL, FLIP_NEED_FAKEIP, FLIP_NEED_CIDR]
export const isFlipNeedTag = (tag) => typeof tag === 'string' && tag.startsWith(FLIP_NEED_PREFIX)

// 名字 → 开关 tag(生效的站点集 + 兜底)。conf 是 normalizeRouting 的结果
export const flipFlagMap = (conf) => {
  const map = new Map()
  for (const policy of (conf && conf.activePolicies) || []) map.set(policy.name, flipFlagTag(policy))
  if (conf && conf.fallback && conf.fallback.name) map.set(conf.fallback.name, FLIP_FALLBACK_TAG)
  return map
}

// 开关文件的内容(source 格式,免编译)。ON = 此刻不是直连(走代理或拒绝):DNS 规则和路由规则里 network 这一项
// 对 UDP / TCP 的查询和连接都命中,等于「匹配一切」;OFF = 一条永远不会命中的域名。
export const FLIP_FLAG_ON = JSON.stringify({ version: 3, rules: [{ network: ['tcp', 'udp'] }] })
export const FLIP_FLAG_OFF = JSON.stringify({ version: 3, rules: [{ domain: ['obflip-off.invalid'] }] })
export const flipFlagContent = (on) => (on ? FLIP_FLAG_ON : FLIP_FLAG_OFF)

// 旁路动态集的「空」状态不能真空:启动时集合全空,内核根本不建 nft 集合,之后再往里填就报
// 「create ipv4 route exclude address set: no such file or directory」(隔离实验 L4)。放文档保留段里的单个地址占位,
// v4 / v6 各一个,集合从启动起就在
export const FLIP_BYPASS_PLACEHOLDER = ['192.0.2.255/32', '2001:db8:ffff::ffff/128']
export const flipPlaceholderSource = () => JSON.stringify({ version: 3, rules: [{ ip_cidr: FLIP_BYPASS_PLACEHOLDER }] })
// 上面那份源码用内核(1.14.0-openbox-tcp5)编出来的 .srs,46 字节,内容是固定的,直接内嵌:热切换是默认模式,每次部署都要
// 用到占位文件,不再为它多起一次内核进程、多一个会失败的环节。engine/check-config.test.mjs 用真内核核对这串字节没走样
export const FLIP_PLACEHOLDER_SRS_BASE64 = 'U1JTAnjaYmRgY2SAACaWAwxM/8GEgAIj747//6ESDP8xBf4zAAIAAP//StUOeA=='

// 成对规则里代理那一支:子规则各是一组条件,整体是它们的与;tail 是动作(server / action / rcode / outbound)
export const andRule = (subRules, tail = {}) => ({ type: 'logical', mode: 'and', rules: subRules.filter((r) => r && Object.keys(r).length > 0), ...tail })

// 给「读规则」的各处用(规则页推算、DNS 判定、规则归属):含开关的 logical 规则——
//   开关 OFF → null(这条此刻不会命中,跳过);
//   开关 ON  → 把其余子规则并成一条普通规则(每个子规则只是一组条件,并起来与 AND 等价),动作照抄。
// 不含开关的规则(包括域名过滤那种 logical)原样返回。flipState: { [开关 tag]: boolean },查不到的开关按 OFF 算
export const flipFlagOfRule = (rule) => {
  if (!rule || rule.type !== 'logical' || rule.mode !== 'and' || !Array.isArray(rule.rules)) return ''
  for (const sub of rule.rules) {
    const tags = sub && Array.isArray(sub.rule_set) ? sub.rule_set : []
    if (tags.length === 1 && isFlipTag(tags[0]) && !isFlipBypassTag(tags[0]) && Object.keys(sub).length === 1) return tags[0]
  }
  return ''
}
export const flattenFlipRule = (rule, flipState = {}) => {
  // flipState 传 true:不管开关状态,只要「这条规则去掉开关之后匹配什么」(反查规则归谁管时用)
  const isOn = (tag) => flipState === true || Boolean(flipState && flipState[tag])
  const flag = flipFlagOfRule(rule)
  if (!flag) {
    // 兜底那条代理支是单独一条 { rule_set: [开关], server }:同样按开关状态决定算不算数,条件去掉开关后就是「无条件」
    const tags = rule && Array.isArray(rule.rule_set) ? rule.rule_set : []
    if (rule && rule.type !== 'logical' && tags.length === 1 && isFlipTag(tags[0]) && !isFlipBypassTag(tags[0])) {
      if (!isOn(tags[0])) return null
      const { rule_set: _flag, ...rest } = rule
      void _flag
      return rest
    }
    return rule
  }
  if (!isOn(flag)) return null
  const { type: _t, mode: _m, rules, ...tail } = rule
  void _t
  void _m
  const flat = {}
  for (const sub of rules) {
    if (sub && Array.isArray(sub.rule_set) && sub.rule_set.length === 1 && sub.rule_set[0] === flag && Object.keys(sub).length === 1) continue
    Object.assign(flat, sub)
  }
  return { ...flat, ...tail }
}

// 此刻每个开关该是什么状态:classes 是 routing-model.mjs 的 policyClasses(含兜底);不是直连就是 ON
export const flipFlagStates = (conf, classes) => {
  const out = {}
  for (const [name, tag] of flipFlagMap(conf)) out[tag] = Object.prototype.hasOwnProperty.call(classes || {}, name) ? classes[name] !== 'direct' : false
  return out
}

// 入口旁路的候选:所有生效站点集引用到的 geoip-* 集合(去重、保序)。翻面时「满 / 占位」在文件里换,这张表不变
export const flipBypassCandidates = (conf) => {
  const seen = new Set()
  for (const policy of (conf && conf.activePolicies) || []) {
    for (const tag of policy.rulesets || []) if (/^geoip-/.test(tag)) seen.add(tag)
  }
  return [...seen]
}
