<template>
  <!-- 「使用教程」弹窗:安格视界频道里标题带 Open-Box 的视频,老的在前,点了在新页签打开(与 v0.1.341 一致)。
       用原生 <dialog>.showModal():放进顶层,不受外层卡片的毛玻璃 / 变换影响。 -->
  <dialog
    ref="dialogRef"
    class="modal"
    @close="open = false"
  >
    <div class="modal-box w-full max-w-2xl">
      <form method="dialog">
        <button
          class="btn btn-sm btn-circle btn-ghost absolute top-3 right-3"
          aria-label="Close"
        >
          <XMarkIcon class="h-4 w-4" />
        </button>
      </form>
      <h3 class="pr-8 text-lg font-semibold">{{ $t('tutorialButton') }}</h3>

      <div class="mt-3 flex flex-col gap-3 text-sm">
        <div class="flex items-start justify-between gap-3 text-xs">
          <p class="text-base-content/60">{{ $t('tutorialHint') }}</p>
          <span
            v-if="checking"
            class="text-base-content/50 flex shrink-0 items-center gap-1.5"
          >
            <span class="loading loading-spinner loading-xs" />
            {{ $t('tutorialChecking') }}
          </span>
          <span
            v-else-if="error"
            class="text-base-content/50 shrink-0"
            :title="error"
          >{{ $t('tutorialCheckFailed') }}</span>
        </div>

        <div
          v-if="!videos.length && loading"
          class="flex justify-center py-6"
        >
          <span class="loading loading-spinner loading-sm" />
        </div>
        <ol
          v-else
          class="divide-base-content/10 flex flex-col divide-y"
        >
          <li
            v-for="(video, index) in videos"
            :key="video.id"
          >
            <a
              :href="`https://youtu.be/${video.id}`"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:bg-base-200 flex items-start gap-2 rounded-lg px-2 py-2"
            >
              <CountryFlag
                code="brand:youtube"
                :size="20"
                class="mt-0.5 shrink-0"
              />
              <span class="text-base-content/50 mt-px shrink-0 tabular-nums">{{ index + 1 }}.</span>
              <span class="min-w-0 flex-1 leading-6">{{ video.title }}</span>
              <ArrowTopRightOnSquareIcon class="text-base-content/50 mt-1 h-4 w-4 shrink-0" />
            </a>
          </li>
        </ol>
      </div>
    </div>
    <form
      method="dialog"
      class="modal-backdrop"
    >
      <button
        tabindex="-1"
        aria-hidden="true"
      >close</button>
    </form>
  </dialog>
</template>

<script setup lang="ts">
import {
  fetchTutorialVideos,
  refreshTutorialVideos,
  type OpenboxTutorialVideo,
  type OpenboxTutorialVideos,
} from '@/api/tutorialVideos'
import CountryFlag from '@/components/common/CountryFlag.vue'
import { ArrowTopRightOnSquareIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { nextTick, ref, watch } from 'vue'

const open = defineModel<boolean>({ required: true })

const dialogRef = ref<HTMLDialogElement | null>(null)
const videos = ref<OpenboxTutorialVideo[]>([])
const loading = ref(false)
const checking = ref(false)
const error = ref('')

// 先拿已知列表马上显示;列表太久没更新(staleAfterMs,上游现在是 0 = 每次都查)就再去查一次频道
const load = async () => {
  error.value = ''
  loading.value = true
  let current: OpenboxTutorialVideos | null = null
  try {
    current = await fetchTutorialVideos()
    videos.value = current.videos
  } catch {
    current = null
  } finally {
    loading.value = false
  }

  if (!current || Date.now() - current.updatedAt > current.staleAfterMs) {
    checking.value = true
    try {
      const next = await refreshTutorialVideos()
      videos.value = next.videos
      if (next.error) error.value = next.error
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      checking.value = false
    }
  }
}

watch(
  open,
  async (value) => {
    await nextTick()
    const el = dialogRef.value
    if (value) {
      if (el && !el.open) el.showModal()
      void load()
    } else if (el?.open) {
      el.close()
    }
  },
  { immediate: true },
)
</script>
