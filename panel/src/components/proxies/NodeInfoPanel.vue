<template>
  <!-- 节点信息:上半是节点自己(协议 / 服务器 / 入口 IP / IPv6 / UDP),下半是经这个节点出去的出口
       (出口 IP / 属地 / ASN / IP 类型 / 风控值 / 是否原生 / 同网段设备)。两半各自查、各自失败。 -->
  <div
    class="node-info-pane grid content-start gap-x-2.5 overflow-y-auto pr-0.5 text-xs leading-4"
    :style="{ gridTemplateColumns: `minmax(${labelWidth}, max-content) minmax(0, 1fr)` }"
  >
    <div
      v-if="infoError"
      class="text-error col-span-2 break-all"
    >
      {{ infoError }}
    </div>
    <template v-else-if="info">
      <span class="opacity-60">{{ $t('nodeInfoProtocol') }}</span>
      <span class="break-all">{{ info.protocol.join(' · ') }}</span>
      <span class="opacity-60">{{ $t('nodeInfoServer') }}</span>
      <span class="break-all tabular-nums">{{ serverText }}</span>
      <template v-if="info.detour">
        <span class="opacity-60">{{ $t('nodeInfoUpstream') }}</span>
        <span class="break-all">{{ info.detour }}</span>
      </template>
      <span class="opacity-60">{{ $t('nodeInfoEntryIp') }}</span>
      <span class="flex min-w-0 flex-col gap-1">
        <span
          v-if="!entryIps.length"
          class="opacity-80"
        >
          {{ info.resolveError || $t('nodeInfoUnknown') }}
        </span>
        <span
          v-for="(ip, index) in entryIps"
          :key="ip"
          class="flex flex-wrap items-center gap-x-1"
        >
          <span class="break-all tabular-nums">{{ ip }}</span>
          <span
            v-if="index === 0 && entryCountry"
            class="flex items-center gap-1"
          >
            <CountryFlag
              :code="entryCountry"
              :size="12"
            />
            <span class="opacity-80">{{ countryLabel(entryCountry) }}</span>
          </span>
          <span
            v-else-if="index === 0 && entryLoading"
            class="loading loading-dots loading-xs opacity-60"
          ></span>
        </span>
      </span>
      <span class="opacity-60">IPv6</span>
      <span>{{ info.addresses.v6.length ? $t('nodeInfoHasIpv6') : $t('nodeInfoNoIpv6') }}</span>
      <span class="opacity-60">UDP</span>
      <span>{{ udp ? $t('nodeInfoSupported') : $t('nodeInfoUnsupported') }}</span>
    </template>
    <span
      v-else
      class="col-span-2 min-h-4"
    ></span>

    <div
      class="col-span-2 my-1.5 border-t"
      style="border-color: color-mix(in srgb, currentColor 18%, transparent)"
    ></div>

    <div
      v-if="exitLoading && !exit"
      class="col-span-2 flex items-center gap-1.5 opacity-80"
    >
      <span class="loading loading-spinner loading-xs"></span>
      {{ $t('nodeInfoQuerying') }}
    </div>
    <div
      v-else-if="exitError && !exit"
      class="col-span-2 flex items-start justify-between gap-2"
    >
      <span class="break-all opacity-80">{{ exitError }}</span>
      <button
        type="button"
        class="flex shrink-0 cursor-pointer items-center opacity-70 hover:opacity-100"
        :disabled="exitLoading"
        :title="$t('refresh')"
        @click="loadExit(true)"
      >
        <ArrowPathIcon
          class="h-3.5 w-3.5"
          :class="exitLoading && 'animate-spin'"
        />
      </button>
    </div>
    <template v-else-if="exit">
      <span class="opacity-60">{{ $t('nodeInfoExitIp') }}</span>
      <span class="break-all tabular-nums">{{ exit.ip }}</span>
      <template v-if="exit.ipv6 !== exit.ip">
        <span class="opacity-60">{{ $t('nodeInfoExitIpv6') }}</span>
        <span class="break-all tabular-nums">{{ exit.ipv6 || $t('nodeInfoNone') }}</span>
      </template>
      <span class="opacity-60">{{ $t('nodeInfoLocation') }}</span>
      <span class="flex min-w-0 items-start gap-1">
        <CountryFlag
          v-if="exit.country"
          class="mt-0.5 shrink-0"
          :code="exit.country"
          :size="12"
        />
        <span class="wrap-break-word">{{ locationText }}</span>
      </span>
      <span class="opacity-60">{{ $t('nodeInfoAsn') }}</span>
      <span class="wrap-break-word">{{ [exit.asn, exit.asnOwner].filter(Boolean).join(' · ') || '—' }}</span>
      <template
        v-for="row in exitRows"
        :key="row.key"
      >
        <span class="opacity-60">{{ row.label }}</span>
        <span
          class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2"
          :title="row.title"
        >
          <span :class="row.class">{{ row.value }}</span>
          <span class="text-[10px] opacity-50">{{ row.source }}</span>
        </span>
      </template>
      <div
        v-if="partialText"
        class="col-span-2 break-all opacity-60"
      >
        {{ partialText }}
      </div>
      <div class="col-span-2 mt-1 flex items-center justify-between gap-2 opacity-60">
        <span class="flex items-center gap-1 whitespace-nowrap tabular-nums">
          {{ $t('nodeInfoCheckedAt', { time: dayjs(exit.at).format('MM-DD HH:mm') }) }}
          <button
            type="button"
            class="flex cursor-pointer items-center hover:opacity-100"
            :disabled="exitLoading"
            :title="$t('refresh')"
            @click="loadExit(true)"
          >
            <ArrowPathIcon
              class="h-3 w-3"
              :class="exitLoading && 'animate-spin'"
            />
          </button>
        </span>
        <a
          class="flex items-center gap-0.5 whitespace-nowrap underline-offset-2 hover:underline hover:opacity-100"
          :href="`https://ping0.cc/ip/${encodeURIComponent(exit.ip)}`"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ $t('nodeInfoPing0') }}
          <ArrowTopRightOnSquareIcon class="h-3 w-3" />
        </a>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { fetchNodeEntryCountry, fetchNodeExit, fetchNodeInfo, type OpenboxNodeExit, type OpenboxNodeInfo } from '@/api/openbox'
