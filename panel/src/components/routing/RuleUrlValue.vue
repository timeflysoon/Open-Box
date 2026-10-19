<template>
  <div class="flex min-w-0 flex-1 items-center gap-1.5">
    <input
      v-model="value"
      type="url"
      class="input input-sm min-w-0 flex-1 font-mono text-xs"
      :placeholder="placeholder"
    />
    <!-- 填完网址就去拉一次看看里面有多少条:数字出来之前转个圈,拉不动就说一句;
         和 geosite / geoip 那边的「详情(N)」是同一个弹窗,只是数据从网址来 -->
    <span
      v-if="state === 'loading'"
      class="loading loading-spinner loading-xs shrink-0"
    />
    <span
      v-else-if="state === 'failed'"
      class="text-error shrink-0 text-xs"
      v-tip="$t('ruleUrlFetchFailed')"
    >{{ $t('ruleUrlFetchFailedShort') }}</span>
    <button
      v-else-if="count !== null"
      type="button"
      class="btn btn-ghost btn-xs shrink-0"
      @click="showEntries = true"
    >
      {{ $t('geoEntriesLink') }}({{ count.toLocaleString() }})
    </button>
    <!-- 立即更新:重新拉取这份名单并编译,不用等 24 小时一次的自动更新 -->
    <button
      v-if="isUrl(value) && state !== 'loading'"
      v-tip="$t('ruleUrlRefreshTip')"
      type="button"
      class="btn btn-ghost btn-xs btn-circle shrink-0"
      :disabled="refreshing"
      @click="refresh"
    >
      <span
        v-if="refreshing"
        class="loading loading-spinner loading-xs"
      />
      <ArrowPathIcon class="h-4 w-4" />
    </button>
    <GeoEntriesDialog
      v-if="showEntries"
      v-model="showEntries"
      :url="value"
    />
  </div>
</template>

<script setup lang="ts">
import { refreshRuleList } from '@/api/openbox'
import GeoEntriesDialog from '@/components/routing/GeoEntriesDialog.vue'
import { cachedRuleListCount, ruleListCount, setRuleListCount } from '@/helper/geoEntryCount'
import { showNotification } from '@/helper/notification'
import { ArrowPathIcon } from '@heroicons/vue/24/outline'
import { ref, watch } from 'vue'

defineProps<{ placeholder?: string }>()
const value = defineModel<string>({ required: true })

const showEntries = ref(false)
const count = ref<number | null>(null)
const state = ref<'idle' | 'loading' | 'failed'>('idle')

const isUrl = (v: string) => /^https?:\/\/[^\s]+$/i.test(v.trim())

const refreshing = ref(false)
const refresh = async () => {
  const url = value.value.trim()
  if (!isUrl(url) || refreshing.value) return
  refreshing.value = true
  try {
    const result = await refreshRuleList(url)
    setRuleListCount(url, result.total)
    if (value.value.trim() === url) {
      count.value = result.total
      state.value = 'idle'
    }
    showNotification({
      content: 'ruleUrlRefreshed',
      params: { count: result.total.toLocaleString() },
      type: 'alert-success',
    })
  } catch (error) {
    showNotification({
      content: 'ruleUrlRefreshFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  } finally {
    refreshing.value = false
  }
}

// 边打边查会对着半截网址发请求,等停手 600ms 再去;换了网址就以最后一次为准
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  value,
  (v) => {
    clearTimeout(timer)
    const url = v.trim()
    if (!isUrl(url)) {
      count.value = null
      state.value = 'idle'
      return
    }
    const cached = cachedRuleListCount(url)
    if (cached !== null) {
      count.value = cached
      state.value = 'idle'
      return
    }
    state.value = 'loading'
    count.value = null
    timer = setTimeout(() => {
      ruleListCount(url).then((n) => {
        if (value.value.trim() !== url) return
        count.value = n
        state.value = n === null ? 'failed' : 'idle'
      })
    }, 600)
  },
  { immediate: true },
)
</script>
