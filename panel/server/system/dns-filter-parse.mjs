import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { chunkRules, parseDnsFilter, ruleHasRegex } from '../engine/dns-filter.mjs'

// 名单的解析、切份、序列化都放进一条工作线程:解析 9 万条名单时活数据只有十几 MB,但 V8 会让垃圾堆到堆上限才回收,
// 在面板进程里做一次,常驻 RSS 就涨 100 多 MB 且基本不还给系统(2026-09-18 开发路由器实测 75 → 150 MB)。工作线程
// 有自己的小堆,做完线程一退整块释放;主线程只收到几 MB 的 JSON 字符串。顺带解析那一秒多主线程不再卡住
export const PARSE_WORKER_HEAP_MB = 64

export const parseListSources = (body) => {
  const result = parseDnsFilter(body)
  const sources = {}
  for (const kind of ['block', 'blockImportant', 'allow', 'allowImportant']) {
    sources[kind] = chunkRules(result.rules[kind]).map((rules) => ({ source: JSON.stringify({ version: 4, rules }), regex: rules.some(ruleHasRegex) }))
  }
  return { count: result.count, unsupported: result.unsupported, unsupportedExamples: result.unsupportedExamples, sources }
}

export const parseListInWorker = (body) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL(import.meta.url), { workerData: { body }, resourceLimits: { maxOldGenerationSizeMb: PARSE_WORKER_HEAP_MB } })
  let settled = false
  const finish = (fn, value) => { if (!settled) { settled = true; fn(value) } }
  worker.once('message', (message) => (message.error ? finish(reject, new Error(message.error)) : finish(resolve, message.result)))
  worker.once('error', (error) => finish(reject, error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error(`名单太大,解析用掉的内存超过 ${PARSE_WORKER_HEAP_MB} MB`) : error))
  worker.once('exit', (code) => finish(reject, new Error(`解析名单的工作线程异常退出（${code}）`)))
})

if (!isMainThread && parentPort && typeof workerData?.body === 'string') {
  try { parentPort.postMessage({ result: parseListSources(workerData.body) }) }
  catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