import CountryFlag from '@/components/common/CountryFlag.vue'
import { countryName, findCountry } from '@/constant/countries'
import { ArrowPathIcon, ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline'
import dayjs from 'dayjs'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ name: string; udp?: boolean }>()
const { t, locale } = useI18n()

const info = ref<OpenboxNodeInfo | null>(null)
const infoError = ref('')
const entryCountry = ref('')
const entryLoading = ref(false)
const exit = ref<OpenboxNodeExit | null>(null)
const exitError = ref('')
const exitLoading = ref(false)

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

const entryIps = computed(() => (info.value ? [...info.value.addresses.v4, ...info.value.addresses.v6].slice(0, 3) : []))

const loadInfo = async () => {
  infoError.value = ''
  try {
    info.value = await fetchNodeInfo(props.name)
  } catch (err) {
    infoError.value = errorText(err)
    return
  }
  entryCountry.value = info.value.entryCountry
  // 服务端缓存里没有入口 IP 的国家时再单独问一次(要查库,比解析慢,所以不卡着上面那几行)
  if (entryCountry.value || !entryIps.value.length) return
  entryLoading.value = true
  try {
    entryCountry.value = (await fetchNodeEntryCountry(props.name)).country
  } catch {
    // 查不到就只是不显示国旗
  } finally {
    entryLoading.value = false
  }
}

const loadExit = async (refresh = false) => {
  if (exitLoading.value) return
  exitLoading.value = true
  exitError.value = ''
  try {
    exit.value = await fetchNodeExit(props.name, refresh)
  } catch (err) {
    exitError.value = errorText(err)
  } finally {
    exitLoading.value = false
  }
}

