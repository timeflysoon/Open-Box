import type { OpenboxFailoverGroupStatus, OpenboxFailoverStatus } from '@/api/openbox'
import { fetchFailoverStatus, recheckFailover } from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { i18n } from '@/i18n'
import { managedOutbounds } from '@/store/openboxSiteSets'
import { computed, ref } from 'vue'

// 故障转移组的内部出站(页签子组 / 兜底拒绝)都带这个前缀,和服务端 engine/user-groups.mjs 一致。
// 它们要进内核、要能出现在链路里,但不是用户组:代理页不给它们单独开卡片,显示时换成页签的角色名
export const FAILOVER_INTERNAL_PREFIX = '__fo:'
export const isFailoverInternalTag = (name: string) => name.startsWith(FAILOVER_INTERNAL_PREFIX)

// 运行状态(服务端 system/failover-manager.mjs 维护;浏览器关了它照样在切,这里只是看)
export const failoverStatus = ref<OpenboxFailoverStatus | null>(null)
export const failoverGroupByTag = computed(() => {
  const map = new Map<string, OpenboxFailoverGroupStatus>()
  for (const g of failoverStatus.value?.groups ?? []) map.set(g.tag, g)
  return map
})

export const loadFailoverStatus = async () => {
  try {
    failoverStatus.value = await fetchFailoverStatus()
  } catch {
    /* 面板服务端没起来 / 旧版本没有这个接口:保持上一份 */
  }
}

// 有卡片在看就每 10 秒拉一次;没人看就停,不白跑
let watchers = 0
let timer: ReturnType<typeof setInterval> | null = null
export const watchFailoverStatus = () => {
  watchers += 1
  if (watchers === 1) {
    void loadFailoverStatus()
    timer = setInterval(() => void loadFailoverStatus(), 10_000)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    watchers -= 1
    if (watchers <= 0 && timer) {
      clearInterval(timer)
      timer = null
      watchers = 0
    }
  }
}

// 页签的角色名:第一个主用,后面依次备用 1、2……
export const failoverRoleLabel = (index: number) =>
  index === 0 ? i18n.global.t('failoverPrimary') : i18n.global.t('failoverBackupN', { n: index })

// 内部子组 tag 在代理页 / 策略穿透里显示成什么:用户给页签起了名就显示名字,没起就显示角色(主用 / 备用 N);
// 不是内部 tag 就原样返回。__fo:g-xxx:lane-yyy 这种技术 tag 不是产品名称,任何地方都不该露出来
export const failoverDisplayName = (name: string) => {
  if (!isFailoverInternalTag(name)) return name
  const hit = failoverLaneOfTag(name)
  if (!hit) return i18n.global.t('failoverLaneFallback')
  return hit.lane.name || failoverRoleLabel(hit.index)
}

// 故障转移父组成员表里的兜底拒绝(内置「拒绝」或内部 __fo:reject):它是内核配置里的兜底,不是用户能选的候选,
// 代理页 / 策略穿透列成员时不显示它
export const isFailoverRejectMember = (groupName: string, member: string) => {
  const group = managedOutbounds.value.find((g) => g.name === groupName)
  if (!group || group.type !== 'failover') return false
  if (member === `${FAILOVER_INTERNAL_PREFIX}reject`) return true
  const block = managedOutbounds.value.find((g) => g.kind === 'block')
  return Boolean(block && member === block.name)
}
export const failoverMembersOf = (groupName: string, all: string[]) =>
  all.filter((member) => !isFailoverRejectMember(groupName, member))

// 页签的图标:自己挑了就用自己的,没挑继承父组的(短码,给 iconUrlFor 转成地址)
export const failoverLaneIconCode = (groupName: string, laneId: string) => {
  const group = managedOutbounds.value.find((g) => g.name === groupName)
  if (!group || group.type !== 'failover') return ''
  const lane = group.lanes?.find((l) => l.id === laneId)
  return lane?.icon || group.icon || ''
}

