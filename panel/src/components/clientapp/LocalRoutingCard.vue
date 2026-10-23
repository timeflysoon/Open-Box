<template>
  <!-- 本地分流(客户端):一行 = 设备图标 + 名称 + 最后同步 + 开关 / 二维码 / 复制链接 / 导出文件 -->
  <div class="card">
    <div class="app-card-inset flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <span class="text-base font-semibold">{{ $t('clientConfigTitle') }}</span>
        <p class="text-base-content/60 text-xs leading-relaxed">{{ $t('clientConfigDescription') }}</p>
      </div>

      <div
        v-if="loading"
        class="flex justify-center py-4"
      >
        <span class="loading loading-spinner loading-md" />
      </div>
      <div
        v-else-if="issue"
        class="flex items-center gap-2 py-2"
      >
        <DevicePhoneMobileIcon class="text-base-content/50 h-4 w-4 shrink-0" />
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
          <span class="truncate">{{ name }}</span>
          <StatusBadge
            v-if="!issue.enabled"
            :on="false"
            on-text=""
            :off-text="$t('groupDisabledBadge')"
          />
          <span class="text-base-content/50 text-xs">
            {{ lastSync ? $t('clientConfigLastSync', { time: lastSync }) : $t('clientConfigNeverSynced') }}
          </span>
        </div>
        <span
          v-if="issue.pairCode"
          v-tip.contain="$t('pairCodeTip')"
          class="badge badge-sm badge-ghost font-mono tracking-widest"
        >{{ issue.pairCode }}</span>
        <button
          type="button"
          class="btn btn-ghost btn-square btn-xs"
          :class="issue.enabled ? 'text-success' : 'text-base-content/40'"
          :disabled="toggling"
          v-tip.contain="$t(issue.enabled ? 'clientConfigPowerOff' : 'clientConfigPowerOn')"
          @click="toggleEnabled"
        >
          <PowerIcon class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-square btn-xs"
          :disabled="!code"
          v-tip.contain="$t('shareCodeButton')"
          @click="showQr = true"
        >
          <QrCodeIcon class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-square btn-xs"
          :disabled="!code"
          v-tip.contain="$t('copyLink')"
          @click="copy(code)"
        >
          <ClipboardDocumentIcon class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-square btn-xs"
          :disabled="!code || exporting"
          v-tip.contain="$t('clientConfigExportFile')"
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
        </button>
      </div>
      <div class="border-base-300/60 flex items-center justify-between gap-3 border-t pt-3">
        <div class="flex min-w-0 flex-col">
          <span class="text-sm">{{ $t('clientSystemDns') }}</span>
          <span class="text-base-content/60 mt-1 text-xs">{{ $t('clientSystemDnsHint') }}</span>
        </div>
        <input
          type="checkbox"
          class="toggle toggle-success shrink-0"
          :checked="systemDns"
          :disabled="systemDnsBusy"
          @change="setSystemDns"
        />
      </div>
    </div>

    <DialogWrapper
      v-model="showQr"
      :title="name"
      box-class="w-full max-w-md"
    >
      <div class="flex flex-col gap-3 text-sm">
        <img
          v-if="qrDataUrl"
          :src="qrDataUrl"
          class="h-64 w-64 self-center rounded-lg bg-white p-1"
          alt="QR"
        />
        <p class="text-base-content/60 text-center text-xs">{{ $t('clientConfigScanHint') }}</p>
        <div
          v-if="issue?.pairCode"
          class="flex items-center justify-center gap-2 text-sm"
        >
          {{ $t('pairCodeLabel') }}
          <span class="font-mono text-lg font-semibold tracking-widest">{{ issue.pairCode }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-xs"
            :disabled="rotating"
            :aria-label="$t('pairCodeRotate')"
            v-tip.contain="$t('pairCodeRotate')"
            @click="showRotateConfirm = true"
          >
            <span
              v-if="rotating"
              class="loading loading-spinner loading-xs"
            />
            <ArrowPathIcon
              v-else
              class="h-4 w-4"
            />
          </button>
        </div>
        <div class="join w-full">
          <input
            :value="code"
            type="text"
            readonly
            class="input input-sm join-item w-full font-mono text-xs"
          />
          <button
            type="button"
            class="btn btn-sm join-item"
            :disabled="!code"
            @click="copy(code)"
          >
            <ClipboardDocumentIcon class="h-4 w-4" />
          </button>
        </div>
        <p
          v-if="issue && !issue.enabled"
          class="text-warning text-xs"
        >
          {{ $t('clientConfigSyncOffHint') }}
        </p>
        <p
          v-if="issue && !lan && !publicBase"
          class="text-warning text-xs"
        >
          {{ $t('clientConfigNoLan') }}
        </p>
        <div class="flex justify-end">
          <button
            type="button"
            class="btn btn-sm"
            @click="showQr = false"
          >
            {{ $t('close') }}
          </button>
        </div>
      </div>
    </DialogWrapper>

    <PairCodeRotateConfirm
      v-model="showRotateConfirm"
      :message="$t('pairCodeRotateLocalConfirm')"
      @confirm="rotate"
    />
  </div>
</template>

<script setup lang="ts">
import { getConfigsAPI, patchConfigsAPI } from '@/api'
import {
  fetchClientConfig,
  fetchClientConfigFile,
  rotateClientConfig,
  setClientConfigEnabled,
  type OpenboxClientAppInfo,
  type OpenboxClientConfigIssue,
} from '@/api/clientApp'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import PairCodeRotateConfirm from '@/components/clientapp/PairCodeRotateConfirm.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { copyText } from '@/helper/clipboard'
import {
  buildClientImportCode,
  clientConfigExportFileName,
  panelPublicBase,
  pickLanAddress,
} from '@/helper/clientAppCode'
import { showNotification } from '@/helper/notification'
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ClipboardDocumentIcon,
  DevicePhoneMobileIcon,
  PowerIcon,
  QrCodeIcon,
} from '@heroicons/vue/24/outline'
import QRCode from 'qrcode'
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{ info: OpenboxClientAppInfo }>()

