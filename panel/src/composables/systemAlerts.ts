// 「系统提示」铃铛(对齐上游 v0.1.499 新增项):把散在各个接口里的异常汇总成一份告警清单,
// 在「后端设置」的内核卡片右上角以铃铛 + 数字徽标呈现,点开是高对比度汇总弹窗。
//
// 设计取舍:
//   - **纯前端聚合**。上游也是把已有的服务状态 / 故障转移状态 / 订阅列表 / 更新信息拼一遍,
//     没有单独的告警接口;这里保持同一口径,不新增后端接口。
//   - 判据按上游 v0.1.500 的口径写:探测压力用的是「最近 3 分钟真实完成吞吐」而不是名额占用率,
//     并且只在**探测队列持续积压满 2 分钟**后才告警(见 probeOverload)。
//   - 每一类告警都带稳定 id,前端据此做去重与展开态记忆。

import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  OpenboxFailoverStatus,
  OpenboxKernelVersion,
  OpenboxServiceStatus,
  OpenboxSubscription,
} from '@/api/openbox'

export type AlertSeverity = 'error' | 'warning'

export interface SystemAlert {
  id: string
  severity: AlertSeverity
  title: string
  // 出问题的对象(节点组 / 订阅名等),有就显示「对象: xxx」一行
  target?: string
  detail?: string
  // 逐条明细(如「组名(urltest · 12 节点 · 间隔 300s)」)
  items?: string[]
  suggestion?: string
}

// 探测压力:上游 v0.1.500 起改用「真实完成吞吐」判断,需求超过完成能力 1.2 倍才算压力;
// 另外要队列确实积压(backlogMs)满 2 分钟才告警,避免冷启动首轮测速时的误报。
const PROBE_DEMAND_RATIO = 1.2
const PROBE_BACKLOG_ALERT_MS = 2 * 60 * 1000
// 内核刚启动的 5 分钟内不判探测压力(上游跳过冷启动首轮测速期)
const PROBE_COLD_START_SEC = 5 * 60
// 弹窗里最多列几个组的明细,超出用「其余 N 个」收尾
const PROBE_ITEM_LIMIT = 8

export interface AlertInputs {
  serviceStatus: OpenboxServiceStatus | null
  kernelVersion: OpenboxKernelVersion | null
  failoverStatus: OpenboxFailoverStatus | null
  // 每个分组/页签的有效成员数(用于探测压力明细里的「N 节点」)
  membersByGroup: Record<string, number>
  subscriptions: OpenboxSubscription[]
  subscriptionsError?: string | null
  updateError?: string | null
  now: number
}

// 判探测压力:返回需要提示的那几个数,不需要提示时返回 null。
export const probeOverload = (
  probes: NonNullable<OpenboxFailoverStatus['probes']> | null | undefined,
): { demand: number; done: number } | null => {
  if (!probes) return null
  const demand = probes.demandPerSec
  const done = probes.throughputPerSec
  // 没测过吞吐(样本不足)就不判——否则冷启动会被当成「压力过高」
  if (demand === null || done === null || done <= 0) return null
  if (!(demand > done * PROBE_DEMAND_RATIO)) return null
  // 队列没真正积压(或积压不满 2 分钟)时不算:上游只在持续积压满 2 分钟后才告警
  const backlog = probes.backlogMs
  if (typeof backlog !== 'number' || backlog < PROBE_BACKLOG_ALERT_MS) return null
  return { demand, done }
}

// 订阅用量:过期 / 用尽 / 即将过期这类需要在铃铛里提示的情况
const subscriptionUsageAlerts = (
  subs: OpenboxSubscription[],
  t: (k: string, p?: Record<string, unknown>) => string,
  now: number,
): SystemAlert[] => {
  const out: SystemAlert[] = []
  const flagged: string[] = []
  for (const s of subs) {
    const u = s.usage
    if (!u) continue
    const reasons: string[] = []
    const expired = typeof u.expire === 'number' && u.expire > 0 && u.expire * 1000 < now
    const used = (u.upload ?? 0) + (u.download ?? 0)
    const exhausted = typeof u.total === 'number' && u.total > 0 && used >= u.total
    if (!expired && !exhausted) continue
    if (expired) reasons.push(t('systemAlertSubscriptionExpired'))
    if (exhausted) reasons.push(t('systemAlertSubscriptionExhausted'))
    flagged.push(t('systemAlertSubscriptionUsageItem', { name: s.name, reason: reasons.join(' / ') }))
  }
  if (flagged.length > 0) {
    out.push({
      id: 'subscription-usage',
      severity: 'warning',
      title: t('systemAlertSubscriptionUsageTitle'),
      detail: t('systemAlertSubscriptionUsageDetail'),
      items: flagged,
      suggestion: t('systemAlertSubscriptionUsageSuggestion'),
    })
  }
  return out
}

