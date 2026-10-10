<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div>
        <h2 class="text-base font-semibold">{{ $t('tunTitle') }}</h2>
        <p class="text-base-content/60 text-xs">{{ $t('tunDescription') }}</p>
      </div>

      <div class="flex items-center justify-between gap-2">
        <div>
          <p class="text-sm">{{ $t('tunAutoRedirect') }}</p>
          <p class="text-base-content/50 text-xs">{{ $t('tunAutoRedirectNote') }}</p>
        </div>
        <input
          type="checkbox"
          class="toggle shrink-0"
          :checked="autoRedirect"
          @change="onAutoRedirect"
        />
      </div>

      <div class="border-base-300/60 flex items-center justify-between gap-2 border-t pt-3">
        <div>
          <p class="text-sm">{{ $t('tunStack') }}</p>
          <p class="text-base-content/50 text-xs">{{ $t(`tunStackNote_${stack}`) }}</p>
        </div>
        <select
          class="select select-sm w-32 shrink-0"
          :value="stack"
          @change="onStack"
        >
          <option value="mixed">mixed</option>
          <option value="gvisor">gvisor</option>
          <option value="system">system</option>
        </select>
      </div>

      <div class="border-base-300/60 grid gap-3 border-t pt-3 sm:grid-cols-2">
        <div class="flex min-w-0 flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('tunMtu') }}</label>
          <input
            v-model="mtuText"
            type="number"
            min="0"
            :max="MTU_MAX"
            class="input input-sm w-full"
            placeholder="0"
            @change="saveNumber('mtu')"
          />
          <p class="text-base-content/50 text-xs">{{ $t('tunMtuHint', { min: MTU_MIN, max: MTU_MAX }) }}</p>
        </div>
        <div class="flex min-w-0 flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('tunTcpMss') }}</label>
          <input
            v-model="mssText"
            type="number"
            min="0"
            :max="MSS_MAX"
            class="input input-sm w-full"
            placeholder="0"
            @change="saveNumber('tcpMss')"
          />
          <p class="text-base-content/50 text-xs">{{ $t('tunTcpMssHint', { min: MSS_MIN, max: MSS_MAX }) }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxProfile } from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

// 范围与后端 engine/tun-options.mjs 一致;0 = 内核默认 / 不钳制。服务端的校验才是最终依据
const MTU_MIN = 1280
const MTU_MAX = 65535
const MSS_MIN = 536
const MSS_MAX = 65495

const tun = computed(() => props.profile.tun ?? {})
const autoRedirect = computed(() => tun.value.autoRedirect !== false)
const stack = computed(() => (tun.value.stack === 'gvisor' || tun.value.stack === 'system' ? tun.value.stack : 'mixed'))

const mtuText = ref(String(tun.value.mtu ?? 0))
const mssText = ref(String(tun.value.tcpMss ?? 0))
watch(tun, (value) => {
  mtuText.value = String(value.mtu ?? 0)
  mssText.value = String(value.tcpMss ?? 0)
})

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

// 后端把 tun 按字段合并,只发改动的那一项即可
const save = async (patch: Record<string, unknown>) => {
  try {
    await props.patchProfile({ tun: patch })
    showNotification({ content: 'tunSaved', type: 'alert-success' })
  } catch (error) {
    showNotification({ content: 'routingSaveFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  }
}

const onAutoRedirect = (event: Event) => save({ autoRedirect: (event.target as HTMLInputElement).checked })
const onStack = (event: Event) => save({ stack: (event.target as HTMLSelectElement).value })

const saveNumber = async (key: 'mtu' | 'tcpMss') => {
  const raw = (key === 'mtu' ? mtuText.value : mssText.value).trim()
  const value = raw === '' ? 0 : Number(raw)
  const [min, max] = key === 'mtu' ? [MTU_MIN, MTU_MAX] : [MSS_MIN, MSS_MAX]
  if (!(value === 0 || (Number.isInteger(value) && value >= min && value <= max))) {
    showNotification({ content: key === 'mtu' ? 'tunMtuInvalid' : 'tunTcpMssInvalid', params: { min, max }, type: 'alert-error' })
    mtuText.value = String(tun.value.mtu ?? 0)
    mssText.value = String(tun.value.tcpMss ?? 0)
    return
  }
  await save({ [key]: value })
}
</script>
