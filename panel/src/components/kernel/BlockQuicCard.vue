<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div>
        <div class="flex items-center gap-2">
          <h2 class="text-base font-semibold">{{ $t('blockQuicTitle') }}</h2>
          <input
            type="checkbox"
            class="toggle toggle-sm shrink-0"
            :aria-label="$t('blockQuicTitle')"
            :checked="profile.rejectQuic === true"
            @change="onToggle"
          />
        </div>
        <p class="text-base-content/60 text-xs">{{ $t('blockQuicDescription') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxProfile } from '@/api/openbox'
import { showNotification } from '@/helper/notification'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

const onToggle = async (event: Event) => {
  try {
    await props.patchProfile({ rejectQuic: (event.target as HTMLInputElement).checked })
    showNotification({ content: 'routingPolicySaved', type: 'alert-success' })
  } catch (err) {
    showNotification({ content: 'routingSaveFailed', params: { message: err instanceof Error ? err.message : String(err) }, type: 'alert-error' })
  }
}
</script>
