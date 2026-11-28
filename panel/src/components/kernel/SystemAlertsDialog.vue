<template>
  <!-- 「系统提示」汇总弹窗:高对比度列出所有异常与警告,错误在前。
       标题、底栏(刷新 / 关闭)、空状态都对齐上游 v0.1.499 的 SystemAlertsDialog。 -->
  <DialogWrapper
    v-model="isOpen"
    :title="$t('systemAlertsTitle')"
    box-class="w-full max-w-xl"
  >
    <template #footer>
      <button
        type="button"
        class="btn btn-ghost btn-sm mr-auto"
        :disabled="refreshing"
        @click="$emit('refresh')"
      >
        <ArrowPathIcon
          :class="['h-4 w-4', refreshing && 'animate-spin']"
          stroke-width="1.75"
          aria-hidden="true"
        />
        {{ $t('refresh') }}
      </button>
      <button
        type="button"
        class="btn btn-sm"
        @click="isOpen = false"
      >
        {{ $t('close') }}
      </button>
    </template>

    <!-- 没有告警:绿色对勾 + 一句话 -->
    <div
      v-if="alerts.length === 0"
      class="flex flex-col items-center justify-center gap-2 py-8 text-center"
    >
      <CheckCircleIcon
        stroke-width="1.75"
        class="text-success h-8 w-8"
        aria-hidden="true"
      />
      <p>{{ $t('systemAlertsEmpty') }}</p>
    </div>

    <ul
      v-else
      class="flex flex-col gap-2"
    >
      <li
        v-for="alert in alerts"
        :key="alert.id"
        class="border-base-300/60 bg-base-200/40 rounded-box flex flex-col gap-2 border p-[var(--app-card-space)] text-sm"
      >
        <!-- 第一行:等级图标 + 标题 + 等级徽标 + 对象 -->
        <div class="flex flex-wrap items-center gap-2">
          <ExclamationCircleIcon
            v-if="alert.severity === 'error'"
            stroke-width="1.75"
            class="system-alert-icon-error h-[18px] w-[18px] shrink-0"
            aria-hidden="true"
          />
          <ExclamationTriangleIcon
            v-else
            stroke-width="1.75"
            class="system-alert-icon-warning h-[18px] w-[18px] shrink-0"
            aria-hidden="true"
          />
          <span class="font-medium">{{ alert.title }}</span>
          <span
            class="badge badge-sm system-alert-badge shrink-0 font-medium"
            :class="alert.severity === 'error' ? 'system-alert-badge-error' : 'system-alert-badge-warning'"
          >{{ $t(alert.severity === 'error' ? 'systemAlertLevelError' : 'systemAlertLevelWarning') }}</span>
          <span
            v-if="alert.target"
            class="text-base-content/70 min-w-0 truncate"
          >
            {{ $t('systemAlertTargetLabel') }}:{{ alert.target }}
          </span>
        </div>

        <!-- 明细段落 -->
        <p
          v-if="alert.detail"
          class="text-base-content/80 leading-relaxed"
        >{{ alert.detail }}</p>

        <!-- 逐条明细 -->
        <ul
          v-if="alert.items && alert.items.length"
          class="text-base-content/70 flex flex-col gap-1 text-xs leading-relaxed"
        >
          <li
            v-for="(item, i) in alert.items"
            :key="i"
          >
            {{ item }}
          </li>
        </ul>

        <!-- 建议 -->
        <p
          v-if="alert.suggestion"
          class="text-base-content/60 text-xs leading-relaxed"
        >{{ $t('systemAlertSuggestionPrefix') }}{{ alert.suggestion }}</p>
      </li>
    </ul>
  </DialogWrapper>
</template>

<script setup lang="ts">
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import type { SystemAlert } from '@/composables/systemAlerts'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/vue/24/outline'

defineProps<{
  alerts: SystemAlert[]
  refreshing: boolean
}>()

defineEmits<{ refresh: [] }>()

const isOpen = defineModel<boolean>({ required: true })
</script>

<style scoped>
/* 错误用主题的 error 色,警告用 warning 色(上游 v0.1.499 的 system-alert-* 三个类) */
.system-alert-icon-error {
  color: var(--color-error);
}
.system-alert-icon-warning {
  color: var(--color-warning);
}
.system-alert-badge-error {
  color: var(--color-error);
  border-color: color-mix(in oklab, var(--color-error) 40%, transparent);
  background-color: color-mix(in oklab, var(--color-error) 12%, transparent);
}
.system-alert-badge-warning {
  color: var(--color-warning);
  border-color: color-mix(in oklab, var(--color-warning) 40%, transparent);
  background-color: color-mix(in oklab, var(--color-warning) 12%, transparent);
}
</style>
