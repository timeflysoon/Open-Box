<template>
  <!-- 故障转移组展开后最上面一条:兜底拒绝时的提示和原因、检测进度、测速跟不上的警告,右边是「重新检测」 -->
  <div
    v-if="group"
    class="mb-2 flex items-start gap-2 text-xs"
  >
    <div class="min-w-0 flex-1 space-y-0.5 pt-1">
      <template v-if="rejected">
        <p class="text-error">{{ $t('failoverRejectedHint') }}</p>
        <p
          v-if="reasons"
          class="text-error"
        >{{ $t('failoverFailReason', { reasons }) }}</p>
      </template>
      <p
        v-if="progress"
        class="text-base-content/60 tabular-nums"
      >{{ $t('failoverChecking', progress) }}</p>
      <p
        v-if="overload"
        class="text-warning"
      >{{ $t('probeOverloaded', { demand: overload.demand.toFixed(1), done: overload.done.toFixed(1) }) }}</p>
    </div>
    <button
      v-tip="$t('failoverRecheckHint')"
      type="button"
      class="btn btn-sm bg-base-200 border-base-200 text-base-content/80 hover:text-base-content h-6 min-h-6 shrink-0 cursor-pointer px-2 text-xs font-medium shadow-none"
      :disabled="busy"
      @click.stop="recheck"
    >
      {{ $t('failoverRecheck') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import {
  failoverFailReasons,
  failoverGroupByTag,
  failoverProbeOverload,
  isFailoverRejected,
  recheckFailoverGroup,
} from '@/store/openboxFailover'
import { computed, ref } from 'vue'

const props = defineProps<{ groupName: string }>()

const group = computed(() => failoverGroupByTag.value.get(props.groupName) ?? null)
const rejected = computed(() => isFailoverRejected(props.groupName))
const reasons = computed(() => (rejected.value ? failoverFailReasons(props.groupName) : ''))
// 正在跑的这一轮测了几个;没有在跑(或还没数出总数)就不显示
const progress = computed(() => {
  const round = group.value?.round
  return round && round.total > 0 ? { done: round.done, total: round.total } : null
})
const overload = failoverProbeOverload

// 点下去到服务端确认之间、以及服务端还没做完(manualRecheck)时都禁用,免得连点
const pending = ref(false)
const busy = computed(() => pending.value || Boolean(group.value?.manualRecheck))
const recheck = async () => {
  if (busy.value) return
  pending.value = true
  try {
    await recheckFailoverGroup(props.groupName)
  } finally {
    pending.value = false
  }
}
</script>
