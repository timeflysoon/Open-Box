<template>
  <!-- 设置 · 客户端:Open-Box App(手机 / 电脑)的配对码、地区分流、路由器标识 -->
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div
      class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      :style="padding"
    >
      <div class="flex flex-col gap-2 px-2 pb-2 md:py-2">
        <div
          v-if="loading"
          class="flex justify-center py-14"
        >
          <span class="loading loading-spinner loading-md" />
        </div>
        <template v-else-if="info">
          <AppCodeCard :info="info" />
          <ShareServerCodesCard :info="info" />
          <ShareRegionsCard
            :info="info"
            @saved="load"
          />
          <ServerInfoCard
            :info="info"
            @saved="load"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fetchClientAppInfo, type OpenboxClientAppInfo } from '@/api/clientApp'
import AppCodeCard from '@/components/clientapp/AppCodeCard.vue'
import ServerInfoCard from '@/components/clientapp/ServerInfoCard.vue'
import ShareRegionsCard from '@/components/clientapp/ShareRegionsCard.vue'
import ShareServerCodesCard from '@/components/clientapp/ShareServerCodesCard.vue'
import { usePaddingForViews } from '@/composables/paddingViews'
import { showNotification } from '@/helper/notification'
import { onMounted, ref } from 'vue'

const { padding } = usePaddingForViews({ offsetTop: 0, offsetBottom: 0 })

const info = ref<OpenboxClientAppInfo | null>(null)
const loading = ref(true)

const load = async () => {
  try {
    info.value = await fetchClientAppInfo()
  } catch (error) {
    showNotification({
      content: 'clientAppLoadFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>