export const isFailoverGroup = (groupName: string) =>
  managedOutbounds.value.some((g) => g.name === groupName && g.type === 'failover')

// 策略穿透里故障转移组的页签视图:每个页签在内核里对应哪个出站(单节点 = 节点本身,多节点 = 内部子组,
// 空 = 没有),有哪些有效节点,内核此刻在页签内选中谁。优先用服务端运行状态,没拉到就按定义 + 内核 /proxies 推
export interface FailoverLaneView {
  id: string
  index: number
  label: string
  ref: string | null
  subTag: string | null
  valid: string[]
  invalid: string[]
  kernelNow: string | null
  // 页签图标(短码;已按「自己的 → 继承父组」算好),iconScale 跟父组
  icon: string
  iconScale: number
}
export const failoverLanesOf = (
  groupName: string,
  proxies: Record<string, { all?: string[]; now?: string } | undefined>,
): FailoverLaneView[] | null => {
  const group = managedOutbounds.value.find((g) => g.name === groupName)
  if (!group || group.type !== 'failover') return null
  const status = failoverGroupByTag.value.get(groupName)
  const statusLanes = new Map((status?.lanes ?? []).map((l) => [l.id, l]))
  const isNode = (name: string) => Boolean(proxies[name]) && !proxies[name]?.all?.length
  const parentAll = proxies[groupName]?.all ?? []
  return (group.lanes ?? []).map((lane, index) => {
    const st = statusLanes.get(lane.id)
    const valid = st ? st.valid : lane.members.filter(isNode)
    const invalid = lane.members.filter((m) => !valid.includes(m))
    let subTag = st?.subTag ?? null
    if (!st && valid.length > 1) {
      const head = `${FAILOVER_INTERNAL_PREFIX}${group.id}:${lane.id}`
      subTag = parentAll.find((m) => m === head || (m.startsWith(head) && /^~+$/.test(m.slice(head.length)))) ?? null
    }
    const ref = st ? st.ref : valid.length === 1 ? valid[0]! : subTag
    const kernelNow = subTag ? (proxies[subTag]?.now ?? null) : valid.length === 1 ? valid[0]! : null
    return { id: lane.id, index, label: lane.name || failoverRoleLabel(index), ref, subTag, valid, invalid, kernelNow, icon: lane.icon || group.icon || '', iconScale: group.iconScale || 0 }
  })
}
// 「最近切换:主用 → 备用 1(页签失效)· 14:20:05」这一句(没切换过就是空串)
export const failoverLastSwitchText = (groupName: string, lanes: FailoverLaneView[]) => {
  const status = failoverGroupByTag.value.get(groupName)
  const sw = status?.lastSwitch
  if (!sw) return ''
  const t = i18n.global.t
  const refLabel = (laneId: string | null, ref: string) => {
    const lane = laneId ? lanes.find((l) => l.id === laneId) : null
    if (lane) return lane.label
    if (status && ref === status.rejectTag) return t('failoverReject')
    return ref || '—'
  }
  const reasonKey: Record<string, string> = {
    'lane-failed': 'failoverReasonLaneFailed',
    'restore-primary': 'failoverReasonRestore',
    'all-failed': 'failoverReasonAllFailed',
    'priority-changed': 'failoverReasonPriority',
    recovered: 'failoverReasonRecovered',
    initial: 'failoverReasonInitial',
  }
  return t('failoverLastSwitch', {
    from: refLabel(sw.from.laneId, sw.from.ref),
    to: refLabel(sw.to.laneId, sw.to.ref),
    reason: reasonKey[sw.reason] ? t(reasonKey[sw.reason]) : sw.reason,
    time: new Date(sw.at).toLocaleTimeString(),
  })
}

// 内核此刻在哪个页签:先信服务端记录的当前页签,否则按顺序找第一个引用等于父组 now 的
export const failoverCurrentLaneId = (groupName: string, lanes: FailoverLaneView[], now: string | undefined) => {
  const status = failoverGroupByTag.value.get(groupName)
  if (status?.currentLaneId && lanes.some((l) => l.id === status.currentLaneId)) return status.currentLaneId
  return lanes.find((l) => l.ref && l.ref === now)?.id ?? null
}

