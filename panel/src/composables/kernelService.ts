// 内核服务(启动/停止/重启)的共享状态:侧边栏底部的三个按钮和「后端设置」里的内核卡片
// 共用同一份状态、同一个进行中标记,任一处点了动作另一处同步转圈、同步刷新。
import {
  fetchServiceStatus,
  runServiceAction,
  type OpenboxServiceAction,
  type OpenboxServiceStatus,
} from '@/api/openbox'
import { dismissNotification, showNotification } from '@/helper/notification'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

export const serviceStatus = ref<OpenboxServiceStatus | null>(null)
export const pendingAction = ref<OpenboxServiceAction | null>(null)

const ACTION_LABEL_KEYS: Record<OpenboxServiceAction, string> = {
  start: 'kernelActionStart',
  stop: 'kernelActionStop',
  restart: 'kernelActionRestart',
  enable: 'kernelActionEnable',
  disable: 'kernelActionDisable',
}

export const isStartDisabled = computed(
  () =>
    pendingAction.value !== null ||
    serviceStatus.value === null ||
    Boolean(serviceStatus.value?.core.running) ||
    Boolean(serviceStatus.value?.conflicts.length),
)
export const isStopDisabled = computed(() => pendingAction.value !== null || serviceStatus.value === null || !serviceStatus.value.core.running)
export const isRestartDisabled = computed(
  () =>
    pendingAction.value !== null ||
    serviceStatus.value === null ||
    !serviceStatus.value?.core.running ||
    Boolean(serviceStatus.value?.conflicts.length),
)
export const isEnableDisabled = computed(
  () => pendingAction.value !== null || serviceStatus.value === null || serviceStatus.value.core.autostart === true,
)
export const isDisableDisabled = computed(
  () => pendingAction.value !== null || serviceStatus.value === null || serviceStatus.value.core.autostart === false,
)

// 只采纳最后一次发出的刷新:定时刷新和动作后的刷新会交错,先发后回的旧响应不能把新状态盖回去
let refreshSeq = 0
export const refreshServiceStatus = async () => {
  const mine = ++refreshSeq
  try {
    const next = await fetchServiceStatus()
    if (mine !== refreshSeq) return
    serviceStatus.value = next
  } catch {
    // 拿不到就保持上一次的值;按钮的可用性按已知状态算
  }
  return serviceStatus.value
}

// 有人在看(侧边栏 / 内核页)时每 10 秒刷一次状态;多处同时用只跑一个定时器
let watchers = 0
let timer: ReturnType<typeof setInterval> | null = null
export const useServiceStatusPolling = (intervalMs = 10_000) => {
  onMounted(() => {
    watchers += 1
    void refreshServiceStatus()
    if (!timer) {
      timer = setInterval(() => void refreshServiceStatus(), intervalMs)
    }
  })
  onBeforeUnmount(() => {
    watchers -= 1
    if (watchers <= 0 && timer) {
      clearInterval(timer)
      timer = null
      watchers = 0
    }
  })
}

// 有改动要重启内核才生效:原因组合变了(或第一次出现)就弹一条黄色提示,同一条提示只更新不叠加
const RESTART_REASON_KEYS: Record<string, string> = {
  nodes: 'restartPendingReasonNodes',
  dns: 'restartPendingReasonDns',
  route: 'restartPendingReasonRoute',
  inbounds: 'restartPendingReasonInbounds',
  system: 'restartPendingReasonSystem',
}
const restartPendingSignature = computed(() => {
  const pending = serviceStatus.value?.pendingRestart
  if (!serviceStatus.value?.core.running || !pending?.pending) return ''
  return [...(pending.reasons || [])].sort().join(',') || 'pending'
})
export const useRestartPendingToast = () => {
  const { t } = useI18n()
  useServiceStatusPolling()
  watch(restartPendingSignature, (next, prev) => {
    if (!next || next === prev) return
    const reasons = (serviceStatus.value?.pendingRestart?.reasons || [])
      .map((reason) => (RESTART_REASON_KEYS[reason] ? t(RESTART_REASON_KEYS[reason]) : ''))
      .filter(Boolean)
      .join(t('restartPendingReasonSeparator'))
    showNotification({
      content: reasons ? 'restartPendingToast' : 'restartPendingToastPlain',
      params: { reasons },
      key: 'restart-pending',
      type: 'alert-warning',
      timeout: 8000,
    })
  })
}

