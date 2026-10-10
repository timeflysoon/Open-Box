<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div class="flex items-center justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold">{{ $t('chainTitle') }}</h2>
          <p class="text-base-content/60 text-xs">{{ $t('chainDescription') }}</p>
        </div>
        <button
          type="button"
          class="btn btn-primary btn-sm btn-square shrink-0"
          v-tip="$t('chainAdd')"
          :aria-label="$t('chainAdd')"
          @click="openEditor(null)"
        >
          <PlusIcon class="h-4 w-4" />
        </button>
      </div>

      <div
        v-if="loading"
        class="flex justify-center py-4"
      >
        <span class="loading loading-spinner loading-sm" />
      </div>
      <p
        v-else-if="!chains.length"
        class="text-base-content/50 text-sm"
      >
        {{ $t('chainEmpty') }}
      </p>
      <div
        v-else
        class="flex flex-col gap-2"
      >
        <div
          v-for="chain in chains"
          :key="chain.id"
          class="border-base-content/10 flex flex-row items-center gap-2 rounded-lg border p-3"
          :class="chain.enabled === false && 'opacity-50'"
        >
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="max-w-full truncate text-base font-medium">{{ chain.name }}</span>
              <StatusBadge
                v-if="chain.enabled === false"
                :on="false"
                on-text=""
                :off-text="$t('groupDisabledBadge')"
              />
            </div>
            <div class="text-base-content/60 mt-0.5 truncate text-xs">{{ summary(chain) }}</div>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            :class="chain.enabled === false ? 'text-base-content/40' : 'text-success'"
            :aria-label="$t(chain.enabled === false ? 'groupEnable' : 'groupDisable')"
            v-tip="$t(chain.enabled === false ? 'groupEnable' : 'groupDisable')"
            :disabled="saving"
            @click="toggleEnabled(chain)"
          >
            <PowerIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            :aria-label="$t('groupEdit')"
            @click="openEditor(chain)"
          >
            <PencilSquareIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm hover:text-error"
            :aria-label="$t('delete')"
            v-tip="$t('delete')"
            @click="askDelete(chain)"
          >
            <TrashIcon class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>

    <DialogWrapper
      v-model="showEditor"
      :title="$t(editing ? 'chainEditTitle' : 'chainAddTitle')"
      box-class="w-full max-w-2xl"
    >
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('chainNameLabel') }}</label>
          <input
            v-model="draft.name"
            type="text"
            maxlength="64"
            class="input input-sm w-full"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('chainUpstreamLabel') }}</label>
          <OutboundPicker
            v-model="draft.upstream"
            :options="pickerOptions"
            :placeholder="$t('chainUpstreamPlaceholder')"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('chainLinkLabel') }}</label>
          <textarea
            v-model="draft.link"
            rows="4"
            spellcheck="false"
            class="textarea textarea-sm w-full font-mono text-xs"
            :placeholder="$t('chainLinkPlaceholder')"
          />
          <p class="text-base-content/50 text-xs">{{ $t('chainLinkHint') }}</p>
        </div>

        <div
          v-if="testResult"
          class="bg-base-200/60 flex flex-col gap-1 rounded-lg px-3 py-2 text-xs"
        >
          <div>
            <span :class="testResult.ok ? 'text-success' : 'text-error'">
              {{ testResult.ok ? $t('chainTestOk', { ms: testResult.ms ?? 0 }) : $t('chainTestFailed', { message: testResult.error || '' }) }}
            </span>
            <span
              v-if="testResult.via"
              class="text-base-content/60"
            > · {{ $t('chainTestVia', { via: testResult.via }) }}</span>
          </div>
          <div
            v-if="ipSummary"
            class="text-base-content/70 break-all"
          >
            {{ ipSummary }}
          </div>
        </div>

        <div class="flex items-center justify-between gap-2">
          <button
            type="button"
            class="btn btn-sm"
            :disabled="testing"
            @click="runTest"
          >
            <span
              v-if="testing"
              class="loading loading-spinner loading-xs"
            />
            <BoltIcon
              v-else
              class="h-4 w-4"
            />
            {{ $t('chainTest') }}
          </button>
          <div class="flex gap-2">
            <button
              type="button"
              class="btn btn-sm"
              @click="showEditor = false"
            >
              {{ $t('cancel') }}
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="saving"
              @click="saveDraft"
            >
              <span
                v-if="saving"
                class="loading loading-spinner loading-xs"
              />
              {{ $t('subscriptionSave') }}
            </button>
          </div>
        </div>
      </div>
    </DialogWrapper>

    <DialogWrapper
      v-model="showDelete"
      :title="$t('chainDeleteTitle')"
    >
      <div class="flex flex-col gap-4 p-2">
        <p class="text-sm">{{ $t('chainDeleteConfirm', { name: pendingDelete?.name || '' }) }}</p>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="btn btn-sm"
            @click="showDelete = false"
          >
            {{ $t('cancel') }}
          </button>
          <button
            type="button"
            class="btn btn-error btn-sm"
            :disabled="saving"
            @click="confirmDelete"
          >
            <span
              v-if="saving"
              class="loading loading-spinner loading-xs"
            />
            {{ $t('confirm') }}
          </button>
        </div>
      </div>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import { fetchNodeGroups, fetchProfile, saveProfile, testChainLatency } from '@/api/openbox'
