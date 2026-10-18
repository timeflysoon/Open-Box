<template>
  <!-- 延迟标签悬停浮层:「测速延时」页签是原来的时间线,「节点信息」页签查入口和出口。
       节点信息第一次点开才查(浮层里默认不发请求),之后来回切换不重查。 -->
  <div class="flex flex-col gap-1.5">
    <div :class="sizeClass">
      <div
        v-show="tab === 'latency'"
        ref="historyHost"
        class="flex h-full items-start justify-center"
      >
        <span
          v-if="!history"
          class="self-center opacity-60"
        >
          {{ $t('noData') }}
        </span>
      </div>
      <NodeInfoPanel
        v-if="infoOpened"
        v-show="tab === 'info'"
        class="h-full"
        :name="name"
        :udp="udp"
      />
    </div>
    <div
      role="tablist"
      class="node-tip-tabs tabs-box tabs tabs-xs flex-nowrap"
    >
      <a
        v-for="item in tabs"
        :key="item.key"
        role="tab"
        class="tab flex-1"
        :class="tab === item.key && 'tab-active'"
        @click="select(item.key)"
      >
        {{ $t(item.label) }}
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import NodeInfoPanel from '@/components/proxies/NodeInfoPanel.vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  name: string
  udp?: boolean
  // 原来的时间线(LatencyTag 里用 DOM 拼好的),没有历史就是 null
  history?: HTMLElement | null
}>()
const { locale } = useI18n()

// 两个页签等大:中文窄一点,英文标签长要宽一点
const sizeClass = computed(() => (locale.value.startsWith('zh') ? 'h-64 w-64' : 'h-64 w-76'))
const tabs = [
  { key: 'latency', label: 'nodeTipLatency' },
  { key: 'info', label: 'nodeInfo' },
] as const
type TabKey = (typeof tabs)[number]['key']
const tab = ref<TabKey>('latency')
const infoOpened = ref(false)
const historyHost = ref<HTMLElement>()

const select = (key: TabKey) => {
  tab.value = key
  if (key === 'info') infoOpened.value = true
}

onMounted(() => {
  if (props.history) historyHost.value?.append(props.history)
})
</script>
