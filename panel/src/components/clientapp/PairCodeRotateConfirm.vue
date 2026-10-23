<template>
  <!-- 更换配对码前确认一次:更换后之前导入的设备都会失效 -->
  <DialogWrapper
    v-model="open"
    :title="$t('pairCodeRotateTitle')"
  >
    <div class="flex flex-col gap-4 p-2">
      <p class="text-sm">{{ message }}</p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="btn btn-sm"
          @click="open = false"
        >
          {{ $t('cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          @click="onConfirm"
        >
          {{ $t('confirm') }}
        </button>
      </div>
    </div>
  </DialogWrapper>
</template>

<script setup lang="ts">
import DialogWrapper from '@/components/common/DialogWrapper.vue'

defineProps<{ message: string }>()
const emit = defineEmits<{ confirm: [] }>()
const open = defineModel<boolean>({ required: true })

const onConfirm = () => {
  open.value = false
  emit('confirm')
}
</script>