import type { OpenboxChainLatencyResult, OpenboxChainProxy } from '@/api/openbox'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import OutboundPicker from '@/components/common/OutboundPicker.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { IP_INFO_API } from '@/constant'
import { showNotification } from '@/helper/notification'
import { IPInfoAPI, speedtestTimeout, speedtestUrl } from '@/store/settings'
import { BoltIcon, PencilSquareIcon, PlusIcon, PowerIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const chains = ref<OpenboxChainProxy[]>([])
const groupNames = ref<string[]>([])
const nodeOptions = ref<Array<{ name: string; subscription: string }>>([])
const loading = ref(true)
const saving = ref(false)

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const load = async () => {
  try {
    const [profile, payload] = await Promise.all([fetchProfile(), fetchNodeGroups()])
    chains.value = profile.chainProxies ?? []
    // 内置的直连 / 拒绝、已停用的组不能当上游
    groupNames.value = payload.groups.filter((g) => !g.kind && g.enabled !== false).map((g) => g.name)
    nodeOptions.value = payload.availableNodes
  } catch (error) {
    showNotification({ content: 'routingLoadFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  } finally {
    loading.value = false
  }
}
onMounted(load)

const summary = (chain: OpenboxChainProxy) => {
  const node = chain.node ? `${chain.node.type} · ${chain.node.server}:${chain.node.port}` : ''
  return [node, `→ ${chain.upstream}`].filter(Boolean).join('  ')
}

// 整份写回;服务端校验不过(重名、上游自己、节点内容解析失败等)会回一句话,原样提示。
// 发出去的只留可写的字段,node 摘要由服务端按 link 重算
const persist = async (next: OpenboxChainProxy[]) => {
  saving.value = true
  try {
    const plain = next.map(({ id, enabled, name, link, upstream }) => ({ id, enabled, name, link, upstream }))
    const profile = await saveProfile({ chainProxies: plain })
    chains.value = profile.chainProxies ?? []
    showNotification({ content: 'chainSaved', type: 'alert-success' })
    return true
  } catch (error) {
    showNotification({ content: 'saveFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
    return false
  } finally {
    saving.value = false
  }
}

const toggleEnabled = (chain: OpenboxChainProxy) => {
  void persist(chains.value.map((c) => (c.id === chain.id ? { ...c, enabled: c.enabled === false } : c)))
}

// ---------- 编辑 ----------
const showEditor = ref(false)
const editing = ref<OpenboxChainProxy | null>(null)
const draft = ref({ id: '', enabled: true, name: '', link: '', upstream: '' })
const testing = ref(false)
const testResult = ref<OpenboxChainLatencyResult | null>(null)

const openEditor = (chain: OpenboxChainProxy | null) => {
  editing.value = chain
  draft.value = chain
    ? { id: chain.id, enabled: chain.enabled !== false, name: chain.name, link: chain.link, upstream: chain.upstream }
    : { id: `chain-${Date.now().toString(36)}`, enabled: true, name: '', link: '', upstream: '' }
  testResult.value = null
  showEditor.value = true
}

// 上游可选:节点、节点组;别的链式代理也能当上游(服务端会查环),自己不行
const pickerOptions = computed(() => {
  const self = editing.value?.name
  const seen = new Set<string>()
  const nodes: Array<{ name: string; subscription: string }> = []
  const push = (name: string, subscription: string) => {
    if (!name || name === self || seen.has(name)) return
    seen.add(name)
    nodes.push({ name, subscription })
  }
  for (const n of nodeOptions.value) push(n.name, n.subscription)
  for (const c of chains.value) if (c.id !== draft.value.id) push(c.name, t('chainBadge'))
  return { builtin: [], groups: groupNames.value.filter((name) => name !== self), nodes }
})

const saveDraft = async () => {
  const name = draft.value.name.trim()
  const upstream = draft.value.upstream.trim()
  const link = draft.value.link.trim()
  if (!name) return showNotification({ content: 'chainNameRequired', type: 'alert-error' })
  if (!upstream) return showNotification({ content: 'chainUpstreamRequired', type: 'alert-error' })
  if (!link) return showNotification({ content: 'chainLinkRequired', type: 'alert-error' })
  const item: OpenboxChainProxy = { id: draft.value.id, enabled: draft.value.enabled, name, link, upstream }
  const next = editing.value ? chains.value.map((c) => (c.id === item.id ? item : c)) : [...chains.value, item]
  if (await persist(next)) showEditor.value = false
}

// ---------- 删除 ----------
const showDelete = ref(false)
const pendingDelete = ref<OpenboxChainProxy | null>(null)
const askDelete = (chain: OpenboxChainProxy) => {
  pendingDelete.value = chain
  showDelete.value = true
}
const confirmDelete = async () => {
  const target = pendingDelete.value
  if (!target) return
  if (await persist(chains.value.filter((c) => c.id !== target.id))) {
    showDelete.value = false
    pendingDelete.value = null
  }
}

// ---------- 测速 / IP 地区 ----------
// 面板设置里选的 IP 信息接口排第一,其余依次兜底(后端只认这几家的主机名)
const IP_URLS = [
  { api: IP_INFO_API.IPSB, url: 'https://api.ip.sb/geoip' },
  { api: IP_INFO_API.IPWHOIS, url: 'https://ipwho.is' },
  { api: IP_INFO_API.IPAPI, url: 'https://api.ipapi.is' },
]
const ipUrls = () =>
  [...IP_URLS.filter((x) => x.api === IPInfoAPI.value), ...IP_URLS.filter((x) => x.api !== IPInfoAPI.value)].map((x) => x.url)

const runTest = async () => {
  if (testing.value) return
  const link = draft.value.link.trim()
  const upstream = draft.value.upstream.trim()
  if (!link) return showNotification({ content: 'chainLinkRequired', type: 'alert-error' })
  if (!upstream) return showNotification({ content: 'chainUpstreamRequired', type: 'alert-error' })
  testing.value = true
  testResult.value = null
  const base = { link, upstream, testUrl: speedtestUrl.value, timeoutMs: speedtestTimeout.value }
  try {
    try {
      testResult.value = await testChainLatency({ ...base, ipUrls: ipUrls() })
    } catch (error) {
      // 后端的 IP 接口白名单和这里对不上时只丢掉 IP 信息,延迟照测
      if (!/ipUrls/.test(errorMessage(error))) throw error
      testResult.value = await testChainLatency(base)
    }
  } catch (error) {
    testResult.value = { via: '', ok: false, error: errorMessage(error) }
  } finally {
    testing.value = false
  }
}

// 后端把 IP 信息接口的正文原样交回,这里按答话那一家的格式取出 IP、国家、运营商
const ipSummary = computed(() => {
  const ip = testResult.value?.ip
  if (!ip) return ''
  if (!ip.ok) return t('chainIpFailed', { message: ip.error || '' })
  try {
    const data = JSON.parse(ip.body || '{}')
    const host = new URL(ip.url || '').hostname
    const [country, org] =
      host === 'api.ipapi.is'
        ? [data.location?.country, data.asn?.org]
        : host === 'ipwho.is'
          ? [data.country, data.connection?.org]
          : [data.country, data.organization]
    return t('chainIpResult', { ip: data.ip, info: [country, org].filter(Boolean).join(' ') })
  } catch {
    return ''
  }
})
</script>