// 把输入聚合成告警清单(顺序:错误在前、警告在后,与上游一致)
export const buildSystemAlerts = (
  input: AlertInputs,
  t: (k: string, p?: Record<string, unknown>) => string,
): SystemAlert[] => {
  const errors: SystemAlert[] = []
  const warnings: SystemAlert[] = []
  const svc = input.serviceStatus
  const conflicts = svc?.conflicts ?? []
  const coreRunning = svc ? !!svc.core?.running : null

  // 1. 端口 / 进程冲突(其它代理插件占着 DNS 或防火墙)
  if (conflicts.length > 0) {
    const names = conflicts.map((c) => c.label).join(t('listSeparator'))
    errors.push({
      id: 'proxy-conflict',
      severity: 'error',
      title: t('systemAlertConflictTitle'),
      target: names,
      detail: t('systemAlertConflictSuggestion'),
      suggestion: t('systemAlertConflictSuggestion'),
    })
  }

  // 2. 面板在跑但内核没跑(排除「刚启动就要起来」的瞬间,容忍接口本身报错)
  if (svc && coreRunning === false && conflicts.length === 0) {
    errors.push({
      id: 'core-stopped',
      severity: 'error',
      title: t('systemAlertCoreStoppedTitle'),
      detail: t('systemAlertCoreStoppedDetail'),
      suggestion: t('systemAlertCoreStoppedSuggestion'),
    })
  }

  // 3. 面板服务自己没在跑(容器里常见)
  if (svc && svc.panel && svc.panel.running === false) {
    errors.push({
      id: 'panel-stopped',
      severity: 'error',
      title: t('systemAlertPanelStoppedTitle'),
      detail: t('systemAlertPanelStoppedDetail'),
      suggestion: t('systemAlertPanelStoppedSuggestion'),
    })
  }

  // 4. 内核二进制不可用(版本探测说 ok === false)
  if (input.kernelVersion && input.kernelVersion.ok === false) {
    errors.push({
      id: 'kernel-unavailable',
      severity: 'error',
      title: t('systemAlertKernelUnavailableTitle'),
      detail: t('systemAlertKernelUnavailableDetail'),
      suggestion: t('systemAlertKernelUnavailableSuggestion'),
    })
  }

  // 5. 故障转移:被拒绝的组、以及各组自己的 lastError
  const fo = input.failoverStatus
  if (fo) {
    for (const g of fo.groups ?? []) {
      const pausedByKernel = g.paused === 'kernel' && coreRunning === false
      if (g.status === 'reject') {
        errors.push({
          id: `failover-rejected:${g.tag || g.id}`,
          severity: 'error',
          title: t('systemAlertFailoverRejectedTitle'),
          target: g.tag,
          suggestion: t('systemAlertFailoverRejectedSuggestion'),
        })
      }
      const err = g.lastError?.trim() ?? ''
      if (err && !pausedByKernel) {
        errors.push({
          id: `failover-group-error:${g.tag || g.id}`,
          severity: 'error',
          title: t('systemAlertFailoverErrorTitle'),
          target: g.tag,
          detail: err,
          suggestion: t('systemAlertFailoverErrorSuggestion'),
        })
      }
    }
    const topErr = fo.lastError?.trim() ?? ''
    if (topErr) {
      errors.push({
        id: 'failover-error',
        severity: 'error',
        title: t('systemAlertFailoverErrorTitle'),
        detail: topErr,
        suggestion: t('systemAlertFailoverErrorSuggestion'),
      })
    }
  }

  // 6. 订阅列表本身加载失败
  const subErr = input.subscriptionsError?.trim() ?? ''
  if (subErr) {
    errors.push({
      id: 'subscription-load-error',
      severity: 'error',
      title: t('systemAlertSubscriptionErrorTitle'),
      detail: subErr,
      suggestion: t('systemAlertSubscriptionErrorSuggestion'),
    })
  }

  // 7. 探测压力过高:内核在跑、且过了冷启动期才判(上游 v0.1.500 口径)
  const uptime = svc?.core?.uptimeSeconds
  const coldStart = typeof uptime === 'number' && Number.isFinite(uptime) && uptime < PROBE_COLD_START_SEC
  if (coreRunning !== false && !coldStart) {
    const over = probeOverload(fo?.probes)
    if (over) {
      const entries = Object.entries(input.membersByGroup).filter(([, n]) => n > 0)
      const items = entries.slice(0, PROBE_ITEM_LIMIT).map(([name, n]) =>
        t('systemAlertProbeGroupItemNoCount', { name, type: 'urltest', interval: '' }),
      )
      if (entries.length > PROBE_ITEM_LIMIT) {
        items.push(t('systemAlertMoreGroups', { count: entries.length - PROBE_ITEM_LIMIT }))
      }
      warnings.push({
        id: 'probe-overload',
        severity: 'warning',
        title: t('systemAlertProbeOverloadTitle'),
        detail: t('systemAlertProbeOverloadDetail', {
          demand: over.demand.toFixed(1),
          done: over.done.toFixed(1),
        }),
        ...(items.length > 0 ? { items } : {}),
        suggestion: t('systemAlertProbeOverloadSuggestion'),
      })
    }
  }

  // 8. 有待重启生效的改动
  if (coreRunning && svc?.pendingRestart?.pending) {
    warnings.push({
      id: 'pending-restart',
      severity: 'warning',
      title: t('systemAlertPendingRestartTitle'),
      detail: t('systemAlertPendingRestartDetail'),
      suggestion: t('systemAlertPendingRestartSuggestion'),
    })
  }

  // 9. 订阅里有节点还没进内核(内核在跑、且没有待重启的整体改动时才有意义)
  if (coreRunning && !svc?.pendingRestart?.pending) {
    const stale = input.subscriptions.filter((s) => s.enabled !== false && (s.kernelStale ?? 0) > 0)
    if (stale.length > 0) {
      warnings.push({
        id: 'subscription-stale',
        severity: 'warning',
        title: t('systemAlertSubscriptionStaleTitle'),
        target: stale.map((s) => s.name).join(t('listSeparator')),
        detail: t('systemAlertSubscriptionStaleDetail'),
        items: stale.map((s) =>
          t('systemAlertSubscriptionStaleItem', { name: s.name, count: s.kernelStale ?? 0 }),
        ),
        suggestion: t('systemAlertPendingRestartSuggestion'),
      })
    }
  }

  // 10. 订阅过期 / 流量用尽
  warnings.push(
    ...subscriptionUsageAlerts(
      input.subscriptions.filter((s) => s.enabled !== false),
      t,
      input.now,
    ),
  )

  // 11. 检查更新失败(不影响使用,所以是警告)
  const updErr = input.updateError?.trim() ?? ''
  if (updErr) {
    warnings.push({
      id: 'update-failed',
      severity: 'warning',
      title: t('systemAlertUpdateFailedTitle'),
      detail: updErr,
      suggestion: t('systemAlertUpdateFailedSuggestion'),
    })
  }

  return [...errors, ...warnings]
}

// 「系统提示」的响应式入口:输入是几个已有的响应式状态,输出告警清单与「有没有错误级」。
export const useSystemAlerts = (getInputs: () => AlertInputs) => {
  const { t } = useI18n()
  const alerts: ComputedRef<SystemAlert[]> = computed(() =>
    buildSystemAlerts(getInputs(), (k, p) => t(k, p ?? {})),
  )
  const hasErrorAlert = computed(() => alerts.value.some((a) => a.severity === 'error'))
  return { alerts, hasErrorAlert }
}
