<template>
  <!-- 指定域名 DNS:为特定域名 / 通配子域指定直连上游。规则存在档案 dns.domainUpstreams 里,布局与 DNS 重写卡统一 -->
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4 text-sm">
      <div class="flex flex-col gap-1">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-base font-semibold">{{ $t('dnsDomainUpstreamTitle') }}</h2>
            <input
              type="checkbox"
              class="toggle toggle-sm shrink-0"
              :aria-label="$t('dnsDomainUpstreamTitle')"
              :checked="enabled"
              :disabled="saving"
              @change="toggleMaster"
            >
            <span
              class="badge badge-sm"
              :class="enabledBadge.cls"
            >{{ $t(enabledBadge.key) }}</span>
          </div>
          <button
            v-tip="$t('dnsDomainUpstreamAdd')"
            type="button"
            class="btn btn-primary btn-sm btn-square shrink-0"
            :disabled="saving"
            :aria-label="$t('dnsDomainUpstreamAdd')"
            @click="openEditor(null)"
          >
            <PlusIcon class="h-4 w-4" />
          </button>
        </div>
        <p class="text-base-content/60 text-xs leading-relaxed">{{ $t('dnsDomainUpstreamDescription') }}</p>
      </div>

      <p
        v-if="!rules.length"
        class="text-base-content/50 text-xs"
      >{{ $t('dnsDomainUpstreamEmpty') }}</p>
      <div
        v-else
        class="divide-base-content/10 divide-y"
      >
        <div
          v-for="rule in rules"
          :key="rule.id"
          class="flex items-center gap-2 py-2"
          :class="rule.enabled === false && 'opacity-50'"
        >
          <input
            type="checkbox"
            class="toggle toggle-sm shrink-0"
            :checked="rule.enabled !== false"
            :disabled="saving"
            @change="toggleRule(rule, ($event.target as HTMLInputElement).checked)"
          >
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 font-mono text-xs">
            <span class="truncate">{{ domainText(rule) }}</span>
            <span class="text-base-content/50">→</span>
            <span class="truncate">{{ serverText(rule) }}</span>
            <span
              v-if="rule.note"
              class="text-base-content/50 truncate"
            >· {{ rule.note }}</span>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-xs"
            :aria-label="$t('groupEdit')"
            @click="openEditor(rule)"
          >
            <PencilSquareIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-xs hover:text-error"
            :aria-label="$t('delete')"
            @click="askDelete(rule)"
          >
            <TrashIcon class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>

    <DialogWrapper
      v-model="showEditor"
      :title="$t(editing ? 'dnsDomainUpstreamEditTitle' : 'dnsDomainUpstreamAddTitle')"
      box-class="w-full max-w-lg"
    >
      <div
        v-if="draft"
        class="flex flex-col gap-4"
      >
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('dnsDomainUpstreamDomains') }}</label>
          <!-- 与上游一致:域名类型下拉(w-32)和域名标签输入在同一行,标签输入走公共 TagInput -->
          <div class="flex items-start gap-1.5">
            <select
              v-model="draft.matchType"
              class="select select-sm w-32 shrink-0"
              :aria-label="$t('dnsDomainUpstreamMatchType')"
            >
              <option value="domain">{{ $t('routingPolicyDomain') }}</option>
              <option value="domainSuffix">{{ $t('routingPolicyDomainSuffix') }}</option>
            </select>
            <div class="min-w-0 flex-1">
              <TagInput
                ref="domainsInput"
                v-model="draft.domains"
                v-model:pending="domainsPending"
                unique
                :separator="DOMAIN_SEPARATOR"
                :label="$t('dnsDomainUpstreamDomains')"
                :placeholder="draft.matchType === 'domain' ? $t('dnsDomainUpstreamDomainPlaceholder') : $t('dnsDomainUpstreamSuffixPlaceholder')"
              />
            </div>
          </div>
          <p class="text-base-content/50 text-xs">
            {{ $t(draft.matchType === 'domain' ? 'dnsDomainUpstreamDomainHint' : 'dnsDomainUpstreamSuffixHint') }}
          </p>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('dnsDomainUpstreamServer') }}</label>
          <!-- 顺序与上游一致:协议 → 地址 → 端口;端口输入框宽度也是上游的 w-20 -->
          <div class="flex flex-wrap items-center gap-2">
            <DnsProtocolSelect v-model="draft.protocol" />
            <input
              v-model="draft.server"
              type="text"
              class="input input-sm min-w-0 flex-1 font-mono"
              :aria-label="$t(draft.protocol === 'https' ? 'dnsUpstreamDohHost' : draft.protocol === 'tls' ? 'dnsUpstreamDotHost' : 'subscriptionNodeDnsIpPlaceholder')"
              :placeholder="draft.protocol === 'tls' || draft.protocol === 'https' ? 'dns.example.net' : $t('subscriptionNodeDnsIpPlaceholder')"
              autocomplete="off"
              spellcheck="false"
            >
            <input
              v-model="draft.port"
              type="number"
              min="1"
              max="65535"
              class="input input-sm w-20 shrink-0 font-mono"
              :aria-label="$t('port')"
              :placeholder="String(defaultPort(draft.protocol))"
            >
          </div>
          <p class="text-base-content/50 text-xs">{{ $t('dnsDomainUpstreamServerHint') }}</p>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('dnsDomainUpstreamNote') }}</label>
          <input
            v-model="draft.note"
            type="text"
            class="input input-sm w-full"
            maxlength="200"
            :placeholder="$t('dnsDomainUpstreamNotePlaceholder')"
          >
        </div>
      </div>
      <template #footer>
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
      </template>
    </DialogWrapper>

    <DialogWrapper
      v-model="showDelete"
      :title="$t('dnsDomainUpstreamDeleteTitle')"
    >
      <div class="flex flex-col gap-4">
        <p class="text-sm">{{ $t('dnsDomainUpstreamDeleteConfirm', { domain: pendingDelete ? domainText(pendingDelete) : '' }) }}</p>
      </div>
      <template #footer>
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
          {{ $t('confirm') }}
        </button>
      </template>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxDnsDomainUpstreamRule, OpenboxProfile } from '@/api/openbox'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import DnsProtocolSelect from '@/components/common/DnsProtocolSelect.vue'
