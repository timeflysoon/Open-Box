import type { OpenboxSkippedNode, OpenboxSubscription } from '@/api/openbox'
import { fetchSubscriptions, refreshSubscription } from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { i18n } from '@/i18n'
import { ref } from 'vue'

// 保存 / 刷新订阅的返回里带着被跳过的节点(skipped)。其中 reason 为 invalid 的是字段写坏了
// 或内核不认、被直接丢掉的,要告诉用户;其余原因(类型不认识、插件不支持等)只在预览里看。
const skippedOf = (result: unknown) => (result as { skipped?: OpenboxSkippedNode[] } | null | undefined)?.skipped

// 提示里最多列出这么多个节点名,多的折成「等,另外还有 N 个」
const DROPPED_LIST_MAX = 5
const notifyDroppedNodes = (skipped: OpenboxSkippedNode[] | undefined) => {
  const invalid = (skipped || []).filter((item) => item.reason === 'invalid')
  if (!invalid.length) return
  const t = i18n.global.t
  const list =
    invalid
      .slice(0, DROPPED_LIST_MAX)
      .map((item) => (item.detail ? `${item.name}(${item.detail})` : item.name))
      .join(t('listSeparator')) +
    (invalid.length > DROPPED_LIST_MAX ? t('subscriptionDroppedMore', { count: invalid.length - DROPPED_LIST_MAX }) : '')
  showNotification({
    content: 'subscriptionDroppedNodes',
    params: { count: String(invalid.length), list },
    type: 'alert-warning',
    timeout: 15000,
  })
}

// 订阅的动作从不自动重启内核(重启会把连接全断一次,什么时候重启由用户决定)。
// 服务端只告诉我们节点池变没变:变了就提示"重启内核生效",没变说"节点没有变化"。
// result 传保存 / 刷新接口的整个返回,用来读出被丢弃的节点并另外提示。
export const notifySubscriptionSaved = (changed: boolean | undefined, kind: 'saved' | 'refreshed' = 'saved', result?: unknown) => {
  if (changed === undefined) return
  if (changed) {
    showNotification({ content: kind === 'refreshed' ? 'subscriptionRefreshedDone' : 'subscriptionSavedDone', type: 'alert-success' })
  } else {
    showNotification({ content: 'subscriptionNodesUnchanged', type: 'alert-info' })
  }
  notifyDroppedNodes(skippedOf(result))
}

// 代理页那个「订阅」标签原本读的是 Clash API 的 /providers/proxies —— 也就是 sing-box 的
// proxy provider。但 Open-Box 是把订阅解析成一条条具体的 outbound 写进配置的,从不生成
// provider,所以那个标签在 Open-Box 里结构上恒为「订阅 (0)」,内核跑没跑起来都一样。
//
// 这里给它换上 Open-Box 自己的订阅列表:代理页和订阅设置页共用同一份数据,任一处刷新
// 之后另一处也是最新的。
export const openboxSubscriptions = ref<OpenboxSubscription[]>([])
export const openboxSubscriptionsLoading = ref(false)
export const openboxSubscriptionsError = ref('')

export const loadOpenboxSubscriptions = async () => {
  openboxSubscriptionsLoading.value = true
  openboxSubscriptionsError.value = ''
  try {
    openboxSubscriptions.value = await fetchSubscriptions()
  } catch (error) {
    openboxSubscriptionsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    openboxSubscriptionsLoading.value = false
  }
}

// 「全部刷新」:逐个串行刷,不并发。刷新会让服务端去机场拉取,四五个订阅同时拉既容易
// 撞上机场的频率限制,失败了也分不清是哪一条的问题。任一条失败不影响其余继续。
export const refreshAllOpenboxSubscriptions = async () => {
  let changed = false
  for (const sub of [...openboxSubscriptions.value]) {
    try {
      const res = await refreshSubscription(sub.id)
      if (res.changed) changed = true
      notifyDroppedNodes(skippedOf(res))
    } catch {
      // 单条失败不中断整体;具体原因在订阅设置页逐条刷新时会显示出来
    }
  }
  // 几条里只要有一条的节点变了,就提醒一次
  notifySubscriptionSaved(changed, 'refreshed')
  await loadOpenboxSubscriptions()
}
