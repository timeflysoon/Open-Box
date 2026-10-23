<template>
  <!-- 节点分流(客户端):共享网络每台服务器一个码,点二维码在弹窗里看 -->
  <div class="app-card-inset flex flex-col gap-3">
    <div class="flex flex-col gap-1">
      <span class="text-base font-semibold">{{ $t('shareAppCodesTitle') }}</span>
      <p class="text-base-content/60 text-xs leading-relaxed">{{ $t('shareAppCodesDescription') }}</p>
    </div>

    <div
      v-if="loading"
      class="flex justify-center py-4"
    >
      <span class="loading loading-spinner loading-md" />
    </div>
    <p
      v-else-if="!rows.length"
      class="text-base-content/50 text-xs"
    >
      {{ $t('shareAppCodesEmpty') }}
    </p>
    <div
      v-else
      class="divide-base-content/10 divide-y"
    >
      <div
        v-for="r in rows"
        :key="r.server.id"
        class="flex items-center gap-2 py-2"
      >
        <ServerStackIcon class="text-base-content/50 h-4 w-4 shrink-0" />
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
          <span class="truncate">{{ r.server.name }}</span>
          <StatusBadge
            v-if="r.server.enabled === false"
            :on="false"
            on-text=""
            :off-text="$t('groupDisabledBadge')"
          />
          <span class="text-base-content/50 text-xs">
            {{ r.server.protocol }} · {{ $t('serverPortLabel') }} {{ r.server.port }}
          </span>
        </div>
        <span
          v-if="r.pairCode"
          v-tip="$t('pairCodeTip')"
          class="badge badge-sm badge-ghost font-mono tracking-widest"
        >{{ r.pairCode }}</span>
        <button
          type="button"
          class="btn btn-ghost btn-square btn-xs"
          :disabled="!r.code"
          v-tip="$t('shareCodeButton')"
          @click="openQr(r)"
        >
          <QrCodeIcon class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-square btn-xs"
          :disabled="!r.code"
          v-tip="$t('copyLink')"
          @click="copy(r.code)"
        >
          <ClipboardDocumentIcon class="h-4 w-4" />
        </button>
      </div>
    </div>

    <DialogWrapper
      v-model="showQr"
      :title="current ? $t('shareCodeTitle', { name: current.server.name }) : ''"
      box-class="w-full max-w-md"
    >
      <div
        v-if="current"
        class="flex flex-col gap-3 text-sm"
      >
        <img
          v-if="qrDataUrl"
          :src="qrDataUrl"
          class="h-56 w-56 self-center rounded-lg bg-white p-1"
          alt="QR"
        />
        <p class="text-base-content/60 text-center text-xs">{{ $t('shareCodeAppHint') }}</p>
        <div
          v-if="current.pairCode"
          class="flex items-center justify-center gap-2 text-sm"
        >
          {{ $t('pairCodeLabel') }}
          <span class="font-mono text-lg font-semibold tracking-widest">{{ current.pairCode }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-xs"
            :disabled="rotatingId === current.server.id"
            :aria-label="$t('pairCodeRotate')"
            v-tip="$t('pairCodeRotate')"
            @click="showRotateConfirm = true"
          >
            <span
              v-if="rotatingId === current.server.id"
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
            :value="current.code"
            type="text"
            readonly
            class="input input-sm join-item w-full font-mono text-xs"
          />
          <button
            type="button"
            class="btn btn-sm join-item"
            @click="copy(current.code)"
          >
            <ClipboardDocumentIcon class="h-4 w-4" />
          </button>
        </div>
        <template v-if="current.link">
          <div class="join w-full">
            <input
              :value="current.link"
              type="text"
              readonly
              class="input input-sm join-item w-full font-mono text-xs"
            />
            <button
              type="button"
              class="btn btn-sm join-item"
              @click="copy(current.link)"
            >
              <ClipboardDocumentIcon class="h-4 w-4" />
            </button>
          </div>
          <p class="text-base-content/60 text-xs">{{ $t('shareCodeLinkHint') }}</p>
        </template>
        <p
          v-if="current.server.enabled === false"
          class="text-warning text-xs"
        >
          {{ $t('shareCodeDisabled') }}
        </p>
        <p
          v-if="isLocalAddress(current.server.address || '')"
          class="text-warning text-xs"
        >
          {{ $t('shareCodeLocalAddress', { address: current.server.address }) }}
        </p>
        <p
          v-if="!lan && !publicBase"
          class="text-warning text-xs"
        >
          {{ $t('shareCodeNoLan') }}
        </p>
      </div>
    </DialogWrapper>

    <PairCodeRotateConfirm
      v-model="showRotateConfirm"
      :message="$t('pairCodeRotateShareConfirm')"
      @confirm="current && rotate(current.server)"
    />
  </div>
</template>

<script setup lang="ts">
import {
  fetchShareCodeSeals,
  rotateShareCode,
  type OpenboxClientAppInfo,
  type OpenboxShareCodeSeal,
} from '@/api/clientApp'
import { fetchProfile, type OpenboxServer } from '@/api/openbox'
import PairCodeRotateConfirm from '@/components/clientapp/PairCodeRotateConfirm.vue'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { copyText } from '@/helper/clipboard'
import { buildShareAppCode, panelPublicBase, pickLanAddress } from '@/helper/clientAppCode'
import { showNotification } from '@/helper/notification'
import { buildShareLink, isLocalAddress } from '@/helper/shareLink'
import { ArrowPathIcon, ClipboardDocumentIcon, QrCodeIcon, ServerStackIcon } from '@heroicons/vue/24/outline'
import QRCode from 'qrcode'
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{ info: OpenboxClientAppInfo }>()

type Row = { server: OpenboxServer; code: string; link: string; pairCode: string }

const servers = ref<OpenboxServer[]>([])
const loading = ref(true)
const showQr = ref(false)
const currentId = ref('')
const qrDataUrl = ref('')

// 服务端给每台服务器封好的密文和配对码(服务器列表一变就重新取:换密码后链接也变了)
const seals = ref<Record<string, OpenboxShareCodeSeal>>({})
const rotatingId = ref('')
const showRotateConfirm = ref(false)

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

// 码里的 lan / pub 跟着浏览器当前打开面板的地址走(见 helper/clientAppCode.ts)
const lan = computed(() => pickLanAddress(props.info.lanAddresses, props.info.panelPort))
const publicBase = computed(() => panelPublicBase())

const router = computed(() => ({
  routerId: props.info.routerId,
  routerName: props.info.routerName,
  lan: lan.value,
  panelPort: props.info.panelPort,
  publicBase: publicBase.value,
}))

const rows = computed<Row[]>(() =>
  servers.value.map((server) => {
    const link = buildShareLink(server) || ''
    const seal = seals.value[server.id]
    return {
      server,
      link,
      pairCode: seal?.pairCode ?? '',
      code: seal ? buildShareAppCode(router.value, server, seal) : '',
    }
  }),
)

const current = computed(() => rows.value.find((r) => r.server.id === currentId.value) ?? null)

let sealSeq = 0
const loadSeals = async () => {
  const mine = ++sealSeq
  const links = Object.fromEntries(
    servers.value.map((s) => [s.id, buildShareLink(s)] as const).filter(([, link]) => link),
  )
  if (!Object.keys(links).length) {
    seals.value = {}
    return
  }
  try {
    const result = await fetchShareCodeSeals(links)
    if (mine === sealSeq) seals.value = result
  } catch (error) {
    showNotification({ content: 'pairCodeLoadFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  }
}
watch(servers, loadSeals, { deep: true })

// 更换这台服务器的配对码:密码一起换并立即应用。换完拿回来的服务器整条替换列表里的那条
const rotate = async (server: OpenboxServer) => {
  if (rotatingId.value) return
  rotatingId.value = server.id
  try {
    const r = await rotateShareCode(server.id)
    servers.value = servers.value.map((s) => (s.id === r.server.id ? r.server : s))
    showNotification(
      r.applied === 'failed'
        ? { content: 'pairCodeApplyFailed', params: { code: r.pairCode, message: r.message ?? '' }, type: 'alert-error' }
        : {
            content: r.applied === 'restarted' ? 'pairCodeRotatedApplied' : 'pairCodeRotated',
            params: { code: r.pairCode },
            type: 'alert-success',
          },
    )
  } catch (error) {
    showNotification({ content: 'pairCodeRotateFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  } finally {
    rotatingId.value = ''
  }
}

const copy = async (text: string) => {
  if (!text) return
  const ok = await copyText(text)
  showNotification(
    ok
      ? { content: 'copySuccess', type: 'alert-success' }
      : { content: 'copyFailed', type: 'alert-error' },
  )
}

const openQr = (row: Row) => {
  currentId.value = row.server.id
  showQr.value = true
}

// 二维码跟着当前这条的码走:换配对码后码变了,弹窗里的图也要重画
watch(
  () => (showQr.value ? current.value?.code : ''),
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

onMounted(async () => {
  try {
    const profile = await fetchProfile()
    servers.value = profile.servers ?? []
  } catch (error) {
    showNotification({
      content: 'clientConfigLoadFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  } finally {
    loading.value = false
  }
})
</script>
