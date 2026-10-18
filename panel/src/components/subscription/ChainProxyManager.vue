<template>
  <!-- 链式代理页(对齐 v0.1.311):没有标题卡片;添加按钮 Teleport 到顶部页签栏右上角的「+」
       (和共享网络页一样);空的时候中间再放一个图标和「添加链式代理」按钮,否则直接是列表。 -->
  <div class="flex flex-col gap-2">
    <Teleport
      defer
      to="#settings-header-actions"
    >
      <button
        type="button"
        class="btn btn-primary btn-circle btn-sm"
        v-tip="$t('chainProxyAdd')"
        :aria-label="$t('chainProxyAdd')"
        @click="openEditor(null)"
      >
        <PlusIcon class="h-4 w-4" />
      </button>
    </Teleport>

    <div
      v-if="loading"
      class="flex justify-center py-16"
    >
      <span class="loading loading-spinner loading-sm" />
    </div>

    <div
      v-else-if="!chains.length"
      class="flex flex-col items-center gap-3 py-14 text-center"
    >
      <LinkIcon class="text-base-content/30 h-10 w-10" />
      <p class="text-base-content/60 text-sm">
        {{ $t('chainProxyEmptyHint') }}
        <MarketLink />
        {{ $t('chainProxyEmptyHintSuffix') }}
      </p>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        @click="openEditor(null)"
      >
        <PlusIcon class="h-4 w-4" />
        {{ $t('chainProxyAdd') }}
      </button>
    </div>

    <template v-else>
      <div class="card bg-base-100 border-base-300/60 border">
        <div class="card-body gap-2 p-4">
          <div
            v-for="chain in chains"
            :key="chain.id"
            class="border-base-content/10 flex flex-row items-center gap-2 rounded-lg border p-3"
            :class="chain.enabled === false && 'opacity-50'"
          >
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="max-w-full truncate text-base font-medium">{{ chain.name }}</span>
                <span class="badge badge-outline badge-sm shrink-0 whitespace-nowrap">{{ $t('chainProxyVia', { upstream: chain.upstream }) }}</span>
                <!-- 逐条测速的结果(点右边的闪电):延迟 + 出口 IP。没进内核的链路是单独发请求测的,延迟会偏高 -->
                <template v-if="rowInfos[chain.id] && !testingIds.has(chain.id)">
                  <span
                    v-if="rowInfos[chain.id].ok"
                    class="text-xs font-medium"
                    :class="latencyClass(rowInfos[chain.id].ms)"
                    v-tip="inKernel(chain) ? '' : $t('chainProxyLatencyNotInKernel')"
                  >{{ rowInfos[chain.id].ms }} ms</span>
                  <span
                    v-else
                    class="text-error shrink-0 text-xs"
                    v-tip="rowInfos[chain.id].error"
                  >{{ $t('chainProxyTestFailed') }}</span>
                  <span
                    v-if="rowInfos[chain.id].ipText"
                    class="text-base-content/70 min-w-0 truncate text-xs"
                  >{{ rowInfos[chain.id].ipText }}</span>
                  <span
                    v-else-if="rowInfos[chain.id].ipFailed"
                    class="text-warning shrink-0 text-xs"
                    v-tip="rowInfos[chain.id].ipError"
                  >{{ $t('chainProxyIpUnknown') }}</span>
                </template>
                <StatusBadge
                  v-if="chain.enabled === false"
                  :on="false"
                  on-text=""
                  :off-text="$t('groupDisabledBadge')"
                />
                <span
                  v-if="upstreamMissing(chain)"
                  class="text-warning text-xs"
                >{{ $t('chainProxyUpstreamMissing', { name: chain.upstream }) }}</span>
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
              :aria-label="$t('chainProxyTest')"
              v-tip="$t('chainProxyTest')"
              :disabled="testingIds.has(chain.id)"
              @click="testRow(chain)"
            >
              <span
                v-if="testingIds.has(chain.id)"
                class="loading loading-spinner loading-xs"
              />
              <BoltIcon
                v-else
                class="h-4 w-4"
              />
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
    </template>

    <DialogWrapper
      v-model="showEditor"
      :title="$t(editing ? 'chainProxyEditTitle' : 'chainProxyAddTitle')"
      box-class="w-full max-w-xl"
    >
      <div class="flex flex-col gap-4 text-sm">
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('chainProxyNameLabel') }}</label>
          <input
            v-model="draft.name"
            type="text"
            maxlength="64"
            class="input input-sm w-full"
            :placeholder="$t('chainProxyNamePlaceholder')"
          />
        </div>

        <!-- 节点:「链接」粘一条分享链接 / 节点配置;「字段」按住宅代理商表格里的账号一栏栏填,保存时拼成链接 -->
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between gap-2">
            <label class="text-xs font-medium">{{ $t('chainProxyLinkLabel') }}</label>
            <div
              role="tablist"
              class="tabs-box tabs tabs-xs w-fit"
            >
              <a
                v-for="m in MODES"
                :key="m.value"
                role="tab"
                class="tab"
                :class="mode === m.value && 'tab-active'"
                @click="setMode(m.value)"
              >{{ $t(m.label) }}</a>
            </div>
          </div>

          <template v-if="mode === 'link'">
            <textarea
              v-model="draft.link"
              rows="4"
              spellcheck="false"
              class="textarea textarea-sm w-full font-mono"
              :placeholder="$t('chainProxyLinkPlaceholder')"
            />
            <p class="text-base-content/50 text-xs">{{ $t('chainProxyLinkHint') }}</p>
          </template>
          <template v-else>
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-[7rem_1fr_6rem]">
              <select
                v-model="fields.scheme"
                class="select select-sm w-full"
              >
                <option
                  v-for="s in SCHEMES"
                  :key="s.value"
                  :value="s.value"
                >{{ s.label }}</option>
              </select>
              <input
                v-model.trim="fields.host"
                type="text"
                spellcheck="false"
                class="input input-sm w-full font-mono"
                :placeholder="$t('chainProxyHostLabel')"
              />
              <input
                v-model.trim="fields.port"
                type="text"
                inputmode="numeric"
                class="input input-sm w-full font-mono"
                :placeholder="$t('chainProxyPortLabel')"
              />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <input
                v-model="fields.username"
                type="text"
                autocomplete="off"
                spellcheck="false"
                class="input input-sm w-full font-mono"
                :placeholder="$t('chainProxyUserLabel')"
              />
              <input
                v-model="fields.password"
                type="text"
                autocomplete="off"
                spellcheck="false"
                class="input input-sm w-full font-mono"
                :placeholder="$t('chainProxyPassLabel')"
              />
            </div>
            <p class="text-base-content/50 text-xs">{{ $t('chainProxyFieldsHint') }}</p>
          </template>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('chainProxyUpstreamLabel') }}</label>
          <OutboundPicker
            v-model="draft.upstream"
            :options="pickerOptions"
            :placeholder="$t('outboundPickerPlaceholder')"
          />
          <p class="text-base-content/50 text-xs">{{ $t('chainProxyHint') }}</p>
        </div>

        <!-- 测速:结果和按钮同一行,出口信息只占一行小字 -->
        <div class="flex flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
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
              {{ $t('chainProxyTest') }}
            </button>
            <template v-if="testResult && !testing">
              <span
                v-if="testResult.ok"
                class="font-medium"
                :class="latencyClass(testResult.ms ?? 0)"
              >{{ testResult.ms ?? 0 }} ms</span>
              <span
                v-else
                class="text-error text-xs break-all"
              >{{ $t('chainProxyTestFailed') }}</span>
              <span
                v-if="testResult.via"
                class="text-base-content/50 text-xs"
              >{{ $t('chainProxyTestVia', { via: testResult.via }) }}</span>
              <a
                v-if="exitIp"
                :href="ipDetailUrl(exitIp.ip)"
                target="_blank"
                rel="noopener noreferrer"
                class="link link-hover ml-auto inline-flex shrink-0 items-center gap-0.5 text-xs"
                v-tip="$t('chainProxyIpDetailTip', { site: IP_DETAIL_SITE })"
              >
                {{ $t('chainProxyIpDetail') }}
                <ArrowTopRightOnSquareIcon class="h-3 w-3" />
              </a>
            </template>
          </div>
          <div
            v-if="testResult && !testing && ipSummary"
            class="text-base-content/70 text-xs break-all"
          >
            {{ ipSummary }}
          </div>
          <p class="text-base-content/50 text-xs">{{ $t('chainProxyTestHint') }}</p>
        </div>
      </div>

      <!-- 取消 / 保存放在弹窗底栏,和内容区分开 -->
      <template #footer>
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
      </template>
    </DialogWrapper>

    <DialogWrapper
      v-model="showDelete"
      :title="$t('chainProxyTab')"
    >
      <div class="flex flex-col gap-4 p-2">
        <p class="text-sm">{{ $t('chainProxyDeleteConfirm', { name: pendingDelete?.name || '' }) }}</p>
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
import MarketLink from '@/components/common/MarketLink.vue'
import { fetchNodeGroups, fetchProfile, saveProfile, testChainLatency } from '@/api/openbox'
import type { OpenboxChainLatencyResult, OpenboxChainProxy } from '@/api/openbox'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import OutboundPicker from '@/components/common/OutboundPicker.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { IP_INFO_API } from '@/constant'
import { showNotification } from '@/helper/notification'
import { IPInfoAPI, speedtestTimeout, speedtestUrl } from '@/store/settings'
import {
  ArrowTopRightOnSquareIcon,
  BoltIcon,
  LinkIcon,
  PencilSquareIcon,
  PlusIcon,
  PowerIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const chains = ref<OpenboxChainProxy[]>([])
const groupNames = ref<string[]>([])
// 所有已知的节点 / 节点组名(含已停用、内置的),判断上游是否还在
const knownNames = ref<Set<string>>(new Set())
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
    knownNames.value = new Set([...payload.groups.map((g) => g.name), ...payload.availableNodes.map((n) => n.name)])
  } catch (error) {
    showNotification({ content: 'routingLoadFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  } finally {
    loading.value = false
  }
}
onMounted(load)

// 上游已经在名字后面的「经 xxx」徽标里了,这一行只写节点本身
const summary = (chain: OpenboxChainProxy) =>
  chain.node ? `${chain.node.type} · ${chain.node.server}:${chain.node.port}` : ''

// 上游「已不存在」:既不是节点 / 节点组,也不是另一条链式代理
const upstreamMissing = (chain: OpenboxChainProxy) =>
  !!chain.upstream &&
  !knownNames.value.has(chain.upstream) &&
  !chains.value.some((c) => c.id !== chain.id && c.name === chain.upstream)

// 这条链路有没有进内核:启用着、上游也还在才进
const inKernel = (chain: OpenboxChainProxy) => chain.enabled !== false && !upstreamMissing(chain)

// 整份写回;服务端校验不过(重名、上游自己、节点内容解析失败等)会回一句话,原样提示。
// 发出去的只留可写的字段,node 摘要由服务端按 link 重算
const persist = async (next: OpenboxChainProxy[]) => {
  saving.value = true
  try {
    const plain = next.map(({ id, enabled, name, link, upstream }) => ({ id, enabled, name, link, upstream }))
    const profile = await saveProfile({ chainProxies: plain })
    chains.value = profile.chainProxies ?? []
    showNotification({ content: 'chainProxySaved', type: 'alert-success' })
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

// ---------- 节点的两种填法 ----------
type Mode = 'link' | 'fields'
type Scheme = 'http' | 'https' | 'socks5'
const MODES: { value: Mode; label: string }[] = [
  { value: 'link', label: 'chainProxyModeLink' },
  { value: 'fields', label: 'chainProxyModeFields' },
]
const SCHEMES: { value: Scheme; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
]
const emptyFields = () => ({ scheme: 'http' as Scheme, host: '', port: '', username: '', password: '' })
const mode = ref<Mode>('fields')
const fields = ref(emptyFields())

// 只认「协议://[用户名:密码@]主机:端口」这一种形状;别的(ss:// vless:// 或一段配置)只能用「链接」填
const LINK_RE = /^(https?|socks5):\/\/(?:([^:@/\s]*):([^@/\s]*)@)?(\[[^\]]+\]|[^:/\s@]+):(\d{1,5})\/?$/i
const safeDecode = (text: string) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
const parseLink = (link: string) => {
  const m = LINK_RE.exec(link.trim())
  if (!m) return null
  return {
    scheme: m[1].toLowerCase() as Scheme,
    host: m[4].replace(/^\[|\]$/g, ''),
    port: m[5],
    username: safeDecode(m[2] ?? ''),
    password: safeDecode(m[3] ?? ''),
  }
}
const composeLink = (): string | null => {
  const f = fields.value
  const host = f.host.trim()
  const port = Number(f.port)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const hostText = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const auth = f.username ? `${encodeURIComponent(f.username)}:${encodeURIComponent(f.password)}@` : ''
  return `${f.scheme}://${auth}${hostText}:${port}`
}

const setMode = (next: Mode) => {
  if (mode.value === next) return
  if (next === 'link') {
    // 字段填全了就把拼好的链接带过去,免得切过去是一片空白
    const link = composeLink()
    if (link) draft.value.link = link
  } else {
    const parsed = parseLink(draft.value.link)
    if (parsed) fields.value = parsed
  }
  mode.value = next
}

// 当前这种填法下要保存 / 测速的链接;填得不对就提示并返回 null
const effectiveLink = (): string | null => {
  if (mode.value === 'link') {
    const link = draft.value.link.trim()
    if (!link) {
      showNotification({ content: 'chainProxyErrLink', type: 'alert-error' })
      return null
    }
    return link
  }
  if (!fields.value.host.trim()) {
    showNotification({ content: 'chainProxyErrHost', type: 'alert-error' })
    return null
  }
  const link = composeLink()
  if (!link) showNotification({ content: 'chainProxyErrPort', type: 'alert-error' })
  return link
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
  // 新建默认按字段填;编辑时链接是标准的 http / socks5 就拆成字段,否则留在「链接」里
  const parsed = chain ? parseLink(chain.link) : null
  fields.value = parsed ?? emptyFields()
  mode.value = !chain || parsed ? 'fields' : 'link'
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
  for (const c of chains.value) if (c.id !== draft.value.id) push(c.name, t('chainProxyTab'))
  return { builtin: [], groups: groupNames.value.filter((name) => name !== self), nodes }
})

const saveDraft = async () => {
  const name = draft.value.name.trim()
  const upstream = draft.value.upstream.trim()
  if (!name) return showNotification({ content: 'chainProxyErrName', type: 'alert-error' })
  if (!upstream) return showNotification({ content: 'chainProxyErrUpstream', type: 'alert-error' })
  if (upstream === name) return showNotification({ content: 'chainProxyErrSelf', type: 'alert-error' })
  const link = effectiveLink()
  if (!link) return
  const item: OpenboxChainProxy = { id: draft.value.id, enabled: draft.value.enabled, name, link, upstream }
  const next = editing.value ? chains.value.map((c) => (c.id === item.id ? item : c)) : [...chains.value, item]
  if (await persist(next)) {
    delete rowTests.value[item.id]
    showEditor.value = false
  }
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
    delete rowTests.value[target.id]
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

// 延迟的颜色:越慢越偏红
const latencyClass = (ms: number) => (ms < 300 ? 'text-success' : ms < 800 ? 'text-warning' : 'text-error')

// 经这条链路发一次测速请求;后端的 IP 接口白名单和这里对不上时只丢掉 IP 信息,延迟照测
type ChainTestBase = Omit<Parameters<typeof testChainLatency>[0], 'ipUrls'>
const requestChainTest = async (base: ChainTestBase) => {
  try {
    return await testChainLatency({ ...base, ipUrls: ipUrls() })
  } catch (error) {
    if (!/ipUrls/.test(errorMessage(error))) throw error
    return await testChainLatency(base)
  }
}

const runTest = async () => {
  if (testing.value) return
  const link = effectiveLink()
  if (!link) return
  const upstream = draft.value.upstream.trim()
  if (!upstream) return showNotification({ content: 'chainProxyErrUpstream', type: 'alert-error' })
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await requestChainTest({
      link,
      upstream,
      testUrl: speedtestUrl.value,
      timeoutMs: speedtestTimeout.value,
    })
  } catch (error) {
    testResult.value = { via: '', ok: false, error: errorMessage(error) }
  } finally {
    testing.value = false
  }
}

// 后端把 IP 信息接口的正文原样交回,这里按答话那一家的格式取出 IP、国家、运营商
const parseExitIp = (ip: NonNullable<OpenboxChainLatencyResult['ip']>) => {
  try {
    const data = JSON.parse(ip.body || '{}')
    const host = new URL(ip.url || '').hostname
    const [country, org] =
      host === 'api.ipapi.is'
        ? [data.location?.country, data.asn?.org]
        : host === 'ipwho.is'
          ? [data.country, data.connection?.org]
          : [data.country, data.organization]
    const address = String(data.ip ?? '')
    return address ? { ip: address, place: [country, org].filter(Boolean).join(' ') } : null
  } catch {
    return null
  }
}

const ipSummary = computed(() => {
  const ip = testResult.value?.ip
  if (!ip) return ''
  if (!ip.ok) return t('chainProxyIpFailed', { error: ip.error || '' })
  const exit = parseExitIp(ip)
  return exit ? `${t('chainProxyExitIp')} ${exit.ip} · ${exit.place}` : ''
})

// 测速通过后,在 IP 详情站点查看这个出口 IP(和节点信息面板用同一个站点)
const IP_DETAIL_SITE = 'ping0.cc'
const ipDetailUrl = (ip: string) => `https://${IP_DETAIL_SITE}/ip/${encodeURIComponent(ip)}`
const exitIp = computed(() => {
  const ip = testResult.value?.ip
  return ip?.ok ? parseExitIp(ip) : null
})

// ---------- 列表里逐条测速 ----------
interface RowInfo {
  ok: boolean
  ms: number
  error: string
  ipText: string
  ipFailed: boolean
  ipError: string
}
const rowTests = ref<Record<string, OpenboxChainLatencyResult>>({})
const testingIds = ref<Set<string>>(new Set())

const rowInfos = computed(() => {
  const infos: Record<string, RowInfo> = {}
  for (const [id, result] of Object.entries(rowTests.value)) {
    const exit = result.ip?.ok ? parseExitIp(result.ip) : null
    infos[id] = {
      ok: result.ok,
      ms: result.ms ?? 0,
      error: result.error ?? '',
      ipText: exit ? [exit.ip, exit.place].filter(Boolean).join(' · ') : '',
      ipFailed: !!result.ip && !result.ip.ok,
      ipError: result.ip?.error ?? '',
    }
  }
  return infos
})

const testRow = async (chain: OpenboxChainProxy) => {
  if (testingIds.value.has(chain.id)) return
  testingIds.value = new Set(testingIds.value).add(chain.id)
  try {
    rowTests.value[chain.id] = await requestChainTest({
      link: chain.link,
      upstream: chain.upstream,
      testUrl: speedtestUrl.value,
      timeoutMs: speedtestTimeout.value,
    })
  } catch (error) {
    rowTests.value[chain.id] = { via: '', ok: false, error: errorMessage(error) }
  } finally {
    const rest = new Set(testingIds.value)
    rest.delete(chain.id)
    testingIds.value = rest
  }
}
</script>
