import { customOutboundTag, customPolicyActive, customRuleTag, isNtpDirectRule, normalizeRouting, parsePortSpec } from './routing-model.mjs'
import { isNodeDirectTag } from './direct-hosts.mjs'

// 一条 route 规则归谁。界面的「规则匹配」一步要说清楚命中的是哪个站点集(含兜底)、还是前置自定义分流、还是
// 内置规则(私网直连、订阅和节点站点直连、终端分流、内核自用的 tun / DNS 规则)——出口(直连 / 节点)是出口,不是站点集。
// 规则路由推算和真实路由(内核连接表里的记录)两边都用这一套,两列才对得上。

const CUSTOM_CONDITION_KEY = {
  domain: 'domain', domainSuffix: 'domain_suffix', domainKeyword: 'domain_keyword', ipCidr: 'ip_cidr',
}
const has = (rule, key) => Object.prototype.hasOwnProperty.call(rule, key)
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])

// 这条规则是不是前置自定义分流里的某一行。按内容认,不按下标算:规则的排列以后还会变,按下标迟早对不上。
export const isCustomRule = (rule, custom, builtin) => {
  if (!rule || !customPolicyActive(custom)) return false
  return custom.rules.some((r) => {
    if (rule.outbound !== customOutboundTag(r, builtin)) return false
    const tag = customRuleTag(r)
    // 规则集链接会编成域名 / IP 两份,任一被引用都算这一行
    if (tag) return Array.isArray(rule.rule_set) && rule.rule_set.some((t) => t === tag || t === `${tag}-ip`)
    // 端口行:配置里是 port / port_range 两个字段,和这一行拆出来的对得上才算
    if (r.type === 'port') {
      const spec = parsePortSpec(r.value)
      const same = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
      return Boolean(spec) && same(rule.port, spec.port) && same(rule.port_range, spec.port_range)
    }
    const key = CUSTOM_CONDITION_KEY[r.type]
    return Boolean(key) && Array.isArray(rule[key]) && rule[key].length === 1 && rule[key][0] === r.value
  })
}

const policyNames = (conf) => new Set([...conf.activePolicies.map((p) => p.name), conf.fallback.name])

// 归属:{ kind: 'policy', name } 站点集(名字就是它的 selector)/ { kind: 'custom', name } 前置自定义分流 /
// { kind: 'builtin', name: private | ntp | nodes | clients | kernel | other } 内置规则(前端按 name 取文案)
export const ruleOwner = (rule, routing, builtin) => {
  if (!rule || typeof rule !== 'object') return null
  const conf = normalizeRouting(routing)
  if (typeof rule.outbound === 'string' && policyNames(conf).has(rule.outbound)) return { kind: 'policy', name: rule.outbound }
  if (isCustomRule(rule, conf.custom, builtin)) return { kind: 'custom', name: conf.custom.name }
  if (has(rule, 'ip_is_private')) return { kind: 'builtin', name: 'private' }
  if (builtin && rule.outbound === builtin.direct && isNtpDirectRule(rule)) return { kind: 'builtin', name: 'ntp' }
  if (has(rule, 'source_ip_cidr') || has(rule, 'source_mac_address')) return { kind: 'builtin', name: 'clients' }
  // sniff / hijack-dns / 拒绝 tun 网段 / dnsmasq 回送这些是内核自用的
  if ((rule.action && rule.action !== 'route') || has(rule, 'override_address') || has(rule, 'override_port') || has(rule, 'inbound')) return { kind: 'builtin', name: 'kernel' }
  if (builtin && rule.outbound === builtin.direct && (has(rule, 'domain') || has(rule, 'domain_suffix') || has(rule, 'ip_cidr'))) return { kind: 'builtin', name: 'nodes' }
  // 部署的配置里订阅和节点站点直连引用两份规则集(engine/direct-hosts.mjs)
  if (builtin && rule.outbound === builtin.direct && [].concat(rule.rule_set || []).some(isNodeDirectTag)) return { kind: 'builtin', name: 'nodes' }
  return { kind: 'builtin', name: 'other' }
}