import TagInput from '@/components/common/TagInput.vue'
import { serviceStatus } from '@/composables/kernelService'
import { showNotification } from '@/helper/notification'
import { PencilSquareIcon, PlusIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

// 单条规则的域名上限,与上游面板一致
const MAX_DOMAINS = 64
// 域名之间可以写逗号、顿号、空格或换行(与上游同一个口径,提示文案也是这么写的)
const DOMAIN_SEPARATOR = /[,，、\s]+/
const rules = computed<OpenboxDnsDomainUpstreamRule[]>(() => props.profile.dns?.domainUpstreams?.rules ?? [])
const enabled = computed(() => props.profile.dns?.domainUpstreams?.enabled !== false)
const saving = ref(false)

// 生效状态徽标(对齐上游 v0.1.496):不只看档案里的开关,还要看内核此刻的状态。
// 优先级与上游一致:
//   1. 内核在跑且「指定域名 DNS」属于待重启变更 → 「待重启生效」(warning)
//   2. 开关开着但内核没在跑 → 「未运行」
//   3. 开关开着且有规则 → 「已启用」(控制接口接通时上游显示 dfEnabled;这里按能否读到服务状态区分)
//   4. 开关开着但一条规则都没有 → 「已启用(无规则)」
//   5. 开关关着 → dfDisabled
const enabledBadge = computed<{ key: string; cls: string }>(() => {
  if (!enabled.value) return { key: 'dfDisabled', cls: '' }
  const st = serviceStatus.value
  const pending = st?.pendingRestart
  // 与上游一致的判据:details 里有 dns_domain_upstreams 就认明细,否则看 reasons 里有没有 dns
  const pendingThis = !!pending?.pending &&
    (pending.details?.length
      ? pending.details.includes('dns_domain_upstreams')
      : (pending.reasons ?? []).includes('dns'))
  if (st?.core?.running && pendingThis) {
    return { key: 'dnsDomainUpstreamBadgePendingRestart', cls: 'badge-warning' }
  }
  if (st && !st.core?.running) {
    return { key: 'dnsDomainUpstreamBadgeStopped', cls: '' }
  }
  if (!rules.value.length) {
    return { key: 'dnsDomainUpstreamBadgeNoRules', cls: '' }
  }
  return { key: 'dnsDomainUpstreamBadgeEnabled', cls: 'badge-success' }
})

const { t } = useI18n()
const domainText = (rule: OpenboxDnsDomainUpstreamRule) => {
  const list = rule.domains ?? []
  if (!list.length) return ''
  const head = list.slice(0, 2).join(', ')
  // 超过两个时按上游的写法补一句「+N 个域名」
  return list.length > 2 ? `${head} ${t('dnsDomainUpstreamMoreDomains', { count: list.length - 2 })}` : head
}
const defaultPort = (protocol: string) => (protocol === 'tls' ? 853 : protocol === 'https' ? 443 : 53)
const serverText = (rule: OpenboxDnsDomainUpstreamRule) => {
  const port = rule.port || defaultPort(rule.protocol || 'udp')
  if (rule.protocol === 'https') return rule.server
  if (rule.protocol === 'tls') return `${rule.server}:${port}`
  return `${rule.server}:${port} (${(rule.protocol || 'udp').toUpperCase()})`
}

const notifyError = (err: unknown) =>
  showNotification({ content: 'routingSaveFailed', params: { message: err instanceof Error ? err.message : String(err) }, type: 'alert-error' })

// 整份 rules 一次写回(数组整体替换);服务端校验不过会报错回来
const persist = async (next: OpenboxDnsDomainUpstreamRule[], nextEnabled = enabled.value) => {
  saving.value = true
  try {
    await props.patchProfile({ dns: { domainUpstreams: { enabled: nextEnabled, rules: next } } })
    // 对齐上游 v0.1.496:内核在跑、且这次改动属于「要重启才生效」的,提示里要写清楚,
    // 不然用户以为已经生效了。
    const st = serviceStatus.value
    const pendingThis = enabledBadge.value.key === 'dnsDomainUpstreamBadgePendingRestart'
    if (st?.core?.running && pendingThis) {
      showNotification({ content: 'dnsDomainUpstreamSavedRestart', type: 'alert-warning' })
    } else {
      showNotification({ content: 'dnsDomainUpstreamSaved', type: 'alert-success' })
    }
    return true
  } catch (err) {
    notifyError(err)
    return false
  } finally {
    saving.value = false
  }
}

const toggleRule = (rule: OpenboxDnsDomainUpstreamRule, on: boolean) =>
  persist(rules.value.map((r) => (r.id === rule.id ? { ...r, enabled: on } : r)))
const toggleMaster = (event: Event) => persist(rules.value, (event.target as HTMLInputElement).checked)

// ---- 编辑弹窗 ----
interface Draft {
  id: string
  matchType: 'domain' | 'domainSuffix'
  domains: string[]
  server: string
  protocol: 'udp' | 'tcp' | 'tls' | 'https'
  port: string
  note: string
}
const showEditor = ref(false)
const editing = ref<OpenboxDnsDomainUpstreamRule | null>(null)
const draft = ref<Draft | null>(null)
// 域名标签输入:还没回车提交的那半行文字放在 pending 里,保存前由 commit() 收进标签
const domainsInput = ref<InstanceType<typeof TagInput> | null>(null)
const domainsPending = ref('')

const openEditor = (rule: OpenboxDnsDomainUpstreamRule | null) => {
  editing.value = rule
  draft.value = rule
    ? {
        id: rule.id,
        matchType: rule.matchType === 'domainSuffix' ? 'domainSuffix' : 'domain',
        domains: [...(rule.domains ?? [])],
        server: rule.server,
        protocol: (rule.protocol as Draft['protocol']) || 'udp',
        port: rule.port ? String(rule.port) : '',
        note: rule.note || '',
      }
    : { id: '', matchType: 'domain', domains: [], server: '', protocol: 'udp', port: '', note: '' }
  domainsPending.value = ''
  showEditor.value = true
}

const LABEL_RE = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/
// 与上游面板同一口径:去空白、转小写、去末尾的点;后缀形态去掉开头的 *. / .;带 * 的不要
const normalizeHost = (raw: string, suffix: boolean) => {
  let s = raw.trim().toLowerCase().replace(/\.+$/, '')
  if (suffix) s = s.replace(/^\*\./, '').replace(/^\./, '').replace(/\.+$/, '')
  if (!s || s.includes('*') || s.length > 253) return ''
  return s.split('.').every((label) => LABEL_RE.test(label)) ? s : ''
}

const saveDraft = async () => {
  const d = draft.value
  if (!d || saving.value) return
  const suffix = d.matchType === 'domainSuffix'
  domainsInput.value?.commit()
  const raw = d.domains.filter(Boolean)
  const hasStar = raw.some((x) => x.includes('*'))
  if (!suffix && hasStar) {
    showNotification({ content: 'dnsDomainUpstreamBadExactDomain', type: 'alert-error' })
    return
  }
  const domains: string[] = []
  for (const item of raw) {
    const h = normalizeHost(item, suffix)
    if (h && !domains.includes(h)) domains.push(h)
  }
  if (!domains.length || domains.length > MAX_DOMAINS) {
    showNotification({ content: 'dnsDomainUpstreamBadDomains', params: { max: String(MAX_DOMAINS) }, type: 'alert-error' })
    return
  }

  // 上游地址:协议头优先(tls:// / https:// 直接改协议),wan 不接受
  let server = d.server.trim()
  let protocol = d.protocol
  if (server.toLowerCase() === 'wan') {
    showNotification({ content: 'dnsDomainUpstreamNoWan', type: 'alert-error' })
    return
  }
  const scheme = /^(https|tls|udp|tcp):\/\/(.*)$/i.exec(server)
  if (scheme) {
    protocol = scheme[1].toLowerCase() as Draft['protocol']
    server = scheme[2]
  }
  if (!server) {
    showNotification({ content: 'dnsUpstreamInvalid', type: 'alert-error' })
    return
  }
  const port = d.port.trim() === '' ? undefined : Number(d.port)
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    showNotification({ content: 'dnsUpstreamInvalid', type: 'alert-error' })
    return
  }
  const rule: OpenboxDnsDomainUpstreamRule = {
    id: d.id || `du-${Date.now().toString(36)}`,
    enabled: editing.value ? editing.value.enabled !== false : true,
    matchType: d.matchType,
    domains,
    protocol,
    server: protocol === 'https' ? (scheme ? `https://${server}` : server) : server,
    ...(port === undefined ? {} : { port }),
    // 这张卡不编辑 bootstrap(上游的卡片有),编辑时原样保留,免得改个备注就把解析地址弄丢
    ...(editing.value?.bootstrap ? { bootstrap: editing.value.bootstrap } : {}),
    ...(d.note.trim() ? { note: d.note.trim() } : {}),
  }
  const next = editing.value ? rules.value.map((r) => (r.id === editing.value?.id ? rule : r)) : [...rules.value, rule]
  if (await persist(next)) showEditor.value = false
}

// ---- 删除 ----
const showDelete = ref(false)
const pendingDelete = ref<OpenboxDnsDomainUpstreamRule | null>(null)
const askDelete = (rule: OpenboxDnsDomainUpstreamRule) => {
  pendingDelete.value = rule
  showDelete.value = true
}
const confirmDelete = async () => {
  const rule = pendingDelete.value
  if (!rule) return
  if (await persist(rules.value.filter((r) => r.id !== rule.id))) {
    showDelete.value = false
    pendingDelete.value = null
  }
}
</script>
