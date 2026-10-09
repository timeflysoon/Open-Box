<template>
  <!-- 路由器标识:App 里共享网络的节点卡片、本地分流的配置卡片显示的图标 + 名称 + 地区 -->
  <div class="card">
    <div class="app-card-inset flex flex-col gap-3">
      <span class="text-base font-medium">{{ $t('clientAppServerInfoTitle') }}</span>
      <p class="text-base-content/60 text-xs">{{ $t('clientAppServerInfoHint') }}</p>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('clientAppServerName') }}</label>
          <input
            v-model="form.name"
            type="text"
            class="input input-sm w-full"
            :maxlength="SERVER_INFO_NAME_MAX"
            :placeholder="info.serverInfoDefaults.name"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('clientAppServerIcon') }}</label>
          <CountrySelect
            v-model="form.icon"
            :placeholder="$t('clientAppServerIconDefault')"
            clearable
            globes
            brands
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('clientAppServerRegion') }}</label>
          <CountrySelect
            v-model="form.region"
            :placeholder="$t('clientAppServerRegionAuto')"
            clearable
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn btn-sm"
          :disabled="detecting"
          @click="detect"
        >
          <span
            v-if="detecting"
            class="loading loading-spinner loading-xs"
          />
          {{ $t('clientAppDetectEgress') }}
        </button>
        <span
          v-if="egress"
          class="text-base-content/60 text-xs"
        >
          {{ $t('clientAppDetected', { ip: egress.ip, country: egress.country }) }}
        </span>
        <button
          type="button"
          class="btn btn-primary btn-sm ml-auto"
          :disabled="saving"
          @click="save"
        >
          <span
            v-if="saving"
            class="loading loading-spinner loading-xs"
          />
          {{ $t('save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  detectEgressCountry,
  saveServerInfo,
  SERVER_INFO_NAME_MAX,
  type OpenboxClientAppInfo,
  type OpenboxEgressCountry,
} from '@/api/clientApp'
import CountrySelect from '@/components/common/CountrySelect.vue'
import { showNotification } from '@/helper/notification'
import { reactive, ref, watch } from 'vue'

const props = defineProps<{ info: OpenboxClientAppInfo }>()
const emit = defineEmits<{ saved: [] }>()

const form = reactive({ name: '', icon: '', region: '' })
const saving = ref(false)
const detecting = ref(false)
const egress = ref<OpenboxEgressCountry | null>(props.info.egressCountry)

watch(
  () => props.info,
  (info) => {
    form.name = info.serverInfo.name ?? ''
    form.icon = info.serverInfo.icon ?? ''
    form.region = info.serverInfo.region ?? ''
    egress.value = info.egressCountry
  },
  { immediate: true },
)

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const detect = async () => {
  detecting.value = true
  try {
    egress.value = await detectEgressCountry()
  } catch (error) {
    showNotification({
      content: 'clientAppDetectFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
  } finally {
    detecting.value = false
  }
}

const save = async () => {
  saving.value = true
  try {
    const icon = form.icon.trim()
    // iconSvg 只在图标没换时保留原值(随包索引里没有的图标才会用到);换了图标就清空
    const keepSvg = icon && icon === (props.info.serverInfo.icon ?? '')
    await saveServerInfo({
      name: form.name.trim(),
      icon,
      iconSvg: keepSvg ? (props.info.serverInfo.iconSvg ?? '') : '',
      region: form.region.trim().toUpperCase(),
    })
    showNotification({ content: 'clientAppSaved', type: 'alert-success' })
    emit('saved')
  } catch (error) {
    showNotification({
      content: 'saveFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
  } finally {
    saving.value = false
  }
}
</script>
