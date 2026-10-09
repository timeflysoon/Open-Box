<template>
  <!-- 地区分流编辑:每个分组 = 一组地区 + 规则 + 兜底 + DNS。整份保存,不用重启内核 -->
  <div class="card">
    <div class="app-card-inset flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-base font-medium">{{ $t('clientAppRegionsTitle') }}</span>
        <span class="badge badge-outline badge-sm">
          {{ $t(info.shareRegionsCustomized ? 'clientAppRegionsCustom' : 'clientAppRegionsDefault') }}
        </span>
        <div class="ml-auto flex items-center gap-1">
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            v-tip="$t('clientAppAddGroup')"
            :disabled="groups.length >= SHARE_REGION_LIMITS.groups"
            @click="addGroup"
          >
            <PlusIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            v-tip="$t('clientAppResetDefault')"
            :disabled="saving"
            @click="reset"
          >
            <ArrowUturnLeftIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="saving"
            @click="save"
          >
            <span
              v-if="saving"
              class="loading loading-spinner loading-xs"
            />
            {{ $t('save') }}
          </button>
        </div>
      </div>
      <p class="text-base-content/60 text-xs">{{ $t('clientAppRegionsHint') }}</p>
      <p
        v-if="info.lanSubnets.length"
        class="text-base-content/60 text-xs"
      >
        {{ $t('clientAppRegionsLanNote', { subnets: info.lanSubnets.join(', ') }) }}
      </p>

      <div
        v-for="(g, gi) in groups"
        :key="g.id"
        class="border-base-content/10 flex flex-col gap-3 rounded-lg border p-3"
      >
        <div class="flex items-center gap-2">
          <span class="badge badge-outline badge-sm font-mono">{{ g.id }}</span>
          <span
            v-if="g.default"
            class="badge badge-primary badge-sm"
          >
            {{ $t('clientAppGroupDefault') }}
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm ml-auto"
            v-tip="$t('delete')"
            :disabled="groups.length <= 1"
            @click="removeGroup(gi)"
          >
            <TrashIcon class="h-4 w-4" />
          </button>
        </div>

        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('clientAppGroupName') }}</label>
            <input
              v-model="g.name"
              type="text"
              class="input input-sm w-full"
              :maxlength="SHARE_REGION_LIMITS.nameMax"
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('clientAppGroupDesc') }}</label>
            <input
              v-model="g.description"
              type="text"
              class="input input-sm w-full"
              :maxlength="SHARE_REGION_LIMITS.descriptionMax"
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('clientAppGroupRegions') }}</label>
            <input
              :value="g.regions.join(' ')"
              type="text"
              class="input input-sm w-full font-mono"
              placeholder="CN HK MO"
              @change="setRegions(g, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('clientAppRegionMatch') }}</label>
            <select
              class="select select-sm w-full"
              :value="g.regionMatch === 'outside' ? 'outside' : 'inside'"
              @change="setMatch(g, ($event.target as HTMLSelectElement).value)"
            >
              <option value="inside">{{ $t('clientAppMatchInside') }}</option>
              <option value="outside">{{ $t('clientAppMatchOutside') }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('clientAppCatchAll') }}</label>
            <select
              v-model="g.catchAll"
              class="select select-sm w-full"
            >
              <option value="direct">{{ $t('clientAppActionDirect') }}</option>
              <option value="proxy">{{ $t('clientAppActionProxy') }}</option>
            </select>
          </div>
          <label class="flex cursor-pointer items-center gap-2 pt-5 text-sm">
            <input
              type="radio"
              class="radio radio-sm"
              name="share-region-default"
              :checked="g.default === true"
              @change="setDefault(g)"
            />
            {{ $t('clientAppGroupDefaultHint') }}
          </label>
        </div>

        <!-- 规则:按顺序匹配,先命中的先生效 -->
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <label class="text-xs font-medium">{{ $t('clientAppRules') }}</label>
            <button
              type="button"
              class="btn btn-ghost btn-xs ml-auto"
              :disabled="g.rules.length >= SHARE_REGION_LIMITS.rulesPerGroup"
              @click="addRule(g)"
            >
              <PlusIcon class="h-3.5 w-3.5" />
              {{ $t('clientAppAddRule') }}
            </button>
          </div>
          <div
            v-for="(r, ri) in g.rules"
            :key="ri"
            class="flex flex-wrap items-center gap-1"
          >
            <select
              v-model="r.type"
              class="select select-sm w-36"
            >
              <option
                v-for="t in SHARE_REGION_RULE_TYPES"
                :key="t"
                :value="t"
              >
                {{ t }}
              </option>
            </select>
            <input
              v-model="r.value"
              type="text"
              class="input input-sm min-w-0 flex-1 font-mono text-xs"
              :placeholder="$t('clientAppRuleValue')"
            />
            <select
              v-model="r.action"
              class="select select-sm w-28"
            >
              <option value="direct">{{ $t('clientAppActionDirect') }}</option>
              <option value="proxy">{{ $t('clientAppActionProxy') }}</option>
            </select>
            <button
              type="button"
              class="btn btn-ghost btn-square btn-sm"
              @click="g.rules.splice(ri, 1)"
            >
              <TrashIcon class="h-4 w-4" />
            </button>
          </div>
        </div>

        <!-- DNS:直连 / 代理各一条主上游 + 备用 -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium">{{ $t('clientAppDns') }}</label>
          <div
            v-for="side in SIDES"
            :key="side"
            class="flex flex-col gap-1"
          >
            <span class="text-base-content/60 text-xs">
              {{ $t(side === 'direct' ? 'clientAppDnsDirect' : 'clientAppDnsProxy') }}
            </span>
            <div class="flex flex-wrap items-center gap-1">
              <input
                :value="main(g, side).server"
                type="text"
                class="input input-sm min-w-0 flex-1 font-mono text-xs"
                :placeholder="$t('clientAppDnsServerPlaceholder')"
                @input="setMain(g, side, 'server', ($event.target as HTMLInputElement).value)"
              />
              <select
                class="select select-sm w-20"
                :value="main(g, side).protocol"
                :disabled="main(g, side).server === 'wan'"
                @change="setMain(g, side, 'protocol', ($event.target as HTMLSelectElement).value)"
              >
                <option value="udp">UDP</option>
                <option value="tcp">TCP</option>
              </select>
              <input
                :value="main(g, side).port"
                type="number"
                min="1"
                max="65535"
                class="input input-sm w-24"
                :disabled="main(g, side).server === 'wan'"
                @input="setMain(g, side, 'port', Number(($event.target as HTMLInputElement).value))"
              />
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                @click="addExtra(g, side)"
              >
                <PlusIcon class="h-3.5 w-3.5" />
                {{ $t('clientAppDnsAddBackup') }}
              </button>
            </div>
            <div
              v-for="(x, xi) in extrasOf(g, side)"
              :key="xi"
              class="flex flex-wrap items-center gap-1 pl-4"
            >
              <input
                v-model="x.server"
                type="text"
                class="input input-sm min-w-0 flex-1 font-mono text-xs"
                :placeholder="$t('clientAppDnsServerPlaceholder')"
              />
              <select
                v-model="x.protocol"
                class="select select-sm w-20"
              >
                <option value="udp">UDP</option>
                <option value="tcp">TCP</option>
              </select>
              <input
                v-model.number="x.port"
                type="number"
                min="1"
                max="65535"
                class="input input-sm w-24"
              />
              <button
                type="button"
                class="btn btn-ghost btn-square btn-sm"
                @click="extrasOf(g, side).splice(xi, 1)"
              >
                <TrashIcon class="h-4 w-4" />
              </button>
            </div>
          </div>
          <p class="text-base-content/50 text-xs">{{ $t('clientAppDnsHint') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  saveShareRegions,
  SHARE_REGION_LIMITS,
  SHARE_REGION_RULE_TYPES,
  type OpenboxClientAppInfo,
  type OpenboxShareDnsUpstream,
  type OpenboxShareRegionGroup,
} from '@/api/clientApp'
import { showNotification } from '@/helper/notification'
import { ArrowUturnLeftIcon, PlusIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

type Side = 'direct' | 'proxy'

const props = defineProps<{ info: OpenboxClientAppInfo }>()
const emit = defineEmits<{ saved: [] }>()

const { t } = useI18n()

const SIDES: Side[] = ['direct', 'proxy']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const groups = ref<OpenboxShareRegionGroup[]>([])
const saving = ref(false)

watch(
  () => props.info,
  (info) => {
    groups.value = clone(info.shareRegions)
  },
  { immediate: true },
)

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ---- 编辑辅助 ----

const setRegions = (g: OpenboxShareRegionGroup, text: string) => {
  g.regions = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ]
}

const setMatch = (g: OpenboxShareRegionGroup, value: string) => {
  if (value === 'outside') g.regionMatch = 'outside'
  else delete g.regionMatch
}

const setDefault = (g: OpenboxShareRegionGroup) => {
  for (const x of groups.value) {
    if (x === g) x.default = true
    else delete x.default
  }
}

const addRule = (g: OpenboxShareRegionGroup) => {
  g.rules.push({ type: 'domainSuffix', value: '', action: 'proxy' })
}

const newId = () => {
  const used = new Set(groups.value.map((g) => g.id))
  for (;;) {
    const id = `g${Math.random().toString(36).slice(2, 8)}`
    if (!used.has(id)) return id
  }
}

const addGroup = () => {
  // DNS 先抄默认「其他地区」那一组(两侧都是系统 DNS);没有就给个能过校验的
  const template = props.info.defaultShareRegions.find((g) => g.id === 'other')
  groups.value.push({
    id: newId(),
    name: '',
    description: '',
    regions: [],
    rules: [],
    catchAll: 'direct',
    dns: template
      ? clone(template.dns)
      : {
          direct: 'wan',
          directProtocol: 'udp',
          directPort: 53,
          directExtras: [],
          proxy: 'wan',
          proxyProtocol: 'udp',
          proxyPort: 53,
          proxyExtras: [],
        },
  })
}

const removeGroup = (index: number) => {
  const [removed] = groups.value.splice(index, 1)
  // 删掉的是默认组:把默认交给第一组,免得保存时报「必须有一个默认组」
  if (removed?.default && groups.value.length) groups.value[0].default = true
}

const main = (g: OpenboxShareRegionGroup, side: Side): OpenboxShareDnsUpstream =>
  side === 'direct'
    ? { server: g.dns.direct, protocol: g.dns.directProtocol, port: g.dns.directPort }
    : { server: g.dns.proxy, protocol: g.dns.proxyProtocol, port: g.dns.proxyPort }

const setMain = (
  g: OpenboxShareRegionGroup,
  side: Side,
  key: 'server' | 'protocol' | 'port',
  value: string | number,
) => {
  const d = g.dns
  if (key === 'server') {
    const server = String(value).trim()
    if (side === 'direct') d.direct = server
    else d.proxy = server
    // 系统 DNS 固定 UDP 53
    if (server === 'wan') {
      if (side === 'direct') [d.directProtocol, d.directPort] = ['udp', 53]
      else [d.proxyProtocol, d.proxyPort] = ['udp', 53]
    }
  } else if (key === 'protocol') {
    if (side === 'direct') d.directProtocol = String(value)
    else d.proxyProtocol = String(value)
  } else if (side === 'direct') d.directPort = Number(value)
  else d.proxyPort = Number(value)
}

const extrasOf = (g: OpenboxShareRegionGroup, side: Side): OpenboxShareDnsUpstream[] =>
  side === 'direct' ? g.dns.directExtras : g.dns.proxyExtras

const addExtra = (g: OpenboxShareRegionGroup, side: Side) => {
  extrasOf(g, side).push({ server: '', protocol: side === 'direct' ? 'udp' : 'tcp', port: 53 })
}

// ---- 校验 / 保存 ----

type Problem = { content: string; params?: Record<string, string> }

const validate = (list: OpenboxShareRegionGroup[]): Problem | null => {
  if (list.length > SHARE_REGION_LIMITS.groups) {
    return { content: 'clientAppErrTooMany', params: { n: String(SHARE_REGION_LIMITS.groups) } }
  }
  if (list.filter((g) => g.default).length !== 1) return { content: 'clientAppErrDefault' }
  const claimed = new Map<string, string>()
  for (const g of list) {
    if (!g.name) return { content: 'clientAppErrName', params: { id: g.id } }
    const bad = g.regions.find((r) => !/^[A-Z]{2}$/.test(r))
    if (bad) return { content: 'clientAppErrRegionCode', params: { value: bad } }
    if (g.regionMatch === 'outside') {
      if (!g.regions.length) return { content: 'clientAppErrOutside', params: { id: g.id } }
      continue
    }
    for (const r of g.regions) {
      const other = claimed.get(r)
      if (other) return { content: 'clientAppErrRegionDup', params: { region: r, a: other, b: g.id } }
      claimed.set(r, g.id)
    }
  }
  return null
}

const cleaned = (): OpenboxShareRegionGroup[] =>
  groups.value.map((g) => ({
    id: g.id,
    name: g.name.trim(),
    description: (g.description ?? '').trim(),
    regions: [...g.regions],
    ...(g.regionMatch === 'outside' ? { regionMatch: 'outside' as const } : {}),
    ...(g.default ? { default: true } : {}),
    rules: g.rules
      .map((r) => ({ type: r.type, value: r.value.trim(), action: r.action }))
      .filter((r) => r.value),
    catchAll: g.catchAll,
    dns: {
      ...g.dns,
      directExtras: g.dns.directExtras.filter((x) => x.server.trim()),
      proxyExtras: g.dns.proxyExtras.filter((x) => x.server.trim()),
    },
  }))

const persist = async (list: OpenboxShareRegionGroup[]) => {
  saving.value = true
  try {
    await saveShareRegions(list)
    showNotification({ content: 'clientAppSaved', type: 'alert-success' })
    emit('saved')
  } catch (error) {
    // 后端校验不过时回的是英文原因,原样给出来
    showNotification({
      content: 'saveFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
  } finally {
    saving.value = false
  }
}

const save = async () => {
  const list = cleaned()
  const problem = validate(list)
  if (problem) {
    showNotification({ content: problem.content, params: problem.params, type: 'alert-error' })
    return
  }
  await persist(list)
}

const reset = async () => {
  if (!window.confirm(t('clientAppResetConfirm'))) return
  await persist([])
}
</script>