// 内部子组 tag → 它是哪个故障转移组的第几个页签。按节点管理里的定义找(不用等运行状态):
// tag 形如 __fo:<组id>:<页签id>,组 id 里也可能有冒号,所以按「前缀 + 组 id + :」匹配
export const failoverLaneOfTag = (tag: string) => {
  if (!isFailoverInternalTag(tag)) return null
  for (const g of managedOutbounds.value) {
    if (g.type !== 'failover' || !g.lanes) continue
    const head = `${FAILOVER_INTERNAL_PREFIX}${g.id}:`
    if (!tag.startsWith(head)) continue
    const laneId = tag.slice(head.length).replace(/~+$/, '')
    const index = g.lanes.findIndex((l) => l.id === laneId)
    if (index === -1) continue
    return { group: g, lane: g.lanes[index], index }
  }
  return null
}

// ---- 兜底拒绝 / 重新检测 / 测速跟不上(v0.1.305)----

// 这个组此刻是不是在兜底拒绝上(所有页签都没通过测速,流量被拒绝;服务端每分钟复查一次)
export const isFailoverRejected = (groupName: string) => failoverGroupByTag.value.get(groupName)?.status === 'reject'

// 失败类别的文案:复用测速失败原因那一套(latencyReasonTimeout 等),没有对应文案就原样显示
const failKindLabel = (kind: string) => {
  const camel = kind.replace(/[-_ ]+(.)/g, (_m, c: string) => c.toUpperCase())
  const key = `latencyReason${camel.charAt(0).toUpperCase()}${camel.slice(1)}`
  return i18n.global.te(key) ? i18n.global.t(key) : kind
}

// 「状态码 404(2 个)、超时(1 个)」:这个组所有失败节点按原因归类、多的在前。没有失败节点就是空串
export const failoverFailReasons = (groupName: string) => {
  const group = failoverGroupByTag.value.get(groupName)
  if (!group) return ''
  const t = i18n.global.t
  const counts = new Map<string, number>()
  const seen = new Set<string>()
  for (const lane of group.lanes) {
    for (const [tag, node] of Object.entries(lane.nodes)) {
      if (seen.has(tag) || !node || node.ok !== false) continue
      seen.add(tag)
      const code = node.kind === 'status' ? /unexpected status (\d{3})/.exec(node.error || '')?.[1] : undefined
      const label = code ? t('failoverFailStatusCode', { code }) : failKindLabel(node.kind || (node.reason === 'timeout' ? 'timeout' : 'error'))
      counts.set(label, (counts.get(label) || 0) + 1)
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => t('failoverFailItem', { reason, n }))
    .join(t('listSeparator'))
}

// 测速需求长期超过吞吐(名额已经占满)= 测不过来;界面提示减少节点或加大间隔。没数据 / 没占满就是 null
export const failoverProbeOverload = computed(() => {
  const p = failoverStatus.value?.probes
  if (!p || p.throughputPerSec == null || p.demandPerSec == null) return null
  if (!(p.demandPerSec > p.throughputPerSec * 1.2)) return null
  if (p.interactive + p.background < p.limit) return null
  return { demand: p.demandPerSec, done: p.throughputPerSec }
})

// 点「重新检测」:通知服务端马上把这个组的节点全部重测一遍,再刷新一次状态
export const recheckFailoverGroup = async (groupName: string) => {
  const group = failoverGroupByTag.value.get(groupName)
  if (!group) return
  try {
    await recheckFailover(group.id)
    showNotification({ content: 'failoverRecheckStarted', params: { name: groupName }, type: 'alert-success' })
  } catch (error) {
    showNotification({
      content: 'failoverRecheckFailed',
      params: { error: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  }
  await loadFailoverStatus()
}