// 内核连接记录里的规则原文:rule.String() + " => " + action.String()(experimental/clashapi/connections.go)。
// rule.String() 是各条件项用空格连起来的 key=value;多个值写成 [a b c],域名 / IP 网段超过 3 个只列前三个再加 "..."
// (route/rule/rule_item_domain.go、rule_item_cidr.go),domain_regex 超过 3 个只列前三个不加省略号,规则集 / 端口 /
// 入站列全。方括号里的空格不分词。action 形如 route(直连) / route(国外,udp_connect) / reject / hijack-dns
export const parseKernelRuleText = (text) => {
  const s = String(text || '')
  const arrow = s.indexOf(' => ')
  const cond = arrow >= 0 ? s.slice(0, arrow) : s
  const action = arrow >= 0 ? s.slice(arrow + 4).trim() : ''
  const items = new Map()
  let depth = 0
  let buf = ''
  const flush = () => {
    if (buf) {
      const eq = buf.indexOf('=')
      if (eq > 0) {
        const key = buf.slice(0, eq)
        let v = buf.slice(eq + 1)
        let truncated = false
        let values
        if (v.startsWith('[') && v.endsWith(']')) {
          v = v.slice(1, -1)
          if (v.endsWith('...')) { truncated = true; v = v.slice(0, -3) }
          values = v.split(' ').filter(Boolean)
        } else values = [v]
        items.set(key, { values, truncated })
      }
    }
    buf = ''
  }
  for (const ch of cond) {
    if (ch === '[') depth++
    if (ch === ']') depth--
    if (ch === ' ' && depth === 0) { flush(); continue }
    buf += ch
  }
  flush()
  const route = /^route[(（]([^,)）]*)/.exec(action)
  return { items, outbound: route ? route[1] : '', action: action ? action.replace(/[(（].*$/, '') : '' }
}

// 生成配置里的一条规则按同样的词法拆成 key → 值列表
const ITEM_KEYS = ['inbound', 'ip_version', 'network', 'protocol', 'domain', 'domain_suffix', 'domain_keyword', 'domain_regex',
  'source_ip_cidr', 'ip_cidr', 'source_port', 'source_port_range', 'port', 'port_range', 'rule_set', 'source_ip_is_private', 'ip_is_private']
export const ruleItems = (rule) => {
  const items = new Map()
  for (const key of ITEM_KEYS) {
    if (!has(rule, key)) continue
    if (key === 'ip_is_private' || key === 'source_ip_is_private') {
      if (rule[key]) items.set(key, { values: ['true'], truncated: false })
      continue
    }
    items.set(key, { values: list(rule[key]).map(String), truncated: false })
  }
  return items
}

const itemsMatch = (kernel, generated) => {
  if (kernel.size !== generated.size) return false
  for (const [key, k] of kernel) {
    const g = generated.get(key)
    if (!g) return false
    if (!k.values.every((v) => g.values.includes(v))) return false
    // 内核只列了前三个:带 "..." 的,或 domain_regex 那种正好三个而配置里更多的
    if (!k.truncated && k.values.length !== g.values.length && !(k.values.length === 3 && g.values.length > 3)) return false
  }
  return true
}

// 规则原文对回配置里的哪一条(按内容,不按下标)。出口对得上的才算候选;多条同样对得上取第一条
export const findKernelRule = (routeRules, text) => {
  const parsed = parseKernelRuleText(text)
  if (!parsed.items.size) return { index: -1, rule: null, parsed }
  for (let index = 0; index < (routeRules || []).length; index++) {
    const rule = routeRules[index]
    if (!rule || typeof rule !== 'object') continue
    if (parsed.outbound && rule.outbound !== undefined && rule.outbound !== parsed.outbound) continue
    if (parsed.action === 'reject' && rule.action !== 'reject') continue
    if (itemsMatch(parsed.items, ruleItems(rule))) return { index, rule, parsed }
  }
  return { index: -1, rule: null, parsed }
}

// 连接记录 → 归属:链路根就是某个站点集的 selector 时直接是它;否则拿规则原文对回正在跑的配置里的那一条再分类。
// 对不上(老内核的原文格式、连接表没记规则)就返回 null,界面退回显示出口
export const connectionOwner = ({ chains, rule: text, routeRules, routing, builtin }) => {
  const conf = normalizeRouting(routing)
  const root = Array.isArray(chains) && chains.length ? chains[0] : ''
  if (root && policyNames(conf).has(root)) return { kind: 'policy', name: root }
  const found = findKernelRule(routeRules, text)
  if (!found.rule) return null
  const owner = ruleOwner(found.rule, routing, builtin)
  return owner ? { ...owner, index: found.index } : null
}
