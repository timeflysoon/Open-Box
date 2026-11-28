<template>
  <!-- 和节点管理同一种排版:没有外层大卡片和标题,每个站点集一张独立卡片。
       「添加站点集」按钮在顶部页签栏右上角(RoutingPage 里 Teleport 过去)。 -->
  <div class="flex flex-col gap-2">
    <p
      v-if="!rows.length"
      class="text-base-content/50 px-1 text-xs"
    >
      {{ $t('routingPoliciesEmpty') }}
    </p>

    <!-- 前置自定义分流:固定置顶、删不掉,排在广告拦截和所有站点集之前。和站点集的区别是
         出口在这儿定死(而且能选到具体节点,站点集只能选到节点组),不在代理页点选。
         没选出口、或一条规则都没有时不进内核配置。 -->
    <div
      class="card bg-base-100 border-base-content/10 flex flex-row items-center gap-2 border border-dashed p-3"
      :class="customPolicy.enabled === false && 'opacity-50'"
    >
      <!-- 拖拽柄那一格照样占着,只是置灰、不给 drag-handle 类:这条固定在最前面,拖不动。
           不占位的话标题就和下面的站点集对不齐。 -->
      <Bars3Icon
        class="text-base-content/20 h-4 w-4 shrink-0 cursor-not-allowed"
        v-tip="$t('routingPinnedNoDrag')"
      />
      <CountryFlag
        v-if="customPolicy.icon"
        :code="customPolicy.icon"
        :size="18"
        :scale="customPolicy.iconScale"
      />
      <!-- 没设图标时留一个同样大小的空位,标题才对得齐 -->
      <span
        v-else
        class="h-[18px] w-[18px] shrink-0"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-base font-medium">{{ customPolicy.name }}</span>
          <span class="badge badge-ghost badge-sm shrink-0">{{ $t('routingCustomBadge') }}</span>
          <StatusBadge
            v-if="customPolicy.enabled === false"
            :on="false"
            on-text=""
            :off-text="$t('groupDisabledBadge')"
          />
        </div>
        <div class="text-base-content/60 mt-0.5 truncate text-xs">
          {{ customSummary }}
        </div>
      </div>
      <!-- 三个图标和普通站点集对齐;这条能停用、能改,但删不掉 -->
      <button
        type="button"
        class="btn btn-ghost btn-square btn-sm"
        :class="customPolicy.enabled === false ? 'text-base-content/40' : 'text-success'"
        v-tip="$t(customPolicy.enabled === false ? 'groupEnable' : 'groupDisable')"
        :aria-label="$t(customPolicy.enabled === false ? 'groupEnable' : 'groupDisable')"
        :disabled="saving"
        @click="toggleCustomEnabled"
      >
        <PowerIcon class="h-4 w-4" />
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-square btn-sm"
        v-tip="$t('edit')"
        :aria-label="$t('edit')"
        @click="openCustomEditor"
      >
        <PencilSquareIcon class="h-4 w-4" />
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-square btn-sm text-base-content/30 cursor-not-allowed"
        v-tip="$t('routingCustomNoDelete')"
        :aria-label="$t('routingCustomNoDelete')"
        aria-disabled="true"
      >
        <TrashIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- 顺序即优先级:sing-box 按首条命中生效,拖拽排序改的就是这个。拖完立刻存,
           不然刷新一下就白拖了(和节点组那边一致)。 -->
    <!-- force-fallback:用鼠标事件模拟拖拽,不走浏览器原生拖放(原生的半透明快照在各浏览器
           表现不一)。fallback-on-body 必须一起开:跟着指针走的那份克隆是 position: fixed,
           默认挂在列表父节点下;而卡片开了 backdrop-filter(面板的背景模糊),这类属性会让
           fixed 改以卡片为参照,克隆就跑到离指针老远的地方去。挂到 body 上就没有这层干扰。 -->
    <Draggable
      v-model="rows"
      :animation="150"
      :force-fallback="true"
      :fallback-on-body="true"
      handle=".drag-handle"
      ghost-class="opacity-40"
      item-key="id"
      class="flex flex-col gap-2"
      @end="persist(rows)"
    >
      <template #item="{ element: policy }">
        <div
          class="card bg-base-100 border-base-content/10 flex flex-row items-center gap-2 border p-3"
          :class="policy.enabled === false && 'opacity-50'"
        >
          <Bars3Icon class="drag-handle text-base-content/40 h-4 w-4 shrink-0 cursor-move" />
          <CountryFlag
            v-if="policy.icon"
            :code="policy.icon"
            :size="18"
            :scale="policy.iconScale"
          />
          <span
            v-else
            class="h-[18px] w-[18px] shrink-0"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-base font-medium">{{ policy.name }}</span>
              <StatusBadge
                v-if="policy.enabled === false"
                :on="false"
                on-text=""
                :off-text="$t('groupDisabledBadge')"
              />
            </div>
            <div class="text-base-content/60 mt-0.5 truncate text-xs">
              {{ conditionSummary(policy) }}
            </div>
          </div>
          <!-- 启用/停用:停用的留在列表里,不进内核配置 -->
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            :class="policy.enabled === false ? 'text-base-content/40' : 'text-success'"
            v-tip="$t(policy.enabled === false ? 'groupEnable' : 'groupDisable')"
            :aria-label="$t(policy.enabled === false ? 'groupEnable' : 'groupDisable')"
            :disabled="saving"
            @click="toggleEnabled(policy)"
          >
            <PowerIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            v-tip="$t('edit')"
            :aria-label="$t('edit')"
            @click="openEditor(policy)"
          >
            <PencilSquareIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm hover:text-error"
            v-tip="$t('delete')"
            :aria-label="$t('delete')"
            @click="askDelete(policy)"
          >
            <TrashIcon class="h-4 w-4" />
          </button>
        </div>
      </template>
    </Draggable>

    <!-- 兜底:上面都没命中的流量走它。系统生成、删不掉、拖不动——内核的 route.final
           必须指向某个出站,少了它整份配置就不成立。走哪条线路在「代理」页点选。 -->
    <div
      class="card bg-base-100 border-base-content/10 flex flex-row items-center gap-2 border border-dashed p-3"
    >
      <Bars3Icon
        class="text-base-content/20 h-4 w-4 shrink-0 cursor-not-allowed"
        v-tip="$t('routingPinnedNoDrag')"
      />
      <CountryFlag
        :code="fallbackIcon"
        :size="18"
        :scale="fallbackIconScale"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-base font-medium">{{ fallbackName }}</span>
          <span class="badge badge-ghost badge-sm shrink-0">{{ $t('routingFallbackBadge') }}</span>
        </div>
        <div class="text-base-content/60 mt-0.5 truncate text-xs">
          {{ $t('routingFallbackHint') }}
        </div>
      </div>
      <!-- 三个图标和普通站点集对齐;兜底不能停用、不能删除,这两个置灰,只能改名字和图标 -->
      <button
        type="button"
        class="btn btn-ghost btn-square btn-sm text-base-content/30 cursor-not-allowed"
        v-tip="$t('routingFallbackNoDisable')"
        :aria-label="$t('routingFallbackNoDisable')"
        aria-disabled="true"
      >
        <PowerIcon class="h-4 w-4" />
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-square btn-sm"
        v-tip="$t('edit')"
        :aria-label="$t('edit')"
        @click="openFallbackEditor"
      >
        <PencilSquareIcon class="h-4 w-4" />
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-square btn-sm text-base-content/30 cursor-not-allowed"
        v-tip="$t('routingFallbackNoDelete')"
        :aria-label="$t('routingFallbackNoDelete')"
        aria-disabled="true"
      >
        <TrashIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- 兜底站点集:只能改名字和图标 -->
    <DialogWrapper
      v-model="showFallbackEditor"
      :title="$t('routingFallbackEditTitle')"
      box-class="w-full max-w-2xl"
    >
      <div
        v-if="fallbackDraft"
        class="flex flex-col gap-4"
      >
        <div class="flex items-end gap-2">
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('groupIconLabel') }}</label>
            <div class="w-56">
              <CountrySelect
                v-model="fallbackDraft.icon"
                clearable
                globes
                brands
                :placeholder="$t('groupIconNone')"
              />
            </div>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('iconScaleLabel') }}</label>
            <IconScaleInput v-model="fallbackDraft.iconScale" />
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('routingPolicyNameLabel') }}</label>
            <input
              v-model="fallbackDraft.name"
              type="text"
              class="input input-sm w-full"
            />
          </div>
        </div>
        <p class="text-base-content/50 text-xs">{{ $t('routingFallbackEditHint') }}</p>
      </div>

      <!-- 取消 / 保存固定在底栏,和修改站点集弹窗一致 -->
      <template #footer>
        <button
          type="button"
          class="btn btn-sm"
          @click="showFallbackEditor = false"
        >
          {{ $t('cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="saving"
          @click="saveFallback"
        >
          <span
            v-if="saving"
            class="loading loading-spinner loading-xs"
          />
          {{ $t('save') }}
        </button>
      </template>
    </DialogWrapper>

    <!-- 删掉一个站点集会连带删掉内核里那个同名 selector(代理页上就没了),先确认一次 -->
    <DialogWrapper
      v-model="showDelete"
      :title="$t('routingPolicyDeleteTitle')"
    >
      <div class="flex flex-col gap-4 p-2">
        <p class="text-sm">
          {{ $t('routingPolicyDeleteConfirm', { name: pendingDelete?.name || '' }) }}
        </p>
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

    <DialogWrapper
      v-model="showEditor"
      :title="$t(editingCustom ? 'routingCustomEditTitle' : editing ? 'routingPolicyEditTitle' : 'routingPolicyAddTitle')"
      :box-class="editingCustom
        ? 'w-full max-w-4xl [&>.dialog-toolbar]:[scrollbar-gutter:stable] [&>.dialog-content]:[scrollbar-gutter:stable]'
        : 'w-full max-w-4xl'"
      mobile-fullscreen
    >
      <!-- 图标 / 名称 / 规则表头固定在上面,规则再多也只滚下面那块 -->
      <template #toolbar>
        <div
          v-if="draft"
          class="flex flex-col gap-4"
        >
          <div class="flex flex-wrap items-end gap-2">
            <div class="flex min-w-0 flex-col gap-1 max-sm:flex-1">
              <label class="text-xs font-medium">{{ $t('groupIconLabel') }}</label>
              <div class="w-56 max-sm:w-full">
                <CountrySelect
                  v-model="draft.icon"
                  clearable
                  globes
                  brands
                  :placeholder="$t('groupIconNone')"
                />
              </div>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium">{{ $t('iconScaleLabel') }}</label>
              <IconScaleInput v-model="draft.iconScale" />
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1 max-sm:basis-full">
              <label class="text-xs font-medium">{{ $t('routingPolicyNameLabel') }}</label>
              <input
                v-model="draft.name"
                type="text"
                class="input input-sm w-full"
                :placeholder="$t('routingPolicyNamePlaceholder')"
              />
            </div>
          </div>

          <!-- 一条规则一行:拖动柄 + 类型 + 值 + 备注(前置自定义分流还多一列这一行自己的出口)。
               前置自定义分流按拖动后的顺序保存(顺序即匹配顺序);站点集里各行是「或」的关系,
               拖完按类型归位,备注挂在「类型:值」上。站点集走哪条线路不在这儿定:在「代理」页点选。 -->
          <div class="flex items-center justify-between gap-2">
            <label class="text-xs font-medium">{{ $t('routingPolicyRulesLabel') }}</label>
            <div class="flex items-center gap-1">
              <button
                v-if="editingCustom"
                type="button"
                class="btn btn-ghost btn-xs shrink-0"
                @click="addTab"
              >
                <PlusIcon class="h-3.5 w-3.5" />
                {{ $t('routingCustomAddTab') }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :disabled="editingCustom && !activeTab"
                @click="openRuleImport"
              >
                {{ $t('routingPolicyRuleImport') }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :disabled="editingCustom && !activeTab"
                @click="addRule()"
              >
                <PlusIcon class="h-3.5 w-3.5" />
                {{ $t('routingPolicyRuleAdd') }}
              </button>
            </div>
          </div>

          <p
            v-if="editingCustom"
            class="text-base-content/50 text-xs"
          >
            {{ $t('routingCustomRulesHint') }}
          </p>

          <!-- 前置自定义分流:一个页签 = 一个出口,页签从左到右匹配,页签内按规则顺序匹配 -->
          <div
            v-if="editingCustom && customTabs.length"
            class="flex min-w-0 items-center gap-2"
          >
            <Draggable
              v-model="customTabs"
              :animation="150"
              :force-fallback="true"
              :fallback-tolerance="5"
              :fallback-on-body="true"
              :delay="200"
              :delay-on-touch-only="true"
              handle=".custom-tab-handle"
              ghost-class="opacity-40"
              item-key="id"
              role="tablist"
              :aria-label="$t('routingCustomOutboundTabs')"
              v-segmented
              class="tabs-box tabs tabs-xs flex w-fit max-w-full min-w-0 flex-wrap"
            >
              <template #item="{ element: tab }">
                <div
                  :class="['tab shrink-0 gap-1 px-2', activeTabId === tab.id && 'tab-active']"
                  :data-custom-tab="tab.id"
                >
                  <button
                    type="button"
                    role="tab"
                    :aria-selected="activeTabId === tab.id"
                    class="custom-tab-handle flex min-w-0 cursor-move items-center gap-1"
                    :title="tab.outbound || $t('routingCustomUnassigned')"
                    @click="activeTabId = tab.id"
                  >
                    <Bars3Icon class="h-3 w-3 shrink-0 opacity-50" />
                    <span class="max-w-36 shrink-0 truncate">{{ tab.outbound || $t('routingCustomUnassigned') }}</span>
                    <span class="shrink-0 opacity-60">({{ tabRuleCount(tab.id) }})</span>
                  </button>
                </div>
              </template>
            </Draggable>
            <button
              type="button"
              class="btn btn-ghost btn-square btn-sm hover:text-error ml-auto shrink-0"
              :disabled="!activeTab"
              v-tip="$t('routingCustomDeleteTabTitle')"
              :aria-label="$t('routingCustomDeleteTabLabel', { name: activeTab?.outbound || $t('routingCustomUnassigned') })"
              @click="askDeleteTab"
            >
              <TrashIcon class="h-4 w-4" />
            </button>
          </div>
        </div>
      </template>

      <div
        v-if="draft"
        v-tab-content="editingCustom ? activeTab : undefined"
        class="flex flex-col gap-4"
      >
        <p
          v-if="!visibleRules.length"
          class="text-base-content/50 text-xs"
        >
          {{ $t(editingCustom && !activeTab ? 'routingCustomNoTab' : 'routingPolicyNoRuleYet') }}
        </p>

          <Draggable
            v-if="visibleRules.length"
            v-model="visibleRules"
            :animation="150"
            :force-fallback="true"
            :fallback-tolerance="5"
            :fallback-on-body="true"
            handle=".drag-handle"
            ghost-class="opacity-40"
            item-key="key"
            class="flex flex-col gap-2"
            @end="sortRules"
          >
            <template #item="{ element: rule }">
              <div
                :data-rule-key="rule.key"
                class="flex flex-wrap items-center gap-2 sm:flex-nowrap"
              >
            <Bars3Icon class="drag-handle text-base-content/40 h-4 w-4 shrink-0 cursor-move" />
            <select
              v-model="rule.type"
              class="select select-sm w-36 shrink-0 max-sm:w-auto max-sm:min-w-0 max-sm:grow max-sm:basis-[35%]"
            >
              <option
                v-for="opt in ruleTypeOptions(rule.type)"
                :key="opt.type"
                :value="opt.type"
              >
                {{ $t(opt.labelKey) }}
              </option>
            </select>
            <!-- geosite/geoip 的值来自上游真有的那份名单,给带搜索的下拉框,
                 外加一个「详情」看它到底包含哪些域名/IP -->
            <div class="flex min-w-0 flex-1 items-center gap-2 max-sm:order-3 max-sm:grow max-sm:basis-[60%]">
              <GeoRuleValue
                v-if="rule.type === 'geosite' || rule.type === 'geoip'"
                v-model="rule.value"
                :kind="rule.type"
                :placeholder="$t(placeholderKey(rule.type))"
                :exclude="pickedElsewhere(rule)"
              />
              <!-- 规则集链接:填完网址自动拉回来解析,后面跟「详情(N)」,和上面同一个弹窗 -->
              <RuleUrlValue
                v-else-if="rule.type === 'ruleUrl'"
                v-model="rule.value"
                :placeholder="$t(placeholderKey(rule.type))"
              />
              <input
                v-else
                v-model="rule.value"
                data-rule-value
                type="text"
                class="input input-sm min-w-0 flex-1 font-mono text-xs"
                :placeholder="$t(placeholderKey(rule.type))"
                @change="splitRule(rules.findIndex((r) => r.key === rule.key))"
              />
            </div>
            <!-- 备注:给这一行写一句说明,存在这一行自己身上 -->
            <input
              v-model="rule.note"
              type="text"
              class="input input-sm w-28 shrink-0 text-xs max-sm:order-1 max-sm:w-auto max-sm:min-w-0 max-sm:grow max-sm:basis-[40%]"
              :placeholder="$t('routingPolicyRuleNotePlaceholder')"
              :maxlength="NOTE_MAX"
            />
            <button
              type="button"
              class="btn btn-ghost btn-square btn-sm hover:text-error max-sm:order-2"
              v-tip="$t('delete')"
              :aria-label="$t('delete')"
              @click="removeRule(rule.key)"
            >
              <TrashIcon class="h-4 w-4" />
            </button>
              </div>
            </template>
          </Draggable>
      </div>

      <!-- 取消 / 保存固定在底栏,规则多了只滚中间 -->
      <template #footer>
        <div class="flex w-full flex-col gap-2">
          <!-- 当前页签统一使用的出口:改了出口,页签名跟着变,同出口的页签会合并 -->
          <div
            v-if="editingCustom && activeTab"
            class="flex flex-col gap-1"
          >
            <div class="flex items-center gap-2">
              <label class="shrink-0 text-xs font-medium">{{ $t('routingCustomExitLabel') }}</label>
              <div class="min-w-0 flex-1">
                <OutboundPicker
                  :model-value="activeTab.outbound"
                  :options="outboundOptions"
                  :placeholder="$t('outboundPickerPlaceholder')"
                  @update:model-value="setTabOutbound"
                />
              </div>
            </div>
            <p class="text-base-content/50 text-xs">{{ $t('routingCustomExitGroupHint') }}</p>
          </div>
          <div class="flex justify-end gap-2">
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
      </template>
    </DialogWrapper>

    <!-- 删除页签:页签里有内容才确认,空页签直接删 -->
    <DialogWrapper
      v-model="showDeleteTab"
      :title="$t('routingCustomDeleteTabTitle')"
    >
      <p class="text-sm">{{ $t('routingCustomDeleteTabConfirm', { name: deleteTabName }) }}</p>
      <template #footer>
        <button
          type="button"
          class="btn btn-sm"
          @click="showDeleteTab = false"
        >
          {{ $t('cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-error btn-sm"
          @click="confirmDeleteTab"
        >
          {{ $t('confirm') }}
        </button>
      </template>
    </DialogWrapper>

    <!-- 导入规则:和客户端分流、地区组共用同一个弹窗 -->
    <RuleImportDialog
      v-model="showRuleImport"
      :max="RULE_IMPORT_MAX"
      @import="applyImportedRules"
    />
  </div>
</template>

<script setup lang="ts">
import type {
  OpenboxCustomPolicy,
  OpenboxCustomRule,
  OpenboxCustomTab,
  OpenboxProfile,
  OpenboxRoutingPolicy,
  OpenboxUserGroup,
} from '@/api/openbox'
import { fetchNodeGroups, RULESET_TAG_PATTERN } from '@/api/openbox'
import RuleImportDialog from '@/components/clientapp/RuleImportDialog.vue'
import CountryFlag from '@/components/common/CountryFlag.vue'
import CountrySelect from '@/components/common/CountrySelect.vue'
import IconScaleInput from '@/components/common/IconScaleInput.vue'
import OutboundPicker, { type OutboundPickerOptions } from '@/components/common/OutboundPicker.vue'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import GeoRuleValue from '@/components/routing/GeoRuleValue.vue'
import RuleUrlValue from '@/components/routing/RuleUrlValue.vue'
import { showNotification } from '@/helper/notification'
import { isInvalidOutboundName } from '@/helper/outboundName'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { Bars3Icon, PencilSquareIcon, PlusIcon, PowerIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Draggable from 'vuedraggable'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

// 兜底站点集:默认叫「其他」、彩色地球(服务端同一份默认在 engine/routing-model.mjs)。
// 名字直接当内核里的出站 tag 用,用户可以改;图标也可以改。存在本身是固定的。
const DEFAULT_FALLBACK_NAME = '其他'
const DEFAULT_FALLBACK_ICON = 'globe:earth-meridians'
const fallbackName = computed(() => props.profile.routing.fallbackName?.trim() || DEFAULT_FALLBACK_NAME)
const fallbackIcon = computed(() => props.profile.routing.fallbackIcon?.trim() || DEFAULT_FALLBACK_ICON)
const fallbackIconScale = computed(() => Number(props.profile.routing.fallbackIconScale) || 0)

const showFallbackEditor = ref(false)
const fallbackDraft = ref<{ name: string; icon: string; iconScale: number } | null>(null)
const openFallbackEditor = () => {
  fallbackDraft.value = { name: fallbackName.value, icon: fallbackIcon.value, iconScale: fallbackIconScale.value }
  showFallbackEditor.value = true
}
const saveFallback = async () => {
  const d = fallbackDraft.value
  if (!d || saving.value) return
  const name = d.name.trim()
  if (!name) {
    showNotification({ content: 'routingPolicyNameRequired', type: 'alert-error' })
    return
  }
  // 名字会当内核出站 tag 用:`.` / `..` / 含 `/` 一律拒绝(上游 outboundNameInvalid)
  if (isInvalidOutboundName(name)) {
    showNotification({ content: 'outboundNameInvalid', type: 'alert-error' })
    return
  }
  // 名字就是内核里的出站 tag,和普通站点集重名同样不行
  if (rows.value.some((p) => p.name === name)) {
    showNotification({ content: 'routingPolicyNameDuplicate', type: 'alert-error' })
    return
  }
  saving.value = true
  try {
    await props.patchProfile({ routing: { fallbackName: name, fallbackIcon: d.icon || '', fallbackIconScale: d.iconScale || 0 } })
    showNotification({ content: 'routingPolicySaved', type: 'alert-success' })
    showFallbackEditor.value = false
  } catch (err) {
    showNotification({
      content: 'routingSaveFailed',
      params: { message: err instanceof Error ? err.message : String(err) },
      type: 'alert-error',
    })
  } finally {
    saving.value = false
  }
}

// 启用/停用:停用的站点集留在列表里,不进内核配置(重启内核后生效,和别的改动一样)
const toggleEnabled = async (policy: OpenboxRoutingPolicy) => {
  if (saving.value) return
  saving.value = true
  try {
    await persist(rows.value.map((p) => (p.id === policy.id ? { ...p, enabled: p.enabled === false } : p)))
  } catch (err) {
    showNotification({
      content: 'routingSaveFailed',
      params: { message: err instanceof Error ? err.message : String(err) },
      type: 'alert-error',
    })
  } finally {
    saving.value = false
  }
}

const { t } = useI18n()

type ConditionKey = 'rulesets' | 'ruleUrls' | 'domain' | 'domainSuffix' | 'domainKeyword' | 'ipCidr'
const CONDITION_FIELDS: { key: ConditionKey; labelKey: string; placeholderKey: string }[] = [
  {
    key: 'rulesets',
    labelKey: 'routingPolicyRulesets',
    placeholderKey: 'routingPolicyRulesetsPlaceholder',
  },
  {
    key: 'ruleUrls',
    labelKey: 'routingPolicyRuleUrl',
    placeholderKey: 'routingPolicyRuleUrlPlaceholder',
  },
  {
    key: 'domainSuffix',
    labelKey: 'routingPolicyDomainSuffix',
    placeholderKey: 'routingPolicyDomainSuffixPlaceholder',
  },
  {
    key: 'domain',
    labelKey: 'routingPolicyDomain',
    placeholderKey: 'routingPolicyDomainPlaceholder',
  },
  {
    key: 'domainKeyword',
    labelKey: 'routingPolicyDomainKeyword',
    placeholderKey: 'routingPolicyDomainKeywordPlaceholder',
  },
  {
    key: 'ipCidr',
    labelKey: 'routingPolicyIpCidr',
    placeholderKey: 'routingPolicyIpCidrPlaceholder',
  },
]

// 编辑弹窗里的一行 = 一条规则。geosite/geoip 只是规则集的糖:写 cn 存下去就是
// geosite-cn —— 官方规则集全是这两个前缀,让人每次手打前缀没有意义。前缀之外的
// 规则集(老档案里可能有)走 ruleset 这一档,原样存。
type RuleType =
  | 'domainSuffix'
  | 'domain'
  | 'domainKeyword'
  | 'ipCidr'
  | 'geosite'
  | 'geoip'
  | 'ruleUrl'
  | 'ruleset'
  | 'port'
const RULE_TYPES: { type: RuleType; labelKey: string; placeholderKey: string }[] = [
  {
    type: 'domainSuffix',
    labelKey: 'routingPolicyDomainSuffix',
    placeholderKey: 'routingPolicyRuleDomainSuffixPlaceholder',
  },
  {
    type: 'domain',
    labelKey: 'routingPolicyDomain',
    placeholderKey: 'routingPolicyRuleDomainPlaceholder',
  },
  {
    type: 'domainKeyword',
    labelKey: 'routingPolicyDomainKeyword',
    placeholderKey: 'routingPolicyRuleDomainKeywordPlaceholder',
  },
  {
    type: 'ipCidr',
    labelKey: 'routingPolicyIpCidr',
    placeholderKey: 'routingPolicyRuleIpCidrPlaceholder',
  },
  {
    type: 'geosite',
    labelKey: 'routingPolicyGeosite',
    placeholderKey: 'routingPolicyRuleGeoPlaceholder',
  },
  {
    type: 'geoip',
    labelKey: 'routingPolicyGeoip',
    placeholderKey: 'routingPolicyRuleGeoPlaceholder',
  },
  {
    type: 'ruleUrl',
    labelKey: 'routingPolicyRuleUrl',
    placeholderKey: 'routingPolicyRuleUrlPlaceholder',
  },
  // 老档案里可能存着不带 geosite- / geoip- 前缀的规则集名字,得有地方显示,
  // 但不进新增的下拉(见 ruleTypeOptions)
  {
    type: 'ruleset',
    labelKey: 'routingPolicyRulesets',
    placeholderKey: 'routingPolicyRulesetsPlaceholder',
  },
  // 目标端口:只有前置自定义分流有(放行 WireGuard 的 51820 之类)。站点集是按站点分的,
  // 端口条件放进去没有意义
  {
    type: 'port',
    labelKey: 'routingPolicyPort',
    placeholderKey: 'routingPolicyRulePortPlaceholder',
  },
]
// 和服务端 parsePortSpec 同一套写法:51820 / 1000-2000,逗号或空格分隔
const PORT_SPEC_PATTERN = /^\d{1,5}(-\d{1,5})?([,\s]+\d{1,5}(-\d{1,5})?)*[,\s]*$/
const placeholderKey = (type: RuleType) =>
  RULE_TYPES.find((r) => r.type === type)?.placeholderKey || 'routingPolicyRuleDomainPlaceholder'

// 「规则集」那一档不进新增的下拉:官方规则集全是 geosite- / geoip- 两个前缀,上面两档
// 已经全覆盖,而且带搜索、带说明、能先看「详情」。它只剩兼容作用——老档案里存过别的
// 前缀的名字,打开时才让它出现在自己那一行,换成别的类型之后就再也选不回来。
const ruleTypeOptions = (current: RuleType) =>
  RULE_TYPES.filter(
    (r) =>
      (r.type !== 'ruleset' || current === 'ruleset') && (r.type !== 'port' || editingCustom.value),
  )

interface RuleRow {
  // 列表渲染要一个稳定的 key:类型和值都会被改,不能拿它们当 key
  key: number
  type: RuleType
  value: string
  // 只有前置自定义分流用得上:那里一行一个出口。站点集的行没有这一列,恒为空串。
  outbound: string
  // 这一行的备注:站点集存进 policy.notes,前置自定义分流存在规则自己的 note 字段里
  note: string
  // 只有前置自定义分流有:所属出口页签。页签的出口就是这一行的出口。
  tabId?: string
}
let ruleKeySeed = 0

// ---------- 前置自定义分流的出口页签 ----------
// 一个页签 = 一个出口。同出口的页签合并成第一个;规则按页签顺序排列,出口以页签为准。
const flattenTabs = (tabs: OpenboxCustomTab[], rows: RuleRow[]): RuleRow[] =>
  tabs.flatMap((tab) => rows.filter((r) => r.tabId === tab.id).map((r) => ({ ...r, outbound: tab.outbound })))
const normalizeTabs = (tabs: OpenboxCustomTab[], rows: RuleRow[]) => {
  const merged: OpenboxCustomTab[] = []
  const byOutbound = new Map<string, OpenboxCustomTab>()
  const idMap = new Map<string, string>()
  for (const tab of tabs) {
    const outbound = tab.outbound.trim()
    let target = outbound ? byOutbound.get(outbound) : undefined
    if (!target) {
      target = { ...tab, outbound }
      merged.push(target)
      if (outbound) byOutbound.set(outbound, target)
    }
    idMap.set(tab.id, target.id)
  }
  const remapped = rows.map((r) => ({ ...r, tabId: idMap.get(r.tabId || '') || r.tabId }))
  return { tabs: merged, rows: flattenTabs(merged, remapped) }
}
// 打开编辑器:存过 tabs 且每条规则都对得上就直接用;老档案(没有 tabs)按「相邻且同出口」归并成页签
const seedTabs = (rows: RuleRow[], saved: OpenboxCustomTab[] | undefined, newId: () => string) => {
  const byId = new Map((saved || []).map((tab) => [tab.id, tab]))
  if (
    saved &&
    byId.size === saved.length &&
    saved.every((tab) => tab.id) &&
    rows.every((r) => r.tabId && byId.get(r.tabId)?.outbound === r.outbound)
  ) {
    return normalizeTabs(saved, rows)
  }
  const tabs: OpenboxCustomTab[] = []
  const tagged = rows.map((r) => {
    let last = tabs[tabs.length - 1]
    if (!last || last.outbound !== r.outbound) {
      last = { id: newId(), outbound: r.outbound }
      tabs.push(last)
    }
    return { ...r, tabId: last.id }
  })
  return normalizeTabs(tabs, tagged)
}
// 页签内拖拽排序:只重排这个页签的规则,别的页签原位不动
const reorderWithinTab = (all: RuleRow[], next: RuleRow[], tabId: string) => {
  const keys = new Set(all.filter((r) => r.tabId === tabId).map((r) => r.key))
  if (next.length !== keys.size || new Set(next.map((r) => r.key)).size !== keys.size || next.some((r) => r.tabId !== tabId || !keys.has(r.key))) {
    return [...all]
  }
  let i = 0
  return all.map((r) => (r.tabId === tabId ? (next[i++] as RuleRow) : r))
}
const hasContent = (...values: string[]) => values.some((v) => v.trim())

const policies = computed<OpenboxRoutingPolicy[]>(() => props.profile.routing.policies || [])
// 拖拽要求 v-model 绑一个 ref(vuedraggable 会整个替换数组),所以列表在本地存一份
const rows = ref<OpenboxRoutingPolicy[]>([])
watch(
  policies,
  (value) => {
    rows.value = [...value]
  },
  { immediate: true, deep: true },
)

const conditionSummary = (policy: { [K in ConditionKey]?: string[] }) => {
  const parts: string[] = []
  for (const field of CONDITION_FIELDS) {
    const values = policy[field.key] || []
    if (values.length) parts.push(`${t(field.labelKey)}: ${values.join(', ')}`)
  }
  return parts.length ? parts.join(' · ') : t('routingPolicyNoCondition')
}

// ---------- 前置自定义分流 ----------
// 单独存在 routing.custom 里(不在 policies 数组中),所以它天然删不掉、拖不动。
// 默认名字和服务端同一份(engine/routing-model.mjs 的 CUSTOM_POLICY_NAME)。
// 默认名字和图标都和服务端同一份(engine/routing-model.mjs 的 CUSTOM_POLICY_NAME /
// CUSTOM_POLICY_ICON):图钉表示它固定钉在最前面,和兜底那条的彩色地球一个用意。
const DEFAULT_CUSTOM_NAME = '前置自定义分流'
const DEFAULT_CUSTOM_ICON = 'misc:pin'
const customPolicy = computed<OpenboxCustomPolicy>(() => {
  const c = props.profile.routing.custom || {}
  return { ...c, name: c.name?.trim() || DEFAULT_CUSTOM_NAME, icon: c.icon?.trim() || DEFAULT_CUSTOM_ICON }
})

// 卡片副标题:逐行列出「条件 → 出口」,这条的重点就是每行各走各的
const customSummary = computed(() => {
  const list = customPolicy.value.rules || []
  if (!list.length) return t('routingCustomNoRule')
  return list.map((r) => `${r.value} → ${r.outbound}`).join('  ·  ')
})

const toggleCustomEnabled = async () => {
  if (saving.value) return
  saving.value = true
  try {
    await props.patchProfile({
      routing: { custom: { ...customPolicy.value, enabled: customPolicy.value.enabled === false } },
    })
    showNotification({ content: 'routingPolicySaved', type: 'alert-success' })
  } catch (error) {
    showNotification({
      content: 'routingSaveFailed',
      type: 'alert-error',
      params: { message: error instanceof Error ? error.message : String(error) },
    })
  } finally {
    saving.value = false
  }
}

// 出口候选:内置直连 / 拒绝(用它们当前的名字)、启用的节点组、单个节点(带订阅名)
// ——和终端分流那边同一套形状。停用的组不进内核配置,选了也没用,所以不列。
// 打开弹窗时才拉,设置页平时不需要这份数据。
// 存着的出口已经不在候选里(节点改名 / 订阅删了)也不要紧:选择器按原值显示,不会被
// 悄悄清空;那一行在生成配置时会被丢掉(见 engine/routing.mjs)。
const editingCustom = ref(false)
const outboundGroups = ref<OpenboxUserGroup[]>([])
const outboundNodes = ref<Array<{ name: string; subscription: string }>>([])
let outboundsLoaded = false
const loadOutbounds = async () => {
  if (outboundsLoaded) return
  try {
    const data = await fetchNodeGroups()
    outboundGroups.value = data.groups || []
    outboundNodes.value = data.availableNodes || []
    outboundsLoaded = true
  } catch {
    // 拉不到就只剩已选的那一项能显示,不挡编辑
  }
}
const outboundOptions = computed<OutboundPickerOptions>(() => ({
  builtin: outboundGroups.value.filter((g) => g.kind && g.enabled !== false).map((g) => g.name),
  groups: outboundGroups.value.filter((g) => !g.kind && g.enabled !== false).map((g) => g.name),
  nodes: outboundNodes.value,
}))

const showEditor = ref(false)
const editing = ref<OpenboxRoutingPolicy | null>(null)
const draft = ref<OpenboxRoutingPolicy | null>(null)
const rules = ref<RuleRow[]>([])

// 前置自定义分流的页签状态
const customTabs = ref<OpenboxCustomTab[]>([])
const activeTabId = ref('')
const activeTab = computed(() => customTabs.value.find((tab) => tab.id === activeTabId.value))
// 编辑区显示的规则:前置自定义分流只显示当前页签的,站点集显示全部
const visibleRules = computed<RuleRow[]>({
  get: () => (editingCustom.value ? rules.value.filter((r) => r.tabId === activeTabId.value) : rules.value),
  set: (next) => {
    rules.value = editingCustom.value ? reorderWithinTab(rules.value, next, activeTabId.value) : next
  },
})
const tabRuleCount = (id: string) => rules.value.filter((r) => r.tabId === id && r.value.trim()).length
const newTabId = () => `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
const currentOutbound = () => (editingCustom.value && activeTab.value?.outbound) || ''

const addTab = () => {
  const tab: OpenboxCustomTab = { id: newTabId(), outbound: '' }
  customTabs.value.push(tab)
  activeTabId.value = tab.id
  addRule()
}
// 改当前页签的出口:页签里的规则一起跟着变;和别的页签出口相同就合并
const setTabOutbound = (outbound: string) => {
  const tab = activeTab.value
  if (!tab) return
  tab.outbound = outbound
  for (const r of rules.value) if (r.tabId === tab.id) r.outbound = outbound
  const next = normalizeTabs(customTabs.value, rules.value)
  customTabs.value = next.tabs
  rules.value = next.rows
  activeTabId.value =
    next.tabs.find((x) => x.id === tab.id)?.id || next.tabs.find((x) => x.outbound === outbound)?.id || ''
}

const showDeleteTab = ref(false)
const deleteTabId = ref('')
const deleteTabName = computed(
  () => customTabs.value.find((tab) => tab.id === deleteTabId.value)?.outbound || t('routingCustomUnassigned'),
)
const removeTab = () => {
  const id = deleteTabId.value
  const index = customTabs.value.findIndex((tab) => tab.id === id)
  if (index !== -1) {
    customTabs.value = customTabs.value.filter((tab) => tab.id !== id)
    rules.value = rules.value.filter((r) => r.tabId !== id)
    if (activeTabId.value === id) {
      activeTabId.value = customTabs.value[Math.min(index, customTabs.value.length - 1)]?.id || ''
    }
  }
  showDeleteTab.value = false
}
const askDeleteTab = () => {
  const tab = activeTab.value
  if (!tab || saving.value) return
  deleteTabId.value = tab.id
  // 页签里一条有内容的规则都没有就直接删,不打扰
  if (!rules.value.some((r) => r.tabId === tab.id && hasContent(r.value, r.note))) {
    removeTab()
    return
  }
  showDeleteTab.value = true
}
const confirmDeleteTab = removeTab

const removeRule = (key: number) => {
  const index = rules.value.findIndex((r) => r.key === key)
  if (index !== -1) rules.value.splice(index, 1)
}

type ImportedRule = { type: string; value: string }
const RULE_IMPORT_MAX = 200
const showRuleImport = ref(false)

const importTypeMap: Record<string, RuleType | undefined> = {
  domain: 'domain',
  domain_suffix: 'domainSuffix',
  domain_keyword: 'domainKeyword',
  ip_cidr: 'ipCidr',
}
const openRuleImport = () => {
  if (editingCustom.value && !activeTab.value) return
  showRuleImport.value = true
}
const applyImportedRules = (entries: ImportedRule[]) => {
  if (!entries.length) return
  if (editingCustom.value && !activeTab.value) return
  const outbound = currentOutbound()
  const imported = entries.flatMap((entry) => {
    const type = importTypeMap[entry.type]
    return type
      ? [{ key: ++ruleKeySeed, type, value: entry.value, outbound, note: '', ...(editingCustom.value ? { tabId: activeTabId.value } : {}) }]
      : []
  })
  // 导入是追加本地明细:原有的规则集链接必须保留,两种来源可以同时生效。
  // 前置自定义分流只清当前页签里的空行,别的页签原样保留。
  rules.value = [
    ...rules.value.filter((rule) => (editingCustom.value && rule.tabId !== activeTabId.value) || rule.value.trim()),
    ...imported,
  ]
  showRuleImport.value = false
}

// 这一行以外、同类型规则已经选了的分类:下拉框里不再出现,同一个集不会被加两遍
// (前置自定义分流只在同一个页签内去重)
const pickedElsewhere = (row: RuleRow) =>
  rules.value
    .filter((r) => r.key !== row.key && r.type === row.type && (!editingCustom.value || r.tabId === row.tabId))
    .map((r) => r.value)
const saving = ref(false)

const NOTE_MAX = 40

// 前置自定义分流的新行归当前页签、出口跟页签走;站点集的行没有出口
const addRule = (type: RuleType = 'domainSuffix', value = '', note = '') => {
  if (editingCustom.value && !activeTab.value) return
  rules.value.push({
    key: ++ruleKeySeed,
    type,
    value,
    outbound: currentOutbound(),
    note,
    ...(editingCustom.value ? { tabId: activeTabId.value } : {}),
  })
}

const ruleRow = (type: RuleType, value: string, note = ''): RuleRow => ({ key: ++ruleKeySeed, type, value, outbound: '', note })

// 存下来的规则集 tag → 界面上的一行。geosite-cn 显示成 geosite + cn,
// 其余前缀原样落到 ruleset 那一档。
const rulesetToRow = (tag: string, note = ''): RuleRow => {
  for (const type of ['geosite', 'geoip'] as const) {
    if (tag.startsWith(`${type}-`)) return ruleRow(type, tag.slice(type.length + 1), note)
  }
  return ruleRow('ruleset', tag, note)
}

// 站点集的备注挂在「类型:值」上存进 policy.notes:geosite-cn 这类规则集记成 ruleset:geosite-cn,
// 其余是 domainSuffix:google.com 这样。前置自定义分流的备注直接存在那一行里,不走这套键。
const noteKey = (row: RuleRow) => {
  const value = row.value.trim()
  if (row.type === 'geosite' || row.type === 'geoip') return `ruleset:${row.type}-${value}`
  if (row.type === 'ruleset') return `ruleset:${value}`
  return `${row.type}:${value}`
}

// 在域名 / IP 这几类的值框里粘贴了一串(空格、逗号、顿号隔开),自动拆成一行一个;
// 新行沿用这一行的类型和出口,备注留在第一行
const SPLIT_PATTERN = /[\s,，;；、]+/
const SPLITTABLE = new Set<RuleType>(['domainSuffix', 'domain', 'domainKeyword', 'ipCidr'])
const splitRule = (index: number) => {
  const row = rules.value[index]
  if (!row || !SPLITTABLE.has(row.type)) return
  const parts = row.value.split(SPLIT_PATTERN).map((x) => x.trim()).filter(Boolean)
  if (parts.length <= 1) {
    row.value = parts[0] ?? ''
    return
  }
  row.value = parts[0] as string
  rules.value.splice(
    index + 1,
    0,
    ...parts.slice(1).map((value) => ({ ...row, key: ++ruleKeySeed, value, note: '' })),
  )
}
const splitAllRules = () => {
  for (let i = 0; i < rules.value.length; i++) splitRule(i)
}

// 站点集里各行是「或」的关系,存的时候本来就按类型分成几个数组,所以拖完按类型归位;
// 前置自定义分流的顺序就是匹配顺序,按拖动后的存
const RULE_RANK: Partial<Record<RuleType, number>> = {
  ruleUrl: 0,
  geosite: 1,
  geoip: 1,
  ruleset: 1,
  domainSuffix: 2,
  domain: 3,
  domainKeyword: 4,
  ipCidr: 5,
}
const sortRules = () => {
  if (editingCustom.value) return
  const rank = (r: RuleRow) => RULE_RANK[r.type] ?? 9
  rules.value = [...rules.value].sort((a, b) => rank(a) - rank(b))
}

const openEditor = (policy: OpenboxRoutingPolicy | null) => {
  editingCustom.value = false
  customTabs.value = []
  activeTabId.value = ''
  editing.value = policy
  draft.value = policy ? JSON.parse(JSON.stringify(policy)) : { id: '', name: '', icon: '', iconScale: 0 }
  rules.value = []
  if (policy) {
    const notes = policy.notes || {}
    for (const url of policy.ruleUrls || []) rules.value.push(ruleRow('ruleUrl', url, notes[`ruleUrl:${url}`] || ''))
    for (const tag of policy.rulesets || []) rules.value.push(rulesetToRow(tag, notes[`ruleset:${tag}`] || ''))
    for (const type of ['domainSuffix', 'domain', 'domainKeyword', 'ipCidr'] as const) {
      for (const value of policy[type] || []) addRule(type, value, notes[`${type}:${value}`] || '')
    }
  }
  if (!rules.value.length) addRule()
  showEditor.value = true
}
// 前置自定义分流用同一个弹窗:规则按出口分页签,出口在底栏按当前页签选
const openCustomEditor = () => {
  const c = customPolicy.value
  editingCustom.value = true
  editing.value = null
  draft.value = { id: '', name: c.name || DEFAULT_CUSTOM_NAME, icon: c.icon || DEFAULT_CUSTOM_ICON, iconScale: c.iconScale || 0 }
  // 存的是一行一条规则 + 出口页签;老档案没有页签,按相邻同出口的规则归并
  const seeded = seedTabs(
    (c.rules || []).map((r) => ({
      key: ++ruleKeySeed,
      type: r.type as RuleType,
      value: r.value,
      outbound: r.outbound,
      note: r.note || '',
      tabId: r.tabId,
    })),
    c.tabs,
    newTabId,
  )
  customTabs.value = seeded.tabs
  rules.value = seeded.rows
  activeTabId.value = seeded.tabs[0]?.id || ''
  showDeleteTab.value = false
  void loadOutbounds()
  showEditor.value = true
}

defineExpose({ openEditor })

// 新增 / 修改 / 删除 / 拖拽排序都走这里。保存只是写档案,内核还在跑旧配置,所以每次都
// 用右上角的标准提示告诉一声"重启内核后生效",由用户自己去内核页重启。
const persist = async (next: OpenboxRoutingPolicy[]) => {
  await props.patchProfile({ routing: { policies: next } })
  showNotification({ content: 'routingPolicySaved', type: 'alert-success' })
}

const saveDraft = async () => {
  if (!draft.value || saving.value) return
  // 值框里粘进去没来得及拆的一串,先拆成一行一个再存
  splitAllRules()
  const name = draft.value.name.trim()
  if (!name) {
    showNotification({ content: 'routingPolicyNameRequired', type: 'alert-error' })
    return
  }
  // 名字会当内核出站 tag 用:`.` / `..` / 含 `/` 一律拒绝(上游 outboundNameInvalid)
  if (isInvalidOutboundName(name)) {
    showNotification({ content: 'outboundNameInvalid', type: 'alert-error' })
    return
  }
  // 站点集的名字就是内核里的出站名,重名会生成两个同名出站。
  // 前置自定义分流不生成出站(它直接指向固定出口),名字只是界面标题,不查重。
  if (!editingCustom.value && rows.value.some((p) => p.name === name && p.id !== draft.value?.id)) {
    showNotification({ content: 'routingPolicyNameDuplicate', type: 'alert-error' })
    return
  }
  // 前置自定义分流按页签存:页签有自己的出口,页签内一行一条规则(顺序即匹配顺序)。
  // 页签顺序也是匹配顺序,所以连同 tabs 一起存。站点集那套"按类型合成几个数组"在这儿不适用。
  if (editingCustom.value) {
    const kept = flattenTabs(customTabs.value, rules.value).filter((r) => r.value.trim())
    const missing = kept.find((r) => !r.outbound)
    if (missing) {
      activeTabId.value = missing.tabId || ''
      showNotification({ content: 'routingCustomOutboundRequired', type: 'alert-error' })
      return
    }
    // 规则集名会被拼进 .srs 路径,和服务端同一道校验(路径穿越防线,不是排版讲究)
    const badTag = kept.some((r) => {
      if (r.type === 'geosite' || r.type === 'geoip') return !RULESET_TAG_PATTERN.test(`${r.type}-${r.value.trim()}`)
      if (r.type === 'ruleset') return !RULESET_TAG_PATTERN.test(r.value.trim())
      return false
    })
    if (badTag) {
      showNotification({ content: 'routingRulesetInvalidChars', type: 'alert-error' })
      return
    }
    if (kept.some((r) => r.type === 'port' && !PORT_SPEC_PATTERN.test(r.value.trim()))) {
      showNotification({ content: 'routingCustomPortInvalid', type: 'alert-error' })
      return
    }
    const customRules: OpenboxCustomRule[] = kept.map((r) => ({
      type: r.type as OpenboxCustomRule['type'],
      value: r.value.trim(),
      outbound: r.outbound,
      tabId: r.tabId,
      ...(r.note.trim() ? { note: r.note.trim() } : {}),
    }))
    saving.value = true
    try {
      await props.patchProfile({
        routing: {
          custom: {
            name,
            icon: draft.value.icon || '',
            iconScale: draft.value.iconScale || 0,
            enabled: customPolicy.value.enabled !== false,
            tabs: customTabs.value.map((tab) => ({ ...tab })),
            rules: customRules,
          },
        },
      })
      showNotification({ content: 'routingPolicySaved', type: 'alert-success' })
      showEditor.value = false
    } catch (error) {
      showNotification({
        content: 'routingSaveFailed',
        type: 'alert-error',
        params: { message: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      saving.value = false
    }
    return
  }

  // 规则行 → 存储用的那五个数组。空值的行直接忽略(加了一行没填就是没填)
  const collected: Record<ConditionKey, string[]> = {
    rulesets: [],
    ruleUrls: [],
    domain: [],
    domainSuffix: [],
    domainKeyword: [],
    ipCidr: [],
  }
  // 备注挂在「类型:值」上;端口那档只有前置自定义分流有,不进这里
  const notes: Record<string, string> = {}
  for (const row of rules.value) {
    const value = row.value.trim()
    if (!value) continue
    if (row.note.trim() && row.type !== 'port') notes[noteKey(row)] = row.note.trim()
    if (row.type === 'geosite' || row.type === 'geoip')
      collected.rulesets.push(`${row.type}-${value}`)
    else if (row.type === 'ruleset') collected.rulesets.push(value)
    else if (row.type === 'ruleUrl') collected.ruleUrls.push(value)
    // 端口这一档只有前置自定义分流有(见 ruleTypeOptions),站点集的行里不会出现
    else if (row.type !== 'port') collected[row.type].push(value)
  }
  // 规则集 tag 会被拼进 .srs 路径,和服务端同一道校验(路径穿越防线,不是排版讲究)
  if (collected.rulesets.some((tag) => !RULESET_TAG_PATTERN.test(tag))) {
    showNotification({ content: 'routingRulesetInvalidChars', type: 'alert-error' })
    return
  }

  if (!CONDITION_FIELDS.some((f) => collected[f.key].length)) {
    showNotification({ content: 'routingPolicyConditionRequired', type: 'alert-error' })
    return
  }

  const item: OpenboxRoutingPolicy = {
    ...draft.value,
    id: draft.value.id || `policy-${Date.now()}`,
    name,
    ...collected,
    notes,
  }

  saving.value = true
  try {
    const next = editing.value
      ? rows.value.map((p) => (p.id === editing.value?.id ? item : p))
      : [...rows.value, item]
    await persist(next)
    showEditor.value = false
  } catch (error) {
    showNotification({
      content: 'routingSaveFailed',
      type: 'alert-error',
      params: { message: error instanceof Error ? error.message : String(error) },
    })
  } finally {
    saving.value = false
  }
}

const showDelete = ref(false)
const pendingDelete = ref<OpenboxRoutingPolicy | null>(null)
const askDelete = (policy: OpenboxRoutingPolicy) => {
  pendingDelete.value = policy
  showDelete.value = true
}
const confirmDelete = async () => {
  const policy = pendingDelete.value
  if (!policy || saving.value) return
  saving.value = true
  try {
    await persist(rows.value.filter((p) => p.id !== policy.id))
    showDelete.value = false
    pendingDelete.value = null
  } catch (error) {
    showNotification({
      content: 'routingSaveFailed',
      type: 'alert-error',
      params: { message: error instanceof Error ? error.message : String(error) },
    })
  } finally {
    saving.value = false
  }
}
</script>