onMounted(() => {
  void loadInfo()
  void loadExit()
})

// 国家代码 → 当前语言的名字:表里有就用表里的,没有再让浏览器按语言翻
const countryLabel = (code: string) => {
  if (!code) return ''
  const known = findCountry(code)
  if (known) return countryName(known, locale.value)
  try {
    return new Intl.DisplayNames([locale.value], { type: 'region' }).of(code.toUpperCase()) || code
  } catch {
    return code
  }
}

const serverText = computed(() => {
  if (!info.value) return ''
  const host = info.value.server.includes(':') ? `[${info.value.server}]` : info.value.server
  return info.value.port ? `${host}:${info.value.port}` : host
})

// 标签列宽度:中文短、英文长,两种语言下值都对得齐
const labelWidth = computed(() => (locale.value.startsWith('zh') ? '4.25rem' : '5.25rem'))

const locationText = computed(() => {
  if (!exit.value) return ''
  const first = exit.value.location.split(' — ')[0].trim()
  return locale.value.startsWith('zh') && first ? first : countryLabel(exit.value.country) || first || '—'
})

const IP_TYPE_KEYS: Record<string, string> = {
  residential: 'ipTypeResidential',
  mobile: 'ipTypeMobile',
  business: 'ipTypeBusiness',
  hosting: 'ipTypeHosting',
}
const ipTypeText = computed(() => {
  const e = exit.value
  if (!e || !e.ipType) return '—'
  return [t(IP_TYPE_KEYS[e.ipType] ?? e.ipType), e.proxyType].filter(Boolean).join(' · ')
})

const riskLevel = computed(() => {
  const risk = exit.value?.risk
  if (risk == null) return ''
  return risk <= 33 ? 'low' : risk <= 66 ? 'mid' : 'high'
})
const riskText = computed(() => {
  const risk = exit.value?.risk
  if (risk == null) return '—'
  return `${risk} · ${t(riskLevel.value === 'low' ? 'riskLow' : riskLevel.value === 'mid' ? 'riskMid' : 'riskHigh')}`
})
// 类名要写全,Tailwind 只编它在源码里见过的类
const RISK_CLASS: Record<string, string> = { low: 'text-primary', mid: 'text-yellow-500', high: 'text-red-500' }

const nativeText = computed(() => {
  const e = exit.value
  if (!e || e.native == null) return t('nodeInfoUnknown')
  return e.native ? t('nativeYes') : t('nativeNo')
})

const PROXYCHECK = 'proxycheck.io'
// 每一行右边的小字标出这个值是谁查的
const exitRows = computed(() => {
  const e = exit.value
  if (!e) return []
  return [
    { key: 'type', label: t('nodeInfoIpType'), value: ipTypeText.value, class: '', source: PROXYCHECK, title: '' },
    { key: 'risk', label: t('nodeInfoRisk'), value: riskText.value, class: riskLevel.value ? RISK_CLASS[riskLevel.value] : '', source: PROXYCHECK, title: '' },
    {
      key: 'native',
      label: t('nodeInfoNative'),
      value: nativeText.value,
      class: '',
      source: e.registeredCountry ? t('nativeRegistered', { country: countryLabel(e.registeredCountry) }) : t('nodeInfoSourceRegistry'),
      title: t('nodeInfoNativeHint'),
    },
    {
      key: 'devices',
      label: t('nodeInfoDevices'),
      value: e.devices == null ? '—' : String(e.devices),
      class: 'tabular-nums',
      source: PROXYCHECK,
      title: t('nodeInfoDevicesHint'),
    },
  ]
})

// 有一路没查到时在底部提一句,已经查到的照常显示
const partialText = computed(() => {
  const errors = exit.value?.errors
  if (!errors) return ''
  const what = [errors.proxycheck && PROXYCHECK, errors.rdap && 'RDAP'].filter(Boolean).join('、')
  return what ? t('nodeInfoPartial', { what }) : ''
})
</script>
