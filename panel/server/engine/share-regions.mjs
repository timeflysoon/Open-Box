// 「地区分流」:共享网络(A 模式)手机客户端按人所在地区决定哪些流量本地直连、哪些回路由器。
// 默认三组(中国大陆 / 港澳 / 其他)和客户端内置的是同一份:defaults/share-regions-default.json 是
// clients/core/regions-default.json 的拷贝(测试核对两份一字不差)。档案里存 shareRegions,没存 / 存了空数组 = 用默认。
// 方案:docs/superpowers/specs/2026-09-27-client-apps-design.md §4.3。它不进路由器自己的内核配置,改了不用重启内核
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import { normalizeCidr } from './client-routes.mjs'

export const SHARE_REGIONS_DEFAULT_FILE = new URL('../defaults/share-regions-default.json', import.meta.url)
export const DEFAULT_SHARE_REGIONS = Object.freeze(JSON.parse(fs.readFileSync(SHARE_REGIONS_DEFAULT_FILE, 'utf8')).groups)
export const SHARE_REGION_RULE_TYPES = Object.freeze(['geosite', 'geoip', 'domain', 'domainSuffix', 'ipcidr'])
// direct = 本地直连;proxy = 回路由器(经共享网络节点,由路由器按自己的规则出去)
export const SHARE_REGION_ACTIONS = Object.freeze(['direct', 'proxy'])
export const SHARE_REGION_LOCALES = Object.freeze(['zh-CN', 'zh-TW', 'en'])
const MAX_GROUPS = 12
const MAX_RULES = 200
const GEO_NAME = /^[a-z0-9!@._-]{1,80}$/
const DOMAIN = /^[A-Za-z0-9*_.-]{1,253}$/

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export const effectiveShareRegions = (profile) =>
  Array.isArray(profile && profile.shareRegions) && profile.shareRegions.length ? profile.shareRegions : DEFAULT_SHARE_REGIONS

// 客户端拿它判断要不要重新拉(内容一变就变)
export const shareRegionsVersion = (groups) => createHash('sha256').update(JSON.stringify(groups)).digest('hex').slice(0, 16)

// 返回错误说明(英文,和 validateProfilePatch 其余项一致);合法返回 null。空数组合法:回到默认三组
export const validateShareRegions = (groups) => {
  if (!Array.isArray(groups)) return 'shareRegions must be an array'
  if (groups.length > MAX_GROUPS) return `shareRegions allows at most ${MAX_GROUPS} groups`
  if (!groups.length) return null
  const ids = new Set()
  const claimed = new Map()
  let defaults = 0
  for (const g of groups) {
    if (!isPlainObject(g)) return 'shareRegions entries must be objects'
    if (typeof g.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(g.id)) return 'shareRegions[].id must match /^[a-z0-9_-]{1,32}$/'
    if (ids.has(g.id)) return `shareRegions[].id duplicated: ${g.id}`
    ids.add(g.id)
    if (!isPlainObject(g.name)) return 'shareRegions[].name must be an object keyed by locale'
    const names = SHARE_REGION_LOCALES.map((l) => g.name[l]).filter((v) => typeof v === 'string' && v.trim())
    if (!names.length) return `shareRegions[${g.id}].name needs at least one of ${SHARE_REGION_LOCALES.join(', ')}`
    if (Object.values(g.name).some((v) => typeof v !== 'string' || v.length > 30)) return `shareRegions[${g.id}].name values must be strings (<= 30 chars)`
    if (!Array.isArray(g.regions) || g.regions.some((r) => typeof r !== 'string' || !/^[A-Z]{2}$/.test(r))) {
      return `shareRegions[${g.id}].regions must be ISO 3166-1 alpha-2 codes`
    }
    // 自动定位按地区选组:同一个地区只能归一个组
    for (const r of g.regions) {
      if (claimed.has(r)) return `region ${r} is in both ${claimed.get(r)} and ${g.id}`
      claimed.set(r, g.id)
    }
    if ('default' in g && typeof g.default !== 'boolean') return `shareRegions[${g.id}].default must be a boolean`
    if (g.default === true) defaults++
    if (!SHARE_REGION_ACTIONS.includes(g.catchAll)) return `shareRegions[${g.id}].catchAll must be one of ${SHARE_REGION_ACTIONS.join(', ')}`
    const resolver = isPlainObject(g.dns) ? g.dns.directResolver : ''
    if (resolver !== undefined && resolver !== '' && !(typeof resolver === 'string' && net.isIP(resolver))) {
      return `shareRegions[${g.id}].dns.directResolver must be empty (system DNS) or an IP address`
    }
    if (!Array.isArray(g.rules) || g.rules.length > MAX_RULES) return `shareRegions[${g.id}].rules must be an array (<= ${MAX_RULES})`
    for (const r of g.rules) {
      if (!isPlainObject(r)) return `shareRegions[${g.id}].rules entries must be objects`
      if (!SHARE_REGION_RULE_TYPES.includes(r.type)) return `shareRegions[${g.id}].rules[].type must be one of ${SHARE_REGION_RULE_TYPES.join(', ')}`
      if (!SHARE_REGION_ACTIONS.includes(r.action)) return `shareRegions[${g.id}].rules[].action must be one of ${SHARE_REGION_ACTIONS.join(', ')}`
      const value = typeof r.value === 'string' ? r.value.trim() : ''
      const ok = r.type === 'geosite' || r.type === 'geoip' ? GEO_NAME.test(value)
        : r.type === 'ipcidr' ? normalizeCidr(value) !== ''
          : DOMAIN.test(value)
      if (!ok) return `shareRegions[${g.id}] has an invalid ${r.type} rule: ${JSON.stringify(r.value)}`
    }
  }
  if (defaults !== 1) return 'shareRegions needs exactly one default group (used when no region matches)'
  return null
}
