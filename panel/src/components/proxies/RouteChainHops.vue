<template>
  <template
    v-for="(name, index) in split.hops"
    :key="`${name}-${index}`"
  >
    <ArrowRightCircleIcon
      v-if="index > 0"
      :class="arrowClass"
    />
    <ProxyName
      :name="name"
      :class="nameClass"
    />
  </template>
  <template v-if="split.target">
    <ArrowRightCircleIcon
      v-if="split.hops.length"
      :class="arrowClass"
    />
    <span
      v-tip="$t('chainUpstreamLayerTip')"
      class="badge badge-ghost badge-xs shrink-0"
    >{{ $t('chainUpstreamLayer') }}</span>
    <template
      v-for="(name, index) in split.upstream"
      :key="`up-${name}-${index}`"
    >
      <ArrowRightCircleIcon
        v-if="index > 0"
        :class="arrowClass"
      />
      <ProxyName
        :name="name"
        :class="nameClass"
      />
    </template>
    <template v-if="!hideTarget">
      <ArrowRightCircleIcon
        v-tip="$t('chainTargetTip')"
        :class="arrowClass"
      />
      <ProxyName
        :name="split.target"
        :class="nameClass"
      />
    </template>
  </template>
</template>

<script setup lang="ts">
import { splitChainHops } from '@/store/proxies'
import { ArrowRightCircleIcon } from '@heroicons/vue/24/outline'
import { computed } from 'vue'
import ProxyName from './ProxyName.vue'

// 一条路由链(站点集 → 节点组 → 节点)。链式代理节点在目标节点前面多一层「前置」上游,
// 这里把它单独标出来:... → [前置] 上游 → 目标。hideTarget:嵌在别的行里时不重复写目标
const props = withDefaults(
  defineProps<{ chain: string[]; nameClass?: string; arrowClass?: string; hideTarget?: boolean }>(),
  { nameClass: '', arrowClass: 'h-4 w-4 shrink-0', hideTarget: false },
)
const split = computed(() => splitChainHops(props.chain))
</script>
