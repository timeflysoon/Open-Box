// 流量表里"名称"后面那个灰字:DHCP 主机名,或者"本机 · WAN pppoe-wan0"这种路由器自身地址的
// 标注。主表和下钻表共用,别各写一遍。
import type { OpenboxTrafficRow } from '@/api/openbox'
import { i18n } from '@/i18n'
import { failoverLaneOfTag, isFailoverInternalTag } from '@/store/openboxFailover'
import { getNowProxyNodeName, proxyMap } from '@/store/proxies'

export const trafficRowNote = (row: OpenboxTrafficRow, t: (key: string, params?: Record<string, unknown>) => string): string => {
  if (row.self) {
    if (row.self.kind === 'lan') return t('trafficSelfLan', { iface: row.self.iface })
    if (row.self.kind === 'wan') return t('trafficSelfWan', { iface: row.self.iface })
    return t('trafficSelfOther', { iface: row.self.iface })
  }
  return row.name || ''
}

// ---- 流量表里的节点名 ----
// 服务端把较早的明细合并成一行,键固定是 ~other;界面显示成「其他(较早的数据已合并)」。
// 节点那一维里还会出现「组」或故障转移页签的内部 tag(旧记录),显示时换成它当前实际走的那个节点,
// 同一个节点拆成的多行合并成一行(与上游 v0.1.338 一致)
const TRAFFIC_OTHER_KEY = '~other'
const isGroupKey = (key: string) => Array.isArray(proxyMap.value[key]?.all)
const isLaneKey = (key: string) => isFailoverInternalTag(key)

const resolveNodeKey = (key: string): string => {
  if (!isGroupKey(key) && !isLaneKey(key)) return key
  const now = getNowProxyNodeName(key)
  if (now && now !== key && !isGroupKey(now) && !isLaneKey(now)) return now
  return (isLaneKey(key) ? failoverLaneOfTag(key)?.lane.members?.[0] : proxyMap.value[key]?.all?.[0]) || key
}

export const trafficKeyLabel = (key: string): string =>
  key === TRAFFIC_OTHER_KEY ? i18n.global.t('trafficOtherMerged') : resolveNodeKey(key)

export const mergeTrafficNodeRows = (rows: OpenboxTrafficRow[]): OpenboxTrafficRow[] => {
  if (!rows.some((row) => isGroupKey(row.key) || isLaneKey(row.key))) return rows
  const merged = new Map<string, OpenboxTrafficRow>()
  for (const row of rows) {
    const key = resolveNodeKey(row.key)
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, { ...row, key })
      continue
    }
    merged.set(key, { ...prev, up: prev.up + row.up, down: prev.down + row.down, conns: prev.conns + row.conns })
  }
  return [...merged.values()].sort((a, b) => b.up + b.down - (a.up + a.down) || a.key.localeCompare(b.key))
}
