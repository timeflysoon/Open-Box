<template>
  <!-- 共享网络服务器的 App 码:每台启用的服务器一个码,App 扫码后经该服务器连回路由器 -->
  <div class="card">
    <div class="app-card-inset flex flex-col gap-3">
      <span class="text-base font-medium">{{ $t('clientAppShareTitle') }}</span>
      <p class="text-base-content/60 text-xs">{{ $t('clientAppShareHint') }}</p>

      <div
        v-if="loading"
        class="flex justify-center py-6"
      >
        <span class="loading loading-spinner loading-md" />
      </div>
      <p
        v-else-if="!rows.length"
        class="text-base-content/50 text-sm"
      >
        {{ $t('clientAppShareEmpty') }}
      </p>
      <div
        v-for="r in rows"
        :key="r.server.id"
        class="border-base-content/10 flex flex-col gap-2 rounded-lg border p-3"
      >
        <div class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ r.server.name }}</span>
          <span class="badge badge-outline badge-sm shrink-0">{{ r.server.protocol }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            :disabled="!r.code"
            v-tip="$t('copyLink')"
            @click="copy(r.code)"
          >
            <ClipboardDocumentIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            :disabled="!r.code"
            v-tip="$t(qrs[r.server.id] ? 'clientAppHideQr' : 'clientAppShowQr')"
            @click="toggleQr(r.server.id, r.code)"
          >
            <QrCodeIcon class="h-4 w-4" />
          </button>
        </div>
        <p
          v-if="!r.code"
          class="text-warning text-xs"
        >
          {{ $t('clientAppShareNoLink') }}
        </p>
        <img
          v-if="qrs[r.server.id]"
          :src="qrs[r.server.id]"
          class="h-44 w-44 self-center rounded-lg bg-white p-1"
          alt="QR"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxClientAppInfo } from '@/api/clientApp'
import { fetchProfile, type OpenboxServer } from '@/api/openbox'
import { copyText } from '@/helper/clipboard'
import { buildShareAppCode } from '@/helper/clientAppCode'
import { showNotification } from '@/helper/notification'
import { buildShareLink } from '@/helper/shareLink'
import { ClipboardDocumentIcon, QrCodeIcon } from '@heroicons/vue/24/outline'
import QRCode from 'qrcode'
import { computed, onMounted, reactive, ref } from 'vue'

const props = defineProps<{ info: OpenboxClientAppInfo }>()

const servers = ref<OpenboxServer[]>([])
const loading = ref(true)
const qrs = reactive<Record<string, string>>({})

const router = computed(() => ({
  routerId: props.info.routerId,
  routerName: props.info.routerName,
  lan: props.info.lanAddresses[0] || '',
  panelPort: props.info.panelPort,
}))

const rows = computed(() =>
  servers.value
    .filter((s) => s.enabled !== false)
    .map((server) => ({
      server,
      code: buildShareAppCode(router.value, { id: server.id, link: buildShareLink(server) || '' }),
    })),
)

const copy = async (text: string) => {
  const ok = await copyText(text)
  showNotification(
    ok
      ? { content: 'copySuccess', type: 'alert-success' }
      : { content: 'copyFailed', type: 'alert-error' },
  )
}

const toggleQr = async (id: string, code: string) => {
  if (qrs[id]) {
    delete qrs[id]
    return
  }
  try {
    qrs[id] = await QRCode.toDataURL(code, { margin: 1, width: 352 })
  } catch {
    delete qrs[id]
  }
}

onMounted(async () => {
  try {
    const profile = await fetchProfile()
    servers.value = profile.servers ?? []
  } catch (error) {
    showNotification({
      content: 'clientAppLoadFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  } finally {
    loading.value = false
  }
})
</script>
