<template>
  <!-- DNS 上游:直连侧 / 代理侧各一个主上游加最多 3 个备用上游。只收 IP 或「上游 DNS」记号 wan,协议只有 UDP / TCP。
       保存前先用内核真的查一次(api/dns-upstream-test.mjs);改动写进档案,重启内核后生效。
       字段和校验规则对照 server/engine/dns-upstream.mjs、server/api/profile.mjs。 -->
  <section class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4 text-sm">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h2 class="text-base font-semibold">{{ $t('dnsUpTitle') }}</h2>
          <p class="text-base-content/60 text-xs">{{ $t('dnsUpDescription') }}</p>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <span
            v-if="regionPending"
            class="text-base-content/60 flex items-center gap-1 text-xs"
          >
            <span class="loading loading-spinner loading-xs" />{{ $t('dnsUpRegionPending') }}
          </span>
          <div
            class="join"
            role="group"
            :aria-label="$t('dnsUpRegion')"
          >
            <button
              v-for="r in REGIONS"
              :key="r"
              type="button"
              class="btn btn-sm join-item"
              :class="draft.region === r ? 'btn-primary' : 'btn-ghost border-base-300'"
              :aria-pressed="draft.region === r"
              :disabled="saving"
              @click="setRegion(r)"
            >
              {{ $t(r === 'cn' ? 'dnsUpRegionCn' : 'dnsUpRegionIntl') }}
            </button>
          </div>
        </div>
      </div>
      <p class="text-base-content/50 text-xs">{{ $t('dnsUpRegionHint') }}</p>

      <div
        v-for="side in SIDES"
        :key="side"
        class="border-base-300/50 flex flex-col gap-2 border-t pt-3"
      >
        <div>
          <h3 class="font-medium">{{ $t(side === 'direct' ? 'dnsUpDirect' : 'dnsUpProxy') }}</h3>
          <p class="text-base-content/50 text-xs">
            {{ $t(side === 'direct' ? 'dnsUpDirectNote' : 'dnsUpProxyNote') }}
          </p>
        </div>
        <div
          v-for="(row, index) in rows(side)"
          :key="row.id"
          class="flex flex-col gap-1"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-base-content/60 w-16 shrink-0 text-xs">
              {{ $t(index === 0 ? 'dnsUpPrimary' : 'dnsUpExtra') }}
            </span>
            <label
              class="flex items-center gap-1.5 text-xs"
              :class="wanDisabled(side) && !isWan(row.u) && 'opacity-50'"
              :title="wanDisabled(side) ? $t('dnsUpErrWanCn') : ''"
            >
              <input
                type="checkbox"
                class="toggle toggle-xs"
                :checked="isWan(row.u)"
                :disabled="saving || (wanDisabled(side) && !isWan(row.u))"
                @change="toggleWan(row.u, ($event.target as HTMLInputElement).checked)"
              />
              {{ $t('dnsUpWan') }}
            </label>
            <input
              v-if="!isWan(row.u)"
              v-model="row.u.server"
              class="input input-sm w-48 font-mono"
              :class="row.u.server.trim() && !isIp(row.u.server) && 'input-error'"
              :placeholder="$t('dnsUpServerPlaceholder')"
              :aria-label="$t('dnsUpServer')"
              :disabled="saving"
              maxlength="64"
              spellcheck="false"
              @input="clearTest(row.id)"
            />
            <span
              v-else
              class="text-base-content/60 text-xs"
              >{{ wanText }}</span
            >
            <select
              v-model="row.u.protocol"
              class="select select-sm w-24"
              :aria-label="$t('dnsUpProtocol')"
              :disabled="saving || isWan(row.u)"
              @change="clearTest(row.id)"
            >
              <option value="udp">UDP</option>
              <option value="tcp">TCP</option>
            </select>
            <input
              v-model.number="row.u.port"
              type="number"
              min="1"
              max="65535"
              class="input input-sm w-24 tabular-nums"
              :class="!isWan(row.u) && !isPort(row.u.port) && 'input-error'"
              :aria-label="$t('dnsUpPort')"
              :disabled="saving || isWan(row.u)"
              @input="clearTest(row.id)"
            />
            <button
              type="button"
              class="btn btn-sm"
              :disabled="saving || testing(row.id)"
              @click="runTest(side, row.id, row.u)"
            >
              <span
                v-if="testing(row.id)"
                class="loading loading-spinner loading-xs"
              />
              {{ $t(testing(row.id) ? 'dnsUpTesting' : 'dnsUpTest') }}
            </button>
            <button
              v-if="index > 0"
              type="button"
              class="btn btn-ghost btn-sm hover:text-error"
              :disabled="saving"
              @click="removeExtra(side, index - 1)"
            >
              {{ $t('dnsUpRemove') }}
            </button>
          </div>
          <p
            v-if="testLine(row.id)"
            class="pl-16 text-xs break-words"
            :class="testLine(row.id)?.cls"
            role="status"
          >
            {{ testLine(row.id)?.text }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="saving || draft[side].extras.length >= MAX_EXTRAS"
            @click="addExtra(side)"
          >
            {{ $t('dnsUpAddExtra') }}
          </button>
          <span class="text-base-content/50 text-xs">{{ $t('dnsUpExtraHint', { max: MAX_EXTRAS }) }}</span>
        </div>
      </div>

      <p
        v-if="formError"
        class="text-error text-xs"
        role="alert"
      >
        {{ formError }}
      </p>
      <div
        v-if="failed.length"
        role="alert"
        class="alert alert-warning alert-soft flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
      >
        <span>{{ $t('dnsUpTestFailedBeforeSave', { list: failed.join('、') }) }}</span>
        <button
          type="button"
          class="btn btn-warning btn-xs"
          :disabled="saving"
          @click="save(true)"
        >
          {{ $t('dnsUpSaveAnyway') }}
        </button>
      </div>
      <div class="border-base-300/50 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <span class="text-base-content/50 text-xs">{{ dirty ? $t('dnsUpDirty') : '' }}</span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="saving || restoring"
            @click="restoreDefaults"
          >
            <span
              v-if="restoring"
              class="loading loading-spinner loading-xs"
            />
            {{ $t('dnsUpRestore') }}
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="saving || !dirty"
            @click="save(false)"
          >
            <span
              v-if="saving"
              class="loading loading-spinner loading-xs"
            />
            {{ $t('save') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  detectDnsRegion,
  fetchDnsRegionState,
  fetchProfile,
  fetchWanDns,
  testDnsUpstream,
  type OpenboxDnsUpstreamTestResult,
  type OpenboxProfile,
} from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

type Region = 'cn' | 'intl'
type Side = 'direct' | 'proxy'
type Protocol = 'udp' | 'tcp'
interface Upstream {
  server: string
  protocol: Protocol
  port: number
}
interface SideDraft {
  main: Upstream
  extras: Upstream[]
}
interface Draft {
  region: Region
  direct: SideDraft
  proxy: SideDraft
}
interface TestState {
  status: 'running' | 'ok' | 'fail'
  result?: OpenboxDnsUpstreamTestResult
  error?: string
}

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()
// DNS 上游改了要重启内核才生效:保存后告诉页面挂出「立即重启内核」
const emit = defineEmits<{ needsRestart: [] }>()
const { t } = useI18n()

// 下面这些常量和校验照抄 server/engine/dns-upstream.mjs;服务端那份才是准绳,这里只为在请求发出去之前挡掉明显的错
const WAN = 'wan'
const DEFAULT_PORT = 53
const MAX_EXTRAS = 3
const REGIONS: Region[] = ['cn', 'intl']
const SIDES: Side[] = ['direct', 'proxy']
// 备用上游档案里没写协议时,服务端按这一侧的默认协议补(直连 udp / 代理 tcp)
const FALLBACK_PROTOCOL: Record<Side, Protocol> = { direct: 'udp', proxy: 'tcp' }
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const IPV6_RE = /^[0-9a-f:]+$/i

const isIp = (value: string) => {
  const host = String(value ?? '').trim()
  if (!host) return false
  if (IPV4_RE.test(host)) return host !== '0.0.0.0'
  if (!host.includes(':')) return false
  return IPV6_RE.test(host) && host !== '::' && host.split('::').length <= 2 && host.split(':').length <= 8
}
const isPort = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
const isWan = (u: Upstream) => u.server === WAN
const wanUpstream = (): Upstream => ({ server: WAN, protocol: 'udp', port: DEFAULT_PORT })

// 两个地区的默认(regionDnsDefaults):中国大陆——直连用上游 DNS,代理走 TCP 1.1.1.1;中国大陆之外——两侧都用上游 DNS
const regionDefaults = (region: Region): Draft => ({
  region,
  direct: { main: wanUpstream(), extras: [] },
  proxy: {
    main: region === 'intl' ? wanUpstream() : { server: '1.1.1.1', protocol: 'tcp', port: DEFAULT_PORT },
    extras: [],
  },
})

const readUpstream = (server: unknown, protocol: unknown, port: unknown, fallback: Protocol): Upstream => {
  const wan = server === WAN
  return {
    server: typeof server === 'string' ? server : '',
    protocol: wan ? 'udp' : protocol === 'udp' || protocol === 'tcp' ? protocol : fallback,
    port: wan ? DEFAULT_PORT : typeof port === 'number' && Number.isInteger(port) ? port : DEFAULT_PORT,
  }
}
const readExtras = (list: unknown, fallback: Protocol): Upstream[] =>
  Array.isArray(list)
    ? list.slice(0, MAX_EXTRAS).map((item) => {
        const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
        return readUpstream(o.server, o.protocol, o.port, fallback)
      })
    : []

const fromProfile = (profile: OpenboxProfile): Draft => {
  const dns = profile.dns ?? {}
  return {
    region: dns.region === 'intl' ? 'intl' : 'cn',
    direct: {
      main: readUpstream(dns.direct, dns.directProtocol, dns.directPort, 'udp'),
      extras: readExtras(dns.directExtras, 'udp'),
    },
    proxy: {
      main: readUpstream(dns.proxy, dns.proxyProtocol, dns.proxyPort, 'tcp'),
      extras: readExtras(dns.proxyExtras, 'tcp'),
    },
  }
}

const outUpstream = (u: Upstream): Upstream =>
  isWan(u) ? wanUpstream() : { server: u.server.trim(), protocol: u.protocol, port: u.port }
const toPatch = (d: Draft) => {
  const direct = outUpstream(d.direct.main)
  const proxy = outUpstream(d.proxy.main)
  return {
    region: d.region,
    direct: direct.server,
    directProtocol: direct.protocol,
    directPort: direct.port,
    directExtras: d.direct.extras.map(outUpstream),
    proxy: proxy.server,
    proxyProtocol: proxy.protocol,
    proxyPort: proxy.port,
    proxyExtras: d.proxy.extras.map(outUpstream),
  }
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const draft = ref<Draft>(fromProfile(props.profile))
// 上一次从档案读到(或保存成功)的样子:是否有未保存的修改、哪些上游是新改的,都拿它比
const baseline = ref<Draft>(clone(draft.value))
const dirty = computed(() => JSON.stringify(toPatch(draft.value)) !== JSON.stringify(toPatch(baseline.value)))
const adopt = (profile: OpenboxProfile) => {
  draft.value = fromProfile(profile)
  baseline.value = clone(draft.value)
}
// 档案被别处改了(比如页面重新加载)且这里没有未保存的修改时,跟着换
watch(
  () => props.profile,
  (profile) => {
    if (!dirty.value) adopt(profile)
  },
)

const saving = ref(false)
const restoring = ref(false)
const formError = ref('')
const failed = ref<string[]>([])
const tests = reactive<Record<string, TestState>>({})
const wanServers = ref<string[]>([])
const wanText = computed(() =>
  wanServers.value.length
    ? t('dnsUpWanNow', { servers: wanServers.value.join('、') })
    : t('dnsUpWanNone'),
)

const rows = (side: Side) => [
  { id: `${side}-main`, u: draft.value[side].main },
  ...draft.value[side].extras.map((u, i) => ({ id: `${side}-${i}`, u })),
]
// 路由器在中国大陆时代理侧不能用上游 DNS:中国大陆的 DNS 对境外域名有污染(服务端 regionDnsError 也会拒)
const wanDisabled = (side: Side) => side === 'proxy' && draft.value.region === 'cn'

const clearTest = (id: string) => {
  delete tests[id]
  failed.value = []
}
const clearSideTests = (side: Side) => {
  for (const key of Object.keys(tests)) if (key.startsWith(`${side}-`)) delete tests[key]
  failed.value = []
}
const testing = (id: string) => tests[id]?.status === 'running'

const setRegion = (region: Region) => {
  if (region === draft.value.region) return
  draft.value = regionDefaults(region)
  formError.value = ''
  failed.value = []
  for (const key of Object.keys(tests)) delete tests[key]
}
const toggleWan = (u: Upstream, on: boolean) => {
  if (on) Object.assign(u, wanUpstream())
  else Object.assign(u, { server: wanServers.value[0] ?? '', protocol: u.protocol, port: DEFAULT_PORT })
  failed.value = []
}
const addExtra = (side: Side) => {
  if (draft.value[side].extras.length >= MAX_EXTRAS) return
  draft.value[side].extras.push({ server: '', protocol: FALLBACK_PROTOCOL[side], port: DEFAULT_PORT })
  clearSideTests(side)
}
const removeExtra = (side: Side, index: number) => {
  draft.value[side].extras.splice(index, 1)
  clearSideTests(side)
}

const runTest = async (side: Side, id: string, u: Upstream): Promise<TestState> => {
  formError.value = ''
  if (!isWan(u)) {
    if (!isIp(u.server)) {
      tests[id] = { status: 'fail', error: t('dnsUpErrIp') }
      return tests[id]
    }
    if (!isPort(u.port)) {
      tests[id] = { status: 'fail', error: t('dnsUpErrPort') }
      return tests[id]
    }
  }
  tests[id] = { status: 'running' }
  try {
    const result = await testDnsUpstream(
      isWan(u)
        ? { side, server: WAN, protocol: 'udp' }
        : { side, server: u.server.trim(), protocol: u.protocol, port: u.port },
    )
    tests[id] = { status: result.ok ? 'ok' : 'fail', result }
  } catch (error) {
    tests[id] = { status: 'fail', error: error instanceof Error ? error.message : String(error) }
  }
  return tests[id]
}
const testLine = (id: string): { cls: string; text: string } | null => {
  const state = tests[id]
  if (!state || state.status === 'running') return null
  if (state.status === 'fail') {
    return { cls: 'text-error', text: t('dnsUpTestFail', { error: state.result?.error || state.error || '' }) }
  }
  const r = state.result as OpenboxDnsUpstreamTestResult
  const parts = [t('dnsUpTestOk', { ms: r.ms, server: r.server })]
  const route = r.chain?.length ? r.chain.join(' → ') : r.via
  if (route) parts.push(t('dnsUpTestVia', { via: route }))
  if (r.warning) parts.push(r.warning)
  return { cls: r.warning ? 'text-warning' : 'text-success', text: parts.join(' · ') }
}

// 返回第一条不合规的说明,没问题返回空串
const validate = (): string => {
  for (const side of SIDES) {
    const list = [draft.value[side].main, ...draft.value[side].extras]
    const keys: string[] = []
    for (const u of list) {
      if (!isWan(u)) {
        if (!isIp(u.server)) return t('dnsUpErrIp')
        if (!isPort(u.port)) return t('dnsUpErrPort')
      }
      keys.push(isWan(u) ? WAN : u.server.trim().toLowerCase())
    }
    if (new Set(keys).size !== keys.length) return t('dnsUpErrDup')
    if (wanDisabled(side) && keys.includes(WAN)) return t('dnsUpErrWanCn')
  }
  return ''
}

const entryKey = (side: Side, u: Upstream) => `${side}|${isWan(u) ? WAN : u.server.trim()}|${u.protocol}|${u.port}`
// 保存前只测新改的上游:和上次保存的一模一样的不重复测
const testChanged = async (): Promise<string[]> => {
  const known = new Set(
    SIDES.flatMap((side) => [baseline.value[side].main, ...baseline.value[side].extras].map((u) => entryKey(side, u))),
  )
  const bad: string[] = []
  for (const side of SIDES) {
    for (const row of rows(side)) {
      if (known.has(entryKey(side, row.u))) continue
      const state = await runTest(side, row.id, row.u)
      if (state.status === 'fail') bad.push(isWan(row.u) ? t('dnsUpWan') : row.u.server.trim())
    }
  }
  return bad
}

const save = async (force: boolean) => {
  const error = validate()
  formError.value = error
  if (error) return
  saving.value = true
  try {
    if (!force) {
      failed.value = await testChanged()
      if (failed.value.length) return
    }
    await props.patchProfile({ dns: toPatch(draft.value) })
    baseline.value = clone(draft.value)
    failed.value = []
    showNotification({ content: 'dnsUpSaved', type: 'alert-success' })
    emit('needsRestart')
  } catch (err) {
    showNotification({
      content: 'routingSaveFailed',
      params: { message: err instanceof Error ? err.message : String(err) },
      type: 'alert-error',
    })
  } finally {
    saving.value = false
  }
}

// 恢复默认:先按出口公网 IP 判一次路由器在哪,再把两侧换成那个地区的默认;判不出来就按页面上现在选的地区
const restoreDefaults = async () => {
  restoring.value = true
  try {
    let region = draft.value.region
    let detected = false
    try {
      const result = await detectDnsRegion()
      if (result.region) {
        region = result.region
        detected = true
      }
    } catch {
      /* 判不出来按当前地区 */
    }
    draft.value = regionDefaults(region)
    formError.value = ''
    failed.value = []
    for (const key of Object.keys(tests)) delete tests[key]
    const name = t(region === 'cn' ? 'dnsUpRegionCn' : 'dnsUpRegionIntl')
    showNotification({
      content: detected ? 'dnsUpRestored' : 'dnsUpDetectFailed',
      params: { region: name },
      type: detected ? 'alert-success' : 'alert-warning',
    })
  } finally {
    restoring.value = false
  }
}

// 启动时那次后台判地区还没做完就显示「正在判断」,隔几秒问一次;做完了且这里没有未保存的修改,重新读档案
const regionPending = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | undefined
let wasPending = false
let disposed = false
const pollRegion = async () => {
  try {
    const state = await fetchDnsRegionState()
    if (disposed) return
    regionPending.value = state.pending
    if (state.pending) {
      wasPending = true
      pollTimer = setTimeout(pollRegion, 3000)
      return
    }
    if (wasPending && !dirty.value) adopt(await fetchProfile())
  } catch {
    regionPending.value = false
  }
}

onMounted(() => {
  fetchWanDns()
    .then((servers) => {
      wanServers.value = servers
    })
    .catch(() => {})
  void pollRegion()
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(pollTimer)
})
</script>