// 检测到和别的代理服务冲突:内核在跑 / 已被自动停掉 / 没在跑,三种说法;冲突的服务变了才再弹
const CONFLICT_TOAST_KEYS = {
  running: 'kernelConflictToastRunning',
  autoStopped: 'kernelConflictToastAutoStopped',
  stopped: 'kernelConflictToast',
} as const
const conflictState = computed(() =>
  serviceStatus.value?.core.running ? 'running' : serviceStatus.value?.conflictAutoStopped ? 'autoStopped' : 'stopped',
)
const conflictSignature = computed(() => {
  const conflicts = serviceStatus.value?.conflicts || []
  return conflicts.length ? `${conflictState.value}:${conflicts.map((c) => c.id).sort().join(',')}` : ''
})
// 「后端设置」的内核卡片自己就画着一条黄色冲突横幅:它在屏幕上时,右上角再弹一条是重复提示,
// 不弹,并把已经弹出来的关掉。卡片挂载时 +1、卸载时 -1,计数 > 0 即横幅可见。
const conflictBannerCount = ref(0)
export const useConflictBannerPresence = () => {
  onMounted(() => {
    conflictBannerCount.value += 1
  })
  onBeforeUnmount(() => {
    conflictBannerCount.value -= 1
  })
}

export const useKernelConflictToast = () => {
  const { t } = useI18n()
  useServiceStatusPolling()
  watch([conflictSignature, conflictBannerCount], ([next, banners], [prev]) => {
    if (banners > 0) {
      dismissNotification('proxy-conflict')
      return
    }
    if (!next || next === prev) return
    const names = (serviceStatus.value?.conflicts || []).map((c) => c.label).join(t('listSeparator'))
    showNotification({
      content: CONFLICT_TOAST_KEYS[conflictState.value],
      params: { names },
      key: 'proxy-conflict',
      type: 'alert-warning',
      timeout: 20000,
    })
  })
}

export const useKernelActions = () => {
  const { t } = useI18n()

  const runKernelAction = async (action: OpenboxServiceAction) => {
    if (pendingAction.value) return
    pendingAction.value = action
    const actionLabel = t(ACTION_LABEL_KEYS[action])
    try {
      const result = await runServiceAction(action)
      if (result.ok) {
        // 启动 / 重启带着耗时:重启慢不慢,一眼就看到,不用去翻 logread
        if (typeof result.durationMs === 'number') {
          showNotification({ content: 'kernelActionSucceededIn', params: { action: actionLabel, seconds: (result.durationMs / 1000).toFixed(1) }, type: 'alert-success' })
        } else {
          showNotification({ content: 'kernelActionSucceeded', params: { action: actionLabel }, type: 'alert-success' })
        }
        // 起来了但降过级(auto_redirect 起不来改纯 tun):单独一条黄色提示,多留一会儿让人看完
        if (result.warning) {
          showNotification({ content: 'kernelActionWarning', params: { detail: result.warning }, type: 'alert-warning', timeout: 20000 })
        }
      } else {
        // 这台开发机没有 /etc/init.d,ok:false 且 stderr 为空是常态:没细节时至少给个退出码
        const detail = result.stderr.trim() || t('kernelActionNoDetail', { code: String(result.code) })
        showNotification({ content: 'kernelActionFailed', params: { action: actionLabel, detail }, type: 'alert-error' })
      }
    } catch (error) {
      showNotification({
        content: 'kernelActionRequestFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        type: 'alert-error',
      })
    } finally {
      // 动作返回后状态可能还在切换(stop 由 procd 异步收尾、start 后 status 需要片刻),
      // 轮询到目标状态为止(最多 6 秒)再放开按钮,否则用户看到「运行中」会再点一遍。
      await waitForState(action)
      pendingAction.value = null
    }
  }

  const EXPECTED: Partial<Record<OpenboxServiceAction, (s: OpenboxServiceStatus) => boolean>> = {
    start: (s) => s.core.running,
    restart: (s) => s.core.running,
    stop: (s) => !s.core.running,
    enable: (s) => s.core.autostart === true,
    disable: (s) => s.core.autostart === false,
  }
  const waitForState = async (action: OpenboxServiceAction) => {
    const expect = EXPECTED[action]
    const deadline = Date.now() + 6000
    for (;;) {
      await refreshServiceStatus()
      if (!expect || (serviceStatus.value && expect(serviceStatus.value)) || Date.now() >= deadline) return
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    }
  }

  return { runKernelAction }
}

// 「1天2小时3分钟」:为 0 的高位不显示;不足一分钟单独说;没在跑显示 —
export const formatUptime = (seconds: number | null | undefined, t: (key: string) => string) => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const parts: string[] = []
  if (days) parts.push(`${days}${t('unitDay')}`)
  if (days || hours) parts.push(`${hours}${t('unitHour')}`)
  parts.push(`${minutes}${t('unitMinute')}`)
  if (!days && !hours && !minutes) return t('uptimeUnderMinute')
  return parts.join('')
}
export const kernelUptimeText = (t: (key: string) => string) =>
  serviceStatus.value?.core.running ? formatUptime(serviceStatus.value.core.uptimeSeconds, t) : '—'