const systemDns = ref(true)
const systemDnsBusy = ref(true)

onMounted(async () => {
  try {
    const { data } = await getConfigsAPI()
    systemDns.value = (data as unknown as Record<string, unknown>).clientSystemDns !== false
  } catch (error) {
    showNotification({ content: 'clientConfigLoadFailed', params: { message: errorMessage(error) } })
  } finally {
    systemDnsBusy.value = false
  }
})

const setSystemDns = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const next = input.checked
  systemDnsBusy.value = true
  try {
    await patchConfigsAPI({ clientSystemDns: next })
    systemDns.value = next
  } catch (error) {
    input.checked = systemDns.value
    showNotification({
      content: 'routingSaveFailed',
      params: { message: errorMessage(error) },
    })
  } finally {
    systemDnsBusy.value = false
  }
}

const issue = ref<OpenboxClientConfigIssue | null>(null)
const loading = ref(true)
const toggling = ref(false)
const exporting = ref(false)
const showQr = ref(false)
const qrDataUrl = ref('')

const name = computed(
  () => props.info.serverInfo.name || props.info.serverInfoDefaults.name || issue.value?.routerName || props.info.routerName,
)

// 码里的 lan / pub 跟着浏览器当前打开面板的地址走(见 helper/clientAppCode.ts)
const lan = computed(() => (issue.value ? pickLanAddress(issue.value.lanAddresses, issue.value.panelPort) : ''))
const publicBase = computed(() => panelPublicBase())

const code = computed(() => {
  const i = issue.value
  if (!i) return ''
  return buildClientImportCode({
    routerId: i.routerId,
    routerName: i.routerName,
    lan: lan.value,
    panelPort: i.panelPort,
    publicBase: publicBase.value,
    nonce: i.nonce,
  })
})

const lastSync = computed(() => {
  const at = issue.value?.lastSyncAt
  return at ? new Date(at).toLocaleString() : ''
})

// 更换配对码:之前导入的设备和导出的文件都会失效,所以先确认一次
const showRotateConfirm = ref(false)
const rotating = ref(false)
const rotate = async () => {
  if (rotating.value) return
  rotating.value = true
  try {
    issue.value = await rotateClientConfig()
    showNotification({ content: 'pairCodeRotated', params: { code: issue.value.pairCode }, type: 'alert-success' })
  } catch (error) {
    showNotification({ content: 'pairCodeRotateFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  } finally {
    rotating.value = false
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const load = async () => {
  loading.value = true
  try {
    issue.value = await fetchClientConfig()
  } catch (error) {
    showNotification({
      content: 'clientConfigLoadFailed',
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
      qrDataUrl.value = await QRCode.toDataURL(value, { margin: 1, width: 400 })
    } catch {
      qrDataUrl.value = ''
    }
  },
  { immediate: true },
)

const copy = async (text: string) => {
  if (!text) return
  const ok = await copyText(text)
  showNotification(
    ok
      ? { content: 'copySuccess', type: 'alert-success' }
      : { content: 'copyFailed', type: 'alert-error' },
  )
}

const toggleEnabled = async () => {
  const current = issue.value
  if (!current || toggling.value) return
  toggling.value = true
  try {
    const r = await setClientConfigEnabled(!current.enabled)
    current.enabled = r.enabled
    showNotification({
      content: r.enabled ? 'clientConfigSyncEnabled' : 'clientConfigSyncDisabled',
      type: r.enabled ? 'alert-success' : 'alert-info',
    })
  } catch (error) {
    showNotification({
      content: 'clientConfigPowerFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
  } finally {
    toggling.value = false
  }
}

const exportFile = async () => {
  const current = issue.value
  if (!current || exporting.value) return
  exporting.value = true
  try {
    const bundle = await fetchClientConfigFile(lan.value, publicBase.value)
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const fileName = clientConfigExportFileName(current.routerName || props.info.routerName)
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showNotification({ content: 'clientConfigExported', params: { file: fileName }, type: 'alert-success' })
  } catch (error) {
    showNotification({
      content: 'clientConfigExportFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
  } finally {
    exporting.value = false
  }
}

onMounted(load)
</script>
