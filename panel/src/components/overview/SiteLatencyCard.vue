<template>
  <section class="card bg-base-100 border-base-300/60 border p-4">
    <div class="mb-3 flex items-start justify-between gap-2">
      <div>
        <h2 class="text-base font-semibold">{{ $t('siteLatency') }}</h2>
        <p
          v-if="testedAt"
          class="text-base-content/60 text-xs"
        >
          {{ dayjs(testedAt).format('HH:mm:ss') }}
        </p>
      </div>
      <button
        class="btn btn-sm btn-ghost"
        :disabled="loading"
        @click="runTest"
      >
        <span
          v-if="loading"
          class="loading loading-spinner loading-xs"
        ></span>
        <ArrowPathIcon
          v-else
          class="h-4 w-4"
        />
        {{ $t('siteLatencyTest') }}
      </button>
    </div>
    <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <div
        v-for="card in cards"
        :key="card.id"
        class="bg-base-100 border-base-300/60 flex flex-col rounded-xl border p-4"
      >
        <div class="text-base-content/60 text-xs">{{ card.name }}</div>
        <div
          class="my-2 text-3xl tabular-nums"
          :class="card.color"
          :title="card.openMs === null ? '' : `${card.openMs}ms`"
        >
          <span
            v-if="loading && card.ms === null"
            class="loading loading-dots loading-sm"
          ></span>
          <template v-else-if="card.ms !== null">
            {{ card.ms }}<span class="text-base-content/50 ml-1 text-sm">ms</span>
          </template>
          <template v-else>—</template>
        </div>
        <div
          class="text-base-content/50 mb-2 truncate text-xs"
          :class="{ 'text-error': card.error }"
          :title="card.error || card.chain"
        >
          {{ card.error || card.chain || '\u00a0' }}
        </div>
        <div class="mt-auto flex h-8 items-end gap-0.5">
          <div
            v-for="(bar, i) in card.bars"
            :key="i"
            class="w-full rounded-sm"
            :class="bar.color"
            :style="{ height: `${bar.pct}%` }"
            :title="bar.title"
          ></div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  fetchSiteLatencyHistory,
  testSiteLatency,
  type OpenboxLatencyHistory,
  type OpenboxSiteLatencyResult,
} from '@/api/openbox'
import { NOT_CONNECTED } from '@/constant'
import { getColorForLatency } from '@/helper'
import { showNotification } from '@/helper/notification'
import { ArrowPathIcon } from '@heroicons/vue/24/outline'
import dayjs from 'dayjs'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

// 先写死上游默认的四个站点(服务端 GET 不带正文时也是这四个);面板设置里改站点表留到以后
const SITES = [
  { id: 'baidu', name: 'Baidu', url: 'https://www.baidu.com/favicon.ico' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/generate_204' },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1/models' },
  { id: 'telegram', name: 'Telegram', url: 'https://telegram.org/favicon.ico' },
]

const results = ref<Record<string, OpenboxSiteLatencyResult>>({})
const history = ref<OpenboxLatencyHistory>({})
const timeoutMs = ref(5000)
const testedAt = ref(0)
const loading = ref(false)

// 类名要写全,Tailwind 只编它在源码里见过的类
const barColor = (delay: number) => {
  if (delay === NOT_CONNECTED) return 'bg-red-500'
  switch (getColorForLatency(delay)) {
    case 'text-green-500':
      return 'bg-green-500'
    case 'text-yellow-500':
      return 'bg-yellow-500'
    case 'text-red-500':
      return 'bg-red-500'
    default:
      return 'bg-gray-400'
  }
}

const cards = computed(() =>
  SITES.map((site) => {
    const result = results.value[site.id]
    const samples = (history.value[site.id] ?? []).slice(-10)
    const ms = result?.ms ?? null
    return {
      id: site.id,
      name: site.name,
      ms,
      openMs: result?.openMs ?? null,
      error: result?.error ?? null,
      chain: result?.chain?.length ? result.chain.join(' → ') : '',
      color: ms === null ? '' : getColorForLatency(ms),
      bars: samples.map((sample) => ({
        // 「不通」记的是 0,实际等了 timeoutMs,柱子画满
        pct:
          sample.delay === NOT_CONNECTED
            ? 100
            : Math.min(100, Math.max(8, Math.round((sample.delay / timeoutMs.value) * 100))),
        color: barColor(sample.delay),
        title: `${dayjs(sample.time).format('MM-DD HH:mm:ss')} ${
          sample.delay === NOT_CONNECTED ? t('latencyTimeout') : `${sample.delay}ms`
        }${sample.node ? ` · ${sample.node}` : ''}`,
      })),
    }
  }),
)

const notifyError = (e: unknown) => {
  showNotification({
    content: 'routeTestRequestFailed',
    params: { message: e instanceof Error ? e.message : String(e) },
    key: 'site-latency-card',
    type: 'alert-error',
  })
}

const loadHistory = async () => {
  try {
    const data = await fetchSiteLatencyHistory()
    history.value = data.history
    timeoutMs.value = data.timeoutMs
  } catch {
    // 只是先把柱子画出来,拿不到就等测完那一轮带回来
  }
}

const runTest = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const run = await testSiteLatency(SITES.map(({ id, url }) => ({ id, url })))
    results.value = Object.fromEntries(run.sites.map((site) => [site.id, site]))
    history.value = run.history
    timeoutMs.value = run.timeoutMs
    testedAt.value = run.testedAt
  } catch (e) {
    notifyError(e)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadHistory()
  void runTest()
})
</script>
