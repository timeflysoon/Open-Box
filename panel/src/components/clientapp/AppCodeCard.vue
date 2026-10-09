<template>
  <!-- 本地分流的 App 码:二维码 / 复制链接 / 导出文件(三者是同一个 import 码)+ 同步开关 -->
  <div class="card">
    <div class="app-card-inset flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <span class="text-base font-medium">{{ $t('clientAppLocalTitle') }}</span>
        <button
          v-if="issue"
          type="button"
          class="btn btn-ghost btn-square btn-sm ml-auto"
          :class="issue.enabled ? 'text-success' : 'text-base-content/40'"
          v-tip="$t(issue.enabled ? 'clientAppSyncOn' : 'clientAppSyncOff')"
          @click="toggleEnabled"
        >
          <PowerIcon class="h-4 w-4" />
        </button>
      </div>
      <p class="text-base-content/60 text-xs">{{ $t('clientAppLocalHint') }}</p>

      <div
        v-if="loading"
        class="flex justify-center py-6"
      >
        <span class="loading loading-spinner loading-md" />
      </div>
      <template v-else-if="issue">
        <img
          v-if="qrDataUrl"
          :src="qrDataUrl"
          class="h-44 w-44 self-center rounded-lg bg-white p-1"
          alt="QR"
        />
        <div class="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            class="btn btn-sm"
            :disabled="!code"
            @click="copy(code)"
          >
            <ClipboardDocumentIcon class="h-4 w-4" />
            {{ $t('copyLink') }}
          </button>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="exporting"
            @click="exportFile"
          >
            <span
              v-if="exporting"
              class="loading loading-spinner loading-xs"
            />
            <ArrowDownTrayIcon
              v-else
              class="h-4 w-4"
            />
            {{ $t('clientAppExport') }}
          </button>
        </div>
        <p class="text-base-content/60 text-center text-xs">
          {{ lastSync ? $t('clientAppLastSync', { time: lastSync }) : $t('clientAppNeverSynced') }}
        </p>
        <p class="text-warning text-xs">{{ $t('clientAppLocalWarn') }}</p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  fetchClientConfig,
  fetchClientConfigFile,
  setClientConfigEnabled,
  type OpenboxClientAppInfo,
  type OpenboxClientConfigIssue,
} from '@/api/clientApp'
import { copyText } from '@/helper/clipboard'
import {
  buildClientImportCode,
  clientConfigExportFileName,
  withImportCode,
} from '@/helper/clientAppCode'
import { showNotification } from '@/helper/notification'
import { ArrowDownTrayIcon, ClipboardDocumentIcon, PowerIcon } from '@heroicons/vue/24/outline'
import QRCode from 'qrcode'
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{ info: OpenboxClientAppInfo }>()

const issue = ref<OpenboxClientConfigIssue | null>(null)
const loading = ref(true)
const exporting = ref(false)
const qrDataUrl = ref('')

const code = computed(() => {
  const i = issue.value
  if (!i) return ''
  return buildClientImportCode({
    routerId: i.routerId,
    routerName: i.routerName,
    lan: i.lanAddresses[0] || '',
    panelPort: i.panelPort,
    token: i.token,
    key: i.key,
  })
})

const lastSync = computed(() => {
  const at = issue.value?.device?.lastSyncAt
  return at ? new Date(at).toLocaleString() : ''
})

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const load = async () => {
  loading.value = true
  try {
    issue.value = await fetchClientConfig()
  } catch (error) {
    showNotification({
      content: 'clientAppLoadFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
  } finally {
    loading.value = false
  }
}

watch(
  code,
  async (value) => {
    if (!value) {
      qrDataUrl.value = ''
      return
    }
    try {
      qrDataUrl.value = await QRCode.toDataURL(value, { margin: 1, width: 352 })
    } catch {
      qrDataUrl.value = ''
    }
  },
  { immediate: true },
)

const copy = async (text: string) => {
  const ok = await copyText(text)
  showNotification(
    ok
      ? { content: 'copySuccess', type: 'alert-success' }
      : { content: 'copyFailed', type: 'alert-error' },
  )
}

const toggleEnabled = async () => {
  const current = issue.value
  if (!current) return
  try {
    const r = await setClientConfigEnabled(!current.enabled)
    current.enabled = r.enabled
  } catch (error) {
    showNotification({
      content: 'saveFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
  }
}

const exportFile = async () => {
  const current = issue.value
  if (!current || !code.value || exporting.value) return
  exporting.value = true
  try {
    const bundle = withImportCode(await fetchClientConfigFile(), code.value)
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = clientConfigExportFileName(current.routerName || props.info.routerName)
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (error) {
    showNotification({
      content: 'clientAppExportFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
  } finally {
    exporting.value = false
  }
}

onMounted(load)
</script>
