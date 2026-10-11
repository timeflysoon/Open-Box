<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div>
        <div class="flex items-center gap-2">
          <h2 class="text-base font-semibold">{{ $t('directBypassTitle') }}</h2>
          <input
            type="checkbox"
            class="toggle toggle-sm shrink-0"
            :aria-label="$t('directBypassTitle')"
            :checked="profile.directBypass !== false"
            @change="onToggle"
          />
        </div>
        <p class="text-base-content/60 text-xs">{{ $t('directBypassDescription') }}</p>
        <p
          v-if="needsFakeIp"
          class="text-warning text-xs"
        >
          {{ $t('directBypassNeedsFakeIp') }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxProfile } from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { computed } from 'vue'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

// 开着,但 FakeIP 没开(或 DNS 接管关闭):入口只能走「默认进内核」那一档,放行范围比默认小
const needsFakeIp = computed(
  () => props.profile.directBypass !== false && (props.profile.dns?.fakeIpForProxy !== true || props.profile.dns?.mode === 'off'),
)

const onToggle = async (event: Event) => {
  try {
    await props.patchProfile({ directBypass: (event.target as HTMLInputElement).checked })
    showNotification({ content: 'routingPolicySaved', type: 'alert-success' })
  } catch (err) {
    showNotification({ content: 'routingSaveFailed', params: { message: err instanceof Error ? err.message : String(err) }, type: 'alert-error' })
  }
}
</script>
