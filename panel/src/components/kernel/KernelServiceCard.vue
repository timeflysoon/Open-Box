<template>
  <!-- 顶部总卡片:标识 / 平台 / 版本 / 状态 / 启停 / 更新 都在这一张里 -->
  <div class="kernel-top card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4 text-sm">
      <!-- 标题行:Open-Box 标识 + 版本号;右边是需要注意的提示和「恢复出厂设置」 -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <a
          href="https://github.com/timeflysoon/Open-Box"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:bg-base-200 inline-flex cursor-pointer items-center gap-2 rounded-lg py-1"
          aria-label="Open-Box GitHub"
        >
          <img
            :src="logoUrl"
            class="app-logo h-6 w-auto"
            alt="Open-Box"
          />
          <span
            v-if="openboxVersion"
            class="font-mono text-base"
          >{{ openboxVersion }}</span>
          <GithubIcon class="h-5 w-5" />
          <span class="text-base">GitHub</span>
          <ArrowTopRightOnSquareIcon class="text-base-content/50 h-4 w-4" />
        </a>
        <div class="ml-auto flex items-center gap-2">
          <!-- 「系统提示」铃铛(上游 v0.1.499):没有告警时禁用并淡显,有告警时按最高等级着色 + 数字徽标;
               点开是高对比度汇总弹窗。位置与上游一致:后端设置顶部工具栏靠右。 -->
          <div
            class="inline-flex"
            :class="alerts.length === 0 ? 'cursor-not-allowed' : ''"
          >
            <button
              type="button"
              class="btn btn-ghost btn-circle btn-sm relative"
              :class="
                alerts.length > 0
                  ? hasErrorAlert
                    ? 'system-alert-trigger system-alert-trigger-error'
                    : 'system-alert-trigger system-alert-trigger-warning'
                  : 'text-base-content/30 disabled:bg-transparent disabled:text-base-content/30 cursor-not-allowed'
              "
              :disabled="alerts.length === 0"
              :aria-label="alertsAriaLabel"
              aria-haspopup="dialog"
              @click="alertsOpen = true"
            >
              <BellIcon
                class="h-5 w-5"
                stroke-width="1.75"
                aria-hidden="true"
              />
              <span
                v-if="alerts.length > 0"
                class="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold shadow-sm"
                :class="hasErrorAlert ? 'system-alert-count-error' : 'system-alert-count-warning'"
              >{{ alerts.length > 99 ? '99+' : alerts.length }}</span>
            </button>
          </div>
          <FactoryResetButton />
        </div>
      </div>

      <SystemAlertsDialog
        v-model="alertsOpen"
        :alerts="alerts"
        :refreshing="alertsRefreshing"
        @refresh="refreshAlerts"
      />

      <!-- 平台:OpenWrt / Linux / Docker 三张卡,本机所在的那张高亮,其余灰底灰图标(与 v0.1.337 一致) -->
      <div
        v-if="serviceStatus"
        class="router-platform-tiles grid grid-cols-[repeat(auto-fill,minmax(min(19rem,100%),1fr))] app-card-gap"
      >
        <div
          v-for="p in platformCards"
          :key="p.id"
          class="@container/tile app-card-inset bg-base-100 border-base-300/60 rounded-lg border"
          :class="p.current && 'platform-tile-current'"
        >
          <span class="flex flex-col items-start gap-1.5 @min-[14rem]/tile:flex-row @min-[14rem]/tile:gap-2">
            <CountryFlag
              :code="p.icon"
              :size="32"
              class="shrink-0 @min-[14rem]/tile:mt-0.5"
              :class="!p.current && 'grayscale'"
            />
            <span class="flex max-w-full min-w-0 flex-col">
              <span class="flex max-w-full flex-wrap items-baseline gap-x-1.5">
                <span class="max-w-full truncate leading-5 font-medium">{{ p.title }}</span>
                <span
                  v-if="p.current && thisDevice"
                  class="text-base-content/60 max-w-full truncate text-xs leading-4 tabular-nums"
                >
                  <i18n-t
                    keypath="routerPlatformThisVersion"
                    tag="span"
                  >
                    <template #version>
                      <span class="text-base-content">{{ thisDeviceText }}</span>
                    </template>
                  </i18n-t>
                </span>
              </span>
              <span class="platform-tile-req text-base-content/50 text-xs leading-4 break-keep">{{ nbsp(p.req) }}</span>
            </span>
          </span>
        </div>
      </div>

      <div
        v-if="conflicts.length > 0"
        class="alert alert-warning flex items-start gap-2"
      >
        <ExclamationTriangleIcon class="mt-0.5 h-4 w-4 shrink-0" />
        <!-- 常驻说明与右上角提示同一段话(上游只有提示);只列名字,不再逐条重复 -->
        <span class="text-xs leading-relaxed">{{ $t(conflictToastKey, { names: conflictNamesText }) }}</span>
      </div>

      <!-- 内核切换 + 当前内核版本 + 内核项目链接。上游 v0.1.488 的样子是:一行 flex-wrap,
           里面依次是「内核切换:[选择框] 未包含 Mihomo。」「(图标) 未知」「sing-box GitHub」;
           「内核版本:」这行标签在上游是给读屏用的(sr-only),界面上不显示——这一点 v0.1.488 的
           发布包实测过,只看得见图标和版本号。 -->
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <!-- 内核切换(sing-box / Mihomo),由内核页传进来 -->
        <slot name="kernel-controls" />
        <span class="inline-flex items-center gap-2">
          <CpuChipIcon class="text-base-content/60 h-4 w-4 shrink-0" />
          <span class="sr-only">{{ $t('kernelVersionLabel') }}:</span>
          <span class="inline-flex items-center gap-1.5 font-medium">
            <!-- 内核读不到版本时上游不画内核图标(只留 CPU 图标 + 「未知」),这里跟着不画 -->
            <KernelIcon
              v-if="kernelIconVisible"
              :kernel="kernelName"
            />
            {{ kernelText }}
          </span>
        </span>
        <a
          :href="kernelGithubUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-base-content/70 hover:text-primary inline-flex items-center gap-1.5 rounded-md px-1 py-0.5"
          :aria-label="kernelGithubLabel"
        >
          <GithubIcon class="h-4 w-4" />
          <span>{{ kernelGithubLabel }}</span>
          <ArrowTopRightOnSquareIcon class="h-4 w-4" />
        </a>
      </div>

      <!-- Geo 数据链接:上游这一行常显(没有份数/日期时也照常显示链接),单独占一行 -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span
          v-if="updateInfo?.geoCounts"
          class="flex items-center gap-2"
        >
          <MapIcon class="text-base-content/60 h-4 w-4 shrink-0" />
          <span class="text-base-content/60">{{ $t('geoSiteCount', { count: updateInfo.geoCounts.geosite }) }}</span>
        </span>
        <span
          v-if="updateInfo?.geoCounts"
          class="flex items-center gap-2"
        >
          <CircleStackIcon class="text-base-content/60 h-4 w-4 shrink-0" />
          <span class="text-base-content/60">{{ $t('geoIpCount', { count: updateInfo.geoCounts.geoip }) }}</span>
        </span>
        <span
          v-if="updateInfo?.geoDate"
          class="text-base-content/60"
        >{{ updateInfo.geoDate }}</span>
        <a
          href="https://github.com/MetaCubeX/meta-rules-dat/tree/sing/geo"
          target="_blank"
          rel="noopener noreferrer"
          class="text-base-content/60 hover:text-primary inline-flex items-center gap-1.5 rounded-md px-1 py-0.5"
          :aria-label="$t('geoGithubLabel')"
        >
          <GithubIcon class="h-4 w-4" />
          <span>{{ $t('geoGithubLabel') }}</span>
          <ArrowTopRightOnSquareIcon class="h-4 w-4" />
        </a>
      </div>

      <div class="bg-base-content/10 h-px" />

      <!-- 内核 / 面板 / 开机自启三项状态放同一行,标签用全局统一的 StatusBadge -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div class="flex items-center gap-2">
          <span class="font-medium">{{ $t('kernelCoreLabel') }}</span>
          <StatusBadge
            v-if="serviceStatus"
            :on="serviceStatus.core.running"
            :on-text="$t('kernelStatusRunning')"
            :off-text="$t('kernelStatusStopped')"
          />
          <span
            v-else
            class="badge badge-sm"
          >—</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium">{{ $t('kernelPanelLabel') }}</span>
          <StatusBadge
            v-if="serviceStatus"
            :on="serviceStatus.panel.running"
            :on-text="$t('kernelStatusRunning')"
            :off-text="$t('kernelStatusStopped')"
          />
          <span
            v-else
            class="badge badge-sm"
          >—</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium">{{ $t('kernelAutostartLabel') }}</span>
          <StatusBadge
            v-if="serviceStatus"
            :on="Boolean(serviceStatus.core.autostart)"
            :on-text="$t('kernelAutostartOn')"
            :off-text="$t('kernelAutostartOff')"
          />
          <span
            v-else
            class="badge badge-sm"
          >—</span>
        </div>
      </div>

      <!-- 启动/重启 = 用当前设置重新生成配置并应用(server/api/service.mjs),
           所以界面上没有单独的「部署」按钮:各设置页保存完,来这里启动一下就生效。 -->
      <p class="text-base-content/60 text-xs">{{ $t('kernelApplyHint') }}</p>

      <!-- 一行:[启动] [停止] [重启]。开机自启不单独给按钮:启动 / 重启成功即打开自启,停止即关闭
           (server/api/service.mjs 与 deploy-runner.mjs),上面的状态标签只是展示。
           互斥:内核在跑就不能再「启动」,没在跑就不能「停止/重启」;有动作进行中时全部禁用。 -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn btn-sm"
          :disabled="isStartDisabled"
          @click="runKernelAction('start')"
        >
          <span
            v-if="pendingAction === 'start'"
            class="loading loading-spinner loading-xs"
          />
          <PlayIcon
            v-else
            class="h-4 w-4"
          />
          {{ $t('kernelActionStart') }}
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="isStopDisabled"
          @click="runKernelAction('stop')"
        >
          <span
            v-if="pendingAction === 'stop'"
            class="loading loading-spinner loading-xs"
          />
          <StopIcon
            v-else
            class="h-4 w-4"
          />
          {{ $t('kernelActionStop') }}
        </button>
        <KernelRestartButton />
        <!-- 上游 v0.1.494:把「检查更新」并到「重启」后面,用分隔线隔开,布局更紧凑 -->
        <template v-if="profile && patchProfile">
          <div class="bg-base-content/20 h-5 w-px" />
          <button
            type="button"
            class="btn btn-sm"
            :disabled="updateCard?.checking"
            @click="updateCard?.check()"
          >
            <span
              v-if="updateCard?.checking"
              class="loading loading-spinner loading-xs"
            />
            {{ $t('obUpdateCheck') }}
          </button>
        </template>
      </div>

      <!-- Open-Box 更新:通道 / 检查更新 / 自动更新(档案还在加载时先不显示) -->
      <template v-if="profile && patchProfile">
        <div class="bg-base-content/10 h-px" />
        <OpenboxUpdateCard
          ref="updateCard"
          embedded
          hide-check
          :profile="profile"
          :patch-profile="patchProfile"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {
  OpenboxFailoverStatus,
  OpenboxKernelVersion,
  OpenboxProfile,
  OpenboxServiceStatus,
  OpenboxSubscription,
} from '@/api/openbox'
import { fetchFailoverStatus, fetchSubscriptions } from '@/api/openbox'
import CountryFlag from '@/components/common/CountryFlag.vue'
import GithubIcon from '@/components/common/GithubIcon.vue'
import KernelIcon from '@/components/kernel/KernelIcon.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import FactoryResetButton from '@/components/kernel/FactoryResetButton.vue'
import SystemAlertsDialog from '@/components/kernel/SystemAlertsDialog.vue'
import { useSystemAlerts } from '@/composables/systemAlerts'
import KernelRestartButton from '@/components/kernel/KernelRestartButton.vue'
import OpenboxUpdateCard from '@/components/kernel/OpenboxUpdateCard.vue'
import {
  conflictNames,
  conflictToastKey,
  isStartDisabled,
  isStopDisabled,
  pendingAction,
  serviceStatus,
  useConflictBannerPresence,
  useKernelActions,
} from '@/composables/kernelService'
import { refreshUpdateInfo, updateInfo } from '@/composables/openboxUpdate'
import { DARK_THEME, theme } from '@/store/settings'
import logoUrl from '@/assets/logo.png'
import {
  ArrowTopRightOnSquareIcon,
  CircleStackIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  MapIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/vue/24/outline'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

// 「系统提示」铃铛:数据全部来自已有接口(服务状态 / 故障转移状态 / 订阅列表 / 更新状态),
// 不新增后端接口(与上游同一口径)。点「刷新」时把这几个源重新拉一遍。
const alertsOpen = ref(false)
const alertsRefreshing = ref(false)
const failoverStatusForAlerts = ref<OpenboxFailoverStatus | null>(null)
const subscriptionsForAlerts = ref<OpenboxSubscription[]>([])
const subscriptionsError = ref<string | null>(null)

const loadAlertSources = async () => {
  const [fo, subs] = await Promise.allSettled([fetchFailoverStatus(), fetchSubscriptions()])
  if (fo.status === 'fulfilled') {
    failoverStatusForAlerts.value = fo.value
  }
  if (subs.status === 'fulfilled') {
    subscriptionsForAlerts.value = subs.value ?? []
    subscriptionsError.value = null
  } else {
    subscriptionsError.value = subs.reason instanceof Error ? subs.reason.message : String(subs.reason)
  }
}

const refreshAlerts = async () => {
  if (alertsRefreshing.value) return
  alertsRefreshing.value = true
  try {
    await Promise.all([loadAlertSources(), refreshUpdateInfo()])
  } finally {
    alertsRefreshing.value = false
  }
}

onMounted(() => {
  void loadAlertSources()
})

// 探测压力明细要按组列出「组名(类型 · N 节点 · 间隔)」:从故障转移状态的各组页签里
// 汇总出每个组的有效成员数与检测参数(与上游同口径:按组名去重,取该组所有页签的有效节点数之和)。
const alertGroupStats = computed(() => {
  const members: Record<string, number> = {}
  const info: Record<string, { type?: string; interval?: string }> = {}
  const fo = failoverStatusForAlerts.value
  for (const g of fo?.groups ?? []) {
    const name = g.tag || g.id
    if (!name) continue
    const total = (g.lanes ?? []).reduce((n, l) => n + (l.valid?.length ?? 0), 0)
    members[name] = (members[name] ?? 0) + total
    if (!info[name]) {
      // 页签类型取第一个页签的模式(urltest / selector),间隔取组的检测间隔
      info[name] = { type: g.lanes?.[0]?.mode || 'urltest', interval: g.settings?.interval || '' }
    }
  }
  return { members, info }
})

const { alerts, hasErrorAlert } = useSystemAlerts(() => ({
  serviceStatus: props.status,
  kernelVersion: props.kernelVersion,
  failoverStatus: failoverStatusForAlerts.value,
  membersByGroup: alertGroupStats.value.members,
  groupInfo: alertGroupStats.value.info,
  subscriptions: subscriptionsForAlerts.value,
  subscriptionsError: subscriptionsError.value,
  updateError: null,
  now: Date.now(),
}))

const alertsAriaLabel = computed(() =>
  alerts.value.length > 0
    ? t('systemAlertsCount', { count: alerts.value.length })
    : t('systemAlertsEmpty'),
)

// 本卡片自带冲突横幅:在屏幕上时不再弹右上角的冲突提示
useConflictBannerPresence()

// Geo 数据、安装通道都来自更新状态(同卡的更新区也会拉;这里没有就自己拉一次)
onMounted(() => {
  if (!updateInfo.value) void refreshUpdateInfo()
})

// status 仍作为 prop 保留给页面传入(刷新时序由页面掌握),卡片本身只读共享状态
const props = defineProps<{
  status: OpenboxServiceStatus | null
  kernelVersion: OpenboxKernelVersion | null
  profile?: OpenboxProfile | null
  patchProfile?: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

const emit = defineEmits<{
  refresh: []
}>()

// 状态标签和按钮读的是同一份共享状态(composables/kernelService.ts):页面自己再拿一份
// 会分叉——在侧边栏点停止、内核被外部停掉时标签不跟着变;直接往共享状态里写又绕过了
// refreshSeq,旧响应能把新状态盖回去。

const { runKernelAction: run } = useKernelActions()

// 「检查更新」按钮挪到重启按钮旁边后,要拿到更新卡里的 checking / check()
type UpdateCardApi = { checking?: boolean; check: () => void | Promise<void> }
const updateCard = ref<UpdateCardApi | null>(null)
const runKernelAction = async (action: Parameters<typeof run>[0]) => {
  await run(action)
  emit('refresh')
}

// Open-Box 自己的版本号(来自更新状态,发布版显示成 v0.1.488 这种)。
// 上游只在版本号以数字开头时补 v:源码构建报的是 "dev",界面上就原样显示 dev(实测 v0.1.488
// 的发布包 + version=dev 的后端,标题行是 "dev" 而不是 "vdev")。
const openboxVersion = computed(() => {
  const raw = (updateInfo.value?.version || '').trim()
  if (!raw) return ''
  const bare = raw.replace(/^v/i, '')
  return /^\d/.test(bare) ? `v${bare}` : bare
})

// 内核版本:不管服务端读到的是「1.14.1-xxx」「sing-box version 1.14.1-xxx」还是「sing-box-1.14.1-xxx」,
// 界面统一写成「sing-box-1.14.1-xxx」(对齐上游 v0.1.396)
const kernelText = computed(() => {
  const raw = (props.kernelVersion?.ok === false ? '' : props.kernelVersion?.version) || updateInfo.value?.singboxVersion || ''
  if (props.kernelVersion?.kernel === 'mihomo') {
    // 「Mihomo Meta v1.19.0-openbox.2 …」界面写成「mihomo-1.19.0-openbox-2」(对齐上游 v0.1.477)
    const mihomoRaw = (props.kernelVersion?.ok === false ? '' : props.kernelVersion?.version) || ''
    const ver = mihomoRaw.match(/^Mihomo(?: Meta)?\s+v?(\d\S*)/i)?.[1]
    if (ver) return `mihomo-${ver.replace(/-openbox\.(\d+)(?=$|[+-])/i, '-openbox-$1')}`
    return mihomoRaw.trim() || t('kernelVersionUnknown')
  }
  const bare = raw.trim().replace(/^sing-box(?:\s+version)?[\s-]*/i, '')
  return bare ? `sing-box-${bare}` : t('kernelVersionUnknown')
})
// 内核项目链接:当前内核是 mihomo 就指向 MetaCubeX/mihomo,否则指向 sing-box;没报内核名按 sing-box
const kernelName = computed(() => props.kernelVersion?.kernel || 'sing-box')
// 内核版本是否真的读到了:读不到时上游连内核图标都不画(v0.1.488 发布包实测:只有一个 CPU
// 图标 + 「未知」)
const kernelIconVisible = computed(() => props.kernelVersion?.ok !== false && Boolean(props.kernelVersion?.version))
const kernelGithubUrl = computed(() =>
  kernelName.value === 'mihomo' ? 'https://github.com/MetaCubeX/mihomo' : 'https://github.com/SagerNet/sing-box',
)
const kernelGithubLabel = computed(() => t('kernelGithubLabel', { kernel: kernelName.value }))

// 冲突的代理工具读共享状态,不用页面传进来的那份快照:
// 快照只在进页面和点动作后更新,进页面时拿到 null,横幅就一直不出现
const conflicts = computed(() => serviceStatus.value?.conflicts ?? props.status?.conflicts ?? [])
// 横幅的措辞与右上角提示同源(上游只弹提示,横幅是自研的常驻版本);共享状态还没到就用页面传入的快照
const conflictNamesText = computed(() =>
  (conflictNames.value.length ? conflictNames.value : conflicts.value.map((c) => c.label)).join(t('listSeparator')),
)

// 本机系统:发行版名 + 版本 + 架构。osRelease 的形状随服务端版本不同,按几种常见写法读
const osName = computed(() => {
  const release = serviceStatus.value?.osRelease
  if (!release) return ''
  if (typeof release === 'string') return release
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = release[key]
      if (typeof value === 'string' && value) return value
    }
    return ''
  }
  const pretty = pick('prettyName', 'PRETTY_NAME', 'DISTRIB_DESCRIPTION')
  if (pretty) return pretty
  return [pick('name', 'NAME', 'DISTRIB_ID', 'id', 'ID'), pick('version', 'VERSION_ID', 'DISTRIB_RELEASE', 'versionId')]
    .filter(Boolean)
    .join(' ')
})
const thisDeviceText = computed(() => [osName.value, serviceStatus.value?.arch || ''].filter(Boolean).join(' · '))
const thisDevice = computed(() => thisDeviceText.value)
// 本机跑在哪种环境:openwrt / systemd(Linux)/ container(Docker);老服务端没有 platform 时按 openwrt 处理
const platformKind = computed(() => serviceStatus.value?.platform || 'openwrt')
// 「Ubuntu 22.04 / Debian 12 · x64 / arm64」里的空格换成不换行空格,窄卡片里只在「/」「·」处换行
const nbsp = (text: string) =>
  text
    .split(' · ')
    .map((part) => part.split(' / ').map((item) => item.replace(/ /g, '\u00a0')).join(' / '))
    .join(' · ')
const platformCards = computed(() => [
  {
    id: 'openwrt' as const,
    title: 'OpenWrt',
    icon: 'brand:openwrt',
    req: t('routerPlatformReqOpenwrt'),
    current: platformKind.value === 'openwrt',
  },
  {
    id: 'linux' as const,
    title: 'Linux',
    icon: theme.value === DARK_THEME ? 'brand:linux-color-light' : 'brand:linux-color',
    req: t('routerPlatformReqLinux'),
    current: platformKind.value === 'systemd',
  },
  {
    id: 'docker' as const,
    title: 'Docker',
    icon: 'brand:docker',
    req: 'Linux · x64 / arm64',
    current: platformKind.value === 'container',
  },
])
</script>
