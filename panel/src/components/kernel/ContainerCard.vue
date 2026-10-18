<template>
  <!-- Docker 旁路由专用卡片(只在 platform === 'container' 时由 KernelPage 放出来):
       说明怎么连、IPv4 接管的限制,再列一遍容器自检(TUN / NET_ADMIN / 转发 / ICMP 重定向 / nftables / 策略路由),
       最后是升级方法。自检的各项来自服务端 container 字段。 -->
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4 text-sm">
      <h2 class="text-base font-semibold">{{ $t('dockerTitle') }}</h2>
      <p>{{ $t('dockerAccessHint', { ip: current.container?.lanIp || '—' }) }}</p>
      <p class="text-base-content/60 text-xs">{{ $t('dockerIpv4Hint') }}</p>
      <div class="border-base-300/60 border-t" />
      <h3 class="font-medium">{{ $t('dockerHealthTitle') }}</h3>
      <div class="flex flex-wrap gap-x-4 gap-y-2">
        <div
          v-for="item in checks"
          :key="item.key"
          class="flex items-center gap-2"
        >
          <span>{{ $t(item.key) }}</span>
          <StatusBadge
            :on="item.ok"
            :on-text="$t('dockerReady')"
            :off-text="$t('dockerUnavailable')"
          />
        </div>
      </div>
      <p
        v-if="conflicts"
        class="text-base-content/60 text-xs"
      >
        {{ $t('dockerRoutingConflict', { rules: conflicts }) }}
      </p>
      <p class="text-base-content/60 text-xs">
        {{
          $t('dockerMode', {
            mode: current.container?.mode || 'stopped',
            nat: current.container?.masquerade ? $t('dockerEnabled') : $t('dockerDisabled'),
          })
        }}
      </p>
      <div class="border-base-300/60 border-t" />
      <p>{{ $t('dockerUpgradeHint') }}</p>
      <code class="bg-base-200 overflow-x-auto rounded-lg p-3 text-xs">docker compose up -d --force-recreate</code>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxServiceStatus } from '@/api/openbox'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { serviceStatus } from '@/composables/kernelService'
import { computed } from 'vue'

const props = defineProps<{
  status: OpenboxServiceStatus
}>()

// 共享状态(侧边栏按钮、内核卡片也在刷新它)优先,没有就用页面传进来的那份
const current = computed(() => serviceStatus.value || props.status)

const conflicts = computed(
  () =>
    current.value.container?.routing?.conflicts.map((rule) => `${rule.priority}: lookup ${rule.table}`).join(', ') || '',
)

const checks = computed(() => {
  const container = current.value.container
  return [
    { key: 'dockerTun', ok: !!container?.tun },
    { key: 'dockerNetAdmin', ok: !!container?.netAdmin },
    { key: 'dockerForwarding', ok: !!container?.forwarding },
    { key: 'dockerRedirects', ok: !!container?.redirectsDisabled },
    { key: 'dockerNftables', ok: !!container?.nftables },
    ...(container?.routing
      ? [{ key: 'dockerRouting', ok: container.routing.checked && container.routing.conflicts.length === 0 }]
      : []),
  ]
})
</script>
