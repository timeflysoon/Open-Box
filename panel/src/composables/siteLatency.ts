import {
  fetchSiteLatencyHistory,
  testSiteLatency,
  type OpenboxLatencyHistory,
  type OpenboxSiteLatencyResult,
} from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { useStorage } from '@vueuse/core'
import { ref } from 'vue'

// 概览「站点延迟」的共享状态:标题栏的 ⚡ 按钮、自动测速开关和下面的四个小卡要看同一份结果。
// 先写死上游默认的四个站点(服务端 GET 不带正文时也是这四个);面板设置里改站点表留到以后
export const SITES = [
  { id: 'baidu', icon: 'brand:baidu', name: '百度', url: 'https://www.baidu.com/favicon.ico' },
  { id: 'google', icon: 'brand:google', name: 'Google', url: 'https://www.google.com/generate_204' },
  { id: 'openai', icon: 'brand:openai-light', name: 'OpenAI', url: 'https://api.openai.com/v1/models' },
  { id: 'telegram', icon: 'brand:telegram', name: 'Telegram', url: 'https://telegram.org/favicon.ico' },
]

// 打开概览页时要不要自动测一轮;关掉后只显示历史,点 ⚡ 才测
export const autoSiteLatencyTest = useStorage('config/auto-site-latency-test', true)

export const siteResults = ref<Record<string, OpenboxSiteLatencyResult>>({})
export const siteHistory = ref<OpenboxLatencyHistory>({})
export const siteTimeoutMs = ref(5000)
export const siteTestedAt = ref(0)
export const siteLatencyLoading = ref(false)

const notifyError = (e: unknown) => {
  showNotification({
    content: 'routeTestRequestFailed',
    params: { message: e instanceof Error ? e.message : String(e) },
    key: 'site-latency-card',
    type: 'alert-error',
  })
}

export const loadSiteHistory = async () => {
  try {
    const data = await fetchSiteLatencyHistory()
    siteHistory.value = data.history
    siteTimeoutMs.value = data.timeoutMs
  } catch {
    // 只是先把柱子画出来,拿不到就等测完那一轮带回来
  }
}

export const runSiteLatencyTest = async () => {
  if (siteLatencyLoading.value) return
  siteLatencyLoading.value = true
  try {
    const run = await testSiteLatency(SITES.map(({ id, url }) => ({ id, url })))
    siteResults.value = Object.fromEntries(run.sites.map((site) => [site.id, site]))
    siteHistory.value = run.history
    siteTimeoutMs.value = run.timeoutMs
    siteTestedAt.value = run.testedAt
  } catch (e) {
    notifyError(e)
  } finally {
    siteLatencyLoading.value = false
  }
}
