<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div>
        <h2 class="text-base font-semibold">{{ $t('timezoneTitle') }}</h2>
        <p class="text-base-content/60 text-xs">{{ $t('timezoneDescription') }}</p>
      </div>

      <span
        v-if="loading"
        class="loading loading-spinner loading-xs"
      />
      <template v-else-if="state">
        <p class="text-base-content/70 text-sm">
          {{ $t('timezoneCurrent') }}: {{ state.zone || $t('timezoneUnknown') }}
          <template v-if="state.offset"> (UTC{{ state.offset }})</template>
          <template v-if="state.local"> · {{ $t('timezoneLocalTime') }}: {{ state.local }}</template>
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <input
            v-model.trim="keyword"
            type="search"
            class="input input-sm w-56 max-w-full"
            :placeholder="$t('timezoneSearchPlaceholder')"
          />
          <select
            v-model="selected"
            class="select select-sm min-w-0 flex-1 basis-56"
          >
            <option
              v-for="zone in options"
              :key="zone"
              :value="zone"
            >
              {{ label(zone) }}
            </option>
          </select>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="saving || !selected || selected === state.zone"
            @click="save"
          >
            <span
              v-if="saving"
              class="loading loading-spinner loading-xs"
            />{{ $t('timezoneSave') }}
          </button>
        </div>
        <p
          v-if="noMatch"
          class="text-base-content/50 text-xs"
        >
          {{ $t('timezoneNoMatch') }}
        </p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fetchTimezone, saveTimezone, type OpenboxTimezoneState } from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { computed, onMounted, ref } from 'vue'

const state = ref<OpenboxTimezoneState | null>(null)
const loading = ref(true)
const saving = ref(false)
const keyword = ref('')
const selected = ref('')

// 国家 / 地区名按浏览器语言显示,只用来在下拉里标注和搜索
const regionNames = (() => {
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'region' })
  } catch {
    return null
  }
})()
const countryName = (zone: string) => {
  const code = state.value?.countries?.[zone]
  if (!code) return ''
  try {
    return regionNames?.of(code) || code
  } catch {
    return code
  }
}
const label = (zone: string) => {
  const country = countryName(zone)
  return country ? `${zone} · ${country}` : zone
}

const filtered = computed(() => {
  const zones = state.value?.zones ?? []
  const query = keyword.value.toLowerCase()
  if (!query) return zones
  return zones.filter((zone) => {
    const text = label(zone).toLowerCase()
    return text.includes(query) || text.replace(/_/g, ' ').includes(query)
  })
})
// 当前选中的永远留在列表里,免得搜索把它筛掉后下拉框显示空白
const options = computed(() =>
  selected.value && !filtered.value.includes(selected.value) ? [selected.value, ...filtered.value] : filtered.value,
)
const noMatch = computed(() => Boolean(keyword.value) && !filtered.value.length)

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const apply = (next: OpenboxTimezoneState) => {
  state.value = next
  selected.value = next.zone
}

const save = async () => {
  saving.value = true
  try {
    const next = await saveTimezone(selected.value)
    apply(next)
    showNotification({ content: 'timezoneSaved', params: { zone: next.zone }, type: 'alert-success' })
  } catch (error) {
    showNotification({ content: 'routingSaveFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    apply(await fetchTimezone())
  } catch (error) {
    showNotification({ content: 'routingLoadFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  } finally {
    loading.value = false
  }
})
</script>
