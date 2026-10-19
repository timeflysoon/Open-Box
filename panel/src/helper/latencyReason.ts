import { i18n } from '@/i18n'

// 测速失败的原因 → 文案键。原因来自服务端 node-latency 的 reason,也来自故障转移节点的 kind。
const LATENCY_REASON_KEYS: Record<string, string> = {
  timeout: 'latencyReasonTimeout',
  closed: 'latencyReasonClosed',
  refused: 'latencyReasonRefused',
  dns: 'latencyReasonDns',
  tls: 'latencyReasonTls',
  unreachable: 'latencyReasonUnreachable',
  invalid: 'latencyReasonInvalid',
  'not-found': 'latencyReasonNotFound',
  unstable: 'latencyReasonUnstable',
  status: 'latencyReasonStatus',
  error: 'latencyReasonError',
}

// 没有对应文案(包括没给原因)就按超时算
export const latencyReasonText = (reason?: string | null) => i18n.global.t(LATENCY_REASON_KEYS[reason || ''] || 'latencyReasonTimeout')

// 一批测速结果里失败的按原因归类,多的在前:「超时 3、连接被拒绝 1」。没有失败就是空串
export const summarizeLatencyReasons = (results: { ok?: boolean; reason?: string }[]) => {
  const counts = new Map<string, number>()
  for (const r of results) {
    if (r && !r.ok) counts.set(r.reason || 'error', (counts.get(r.reason || 'error') || 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${latencyReasonText(reason)} ${n}`)
    .join(i18n.global.t('listSeparator'))
}
