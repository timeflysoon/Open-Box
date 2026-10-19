<template>
  <!-- 故障转移组展开后最上面一条:兜底拒绝时的提示和原因、检测进度、测速跟不上的警告;三样都没有就不显示 -->
  <div
    v-if="rejected || progress || overload"
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
  </div>
</template>

<script setup lang="ts">
import {
  failoverFailReasons,
  failoverGroupByTag,
  failoverProbeOverload,
  isFailoverRejected,
} from '@/store/openboxFailover'
import { computed } from 'vue'

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
</script>
