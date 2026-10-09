// 故障转移(failover 组)的后台管理器。
//
// 内核里一个故障转移组落成:父 selector(tag = 组名)+ 每个多节点页签一个私有 urltest 子组
// (tag 形如 __fo:<组id>:<页签id>)+ 末位兜底拒绝。内核只会按 selector 的选择走流量,不会自己在
// 页签之间切;主备决策全在这里做,跟随面板服务端的生命周期,浏览器关了照样跑。
//
// 只认已经部署到内核的定义:config.meta.json 里的 failover 运行映射(和配置同一次生成),不看
// 弹窗里保存了还没生效的定义。meta 的 generatedAt 就是配置版本——版本一变,之前那轮探测的结果
// 一律作废,不拿旧轮次去操作新配置。
//
// 一轮检测(每个组按自己的 interval 到点跑):
//   1. GET /proxies 确认内核可达、父组和页签引用都在(部署到一半、内核正在重启时不动手);
//   2. 组内所有有效节点各测一次 GET /proxies/<节点>/delay(内核用这个节点出站真去访问测速地址,
//      端到端;有界并发;同一节点被几个页签共用只测一次,同轮结果复用);
//   3. 多节点页签只让内核消费已有结果重选(reselect_only),再读回 now 确认
//      内核实际选中的是通过检测的节点——确认不了的页签这轮算「未知」,不算恢复也不算失败;
//   4. 页签健康:通过 = 有节点通过;失败 = 所有有效节点都明确失败;其余 = 未知(有节点没测到 /
//      探测服务报错)。空页签(有效节点为 0)永远是不可用。
//   5. 决策:当前页签仍通过就留着(备用延迟更低不是切换理由)。当前页签确认失败(用户 2026-09-30 定的规则):
//      不通 → 过 RECHECK_DELAY_MS(10 秒)强制复查当前页签的节点一次 → 复查通过就回到正常周期,复查仍不通
//      才按页签顺序转到第一个通过的候选(档案里的 failureThreshold 不再起作用);当前不是主用、主用连续通过满 recoveryHoldMs 且
//      开了「恢复后切回」就切回主用;全部候选都确认失败就切到兜底拒绝(不转直连),之后继续定期
//      检查,有候选恢复再切回去;未知不触发任何切换。
//      用户改了页签顺序(按稳定页签 id 的先后比,改名 / 换图标 / 别的原因重新生成配置都不算)是一次
//      「按新优先级重选」的待办:更靠前的页签这轮确认通过就挪过去,不要求当前页签先失败、也和
//      「恢复后切回」开关无关;目标是主用的仍走主用那套规则(开关 + 等待);目标还没确认或切换失败就
//      保留当前、下一轮再看。待办跟着状态落盘,内核 / 面板重启后接着办,直到落定。
//   6. 切换 = PUT /proxies/<父组> {name},再读回 now 确认;失败保留实际状态并记原因。
//
// 自动选择是运行状态,不回写用户的页签顺序;只把「当前在哪个页签」按稳定页签 id 存进
// openbox/failover-state,重启 / 重新部署后据此恢复关联,但健康一定重新检测过才动手。
//
// 判断(测哪些节点、页签健康、切不切、下一轮隔多久)在 engine/failover-core.mjs,App 的故障转移用同一份
// (client-engine 的 OpenBoxEngine.failover*);这里只管读写内核、落盘和调度。
//
// 调度(GitHub #514):每个组的轮次各跑各的——tick 只负责把到点的组派出去,不等它们跑完;一个大组一轮要几分钟,别的组
// 照常按自己的间隔进下一轮。测速都经面板全局的一份名额(system/probe-limiter.mjs,和内核的 4 个一样多):一轮的节点
// 一次全交给名额排队,拿到名额才发、才开始计时,不会因为排队被本地期限掐断记成「未知」。配置一变(部署 / 重启内核 /
// 升级)各组按顺序错开几秒再开始,不再同一个 tick 齐发。刷新 / 「重新检测」立刻生效:正在跑的轮次作废,还在排队的
// 测速撤掉,马上开新一轮。
import { CLASH_API_BASE } from '../api/penetration.mjs'
import {
  RECHECK_DELAY_MS, assessLane, decideRound, finishRound, initFailoverState, laneObservation, laneRole, needsLatestHistory,
  needsSwitch, nextRoundDelay, persistedOf, recordProbes, roundPlan,
} from '../engine/failover-core.mjs'
import { expectedQuery, kernelTestUrl, normalizeExpectedStatus, probeKeyUrl } from '../engine/test-url.mjs'
import { configMetaPath } from './deploy.mjs'
import { createProbeLimiter } from './probe-limiter.mjs'
import { fetchJson } from './fetch-json.mjs'
import { classifyProbeError } from './node-probe.mjs'
import { processUptime } from './service.mjs'

export { RECHECK_DELAY_MS, laneRole }
export const FAILOVER_STATE_KEY = 'openbox/failover-state'
// 配置一变各组的首轮错开多少(按组的先后):13 个组 26 秒内依次开始,测速在全局名额里按先后排,先派的组先出结果
export const FIRST_ROUND_STAGGER_MS = 2000
// 一轮最长多久:超过就当它卡住了,作废重来(每个请求都有自己的期限,正常不会到;这里只是兜底,并打日志)
export const ROUND_WATCHDOG_MS = 60 * 60_000

const errText = (err) => (err instanceof Error ? err.message : String(err))

export const createFailoverManager = ({
  store, ctx, paths, history = null, fetchImpl = globalThis.fetch, now = () => Date.now(),
  probeCoordinator = null, limiter = null, tickMs = 5000, probeConcurrency = 4, log = () => {},
}) => {
  // 测速名额:协调器自带的(面板全局那一份)优先;没有就用传进来的,再没有就自己建一份(测试 / 单独使用)
  const probeLimiter = probeCoordinator?.limiter || limiter || createProbeLimiter({ limit: probeConcurrency, now })
  const headers = () => {
    const secret = store.getClashSecret ? store.getClashSecret() : ''
    return secret ? { Authorization: `Bearer ${secret}` } : {}
  }
  const api = (path) => `${CLASH_API_BASE}${path}`

  // ---- 持久化的关联(组 id → 当前页签 id / 最近一次切换)----
  const loadPersisted = () => {
    try {
      const raw = store.getRaw ? store.getRaw(FAILOVER_STATE_KEY) : null
      const parsed = raw ? JSON.parse(raw) : null
      return parsed && typeof parsed === 'object' && parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {}
    } catch { return {} }
  }
  const persist = () => {
    if (!store.setRaw) return
    const groups = {}
    for (const g of states.values()) groups[g.id] = persistedOf(g)
    try { store.setRaw(FAILOVER_STATE_KEY, JSON.stringify({ groups })) } catch (err) { log(`[failover] 状态写不进去:${errText(err)}`) }
  }

  // ---- 运行状态 ----
  let version = null // 已加载的配置版本(meta.generatedAt)
  // stop() 之后置 true:进行中的轮次一律作废。没 start 也能手动 tick(测试 / 状态接口的 refresh)
  let stopped = false
  let timer = null
  // 派发(读 meta、算到点的组、开轮次)同一时刻只有一个;轮次本身不在这把锁里
  let dispatching = false
  let dispatchAgain = false
  let roundSeq = 0
  const registeredOwners = new Set()
  let lastError = ''
  let paused = '' // '' | 'config' | 'kernel'
  const states = new Map() // groupId → state

  // 版本变了重建每个组的状态(engine/failover-core.mjs 的 initFailoverState:关联提示、页签顺序变了记「按新顺序重选」的待办)
  const loadMap = (meta) => {
    const persisted = loadPersisted()
    const list = Array.isArray(meta?.failover) ? meta.failover : []
    const keep = new Set()
    for (const def of list) {
      if (!def || typeof def !== 'object' || !def.id || !def.tag) continue
      keep.add(def.id)
      const prev = states.get(def.id) || null
      if (prev) cancelRound(prev)
      const { state, logs } = initFailoverState(def, { prev, saved: persisted[def.id] || null, now: now() })
      for (const line of logs) log(line)
      // 首轮按组的先后错开(GitHub #514:以前版本一变所有组 nextRoundAt 都是 0,同一个 tick 齐发)
      state.nextRoundAt = now() + (keep.size - 1) * FIRST_ROUND_STAGGER_MS
      states.set(def.id, state)
    }
    for (const id of [...states.keys()]) if (!keep.has(id)) { cancelRound(states.get(id)); states.delete(id) }
    persist()
  }

  const readMeta = async () => {
    const raw = await ctx.readFile(configMetaPath(paths))
    const meta = JSON.parse(raw)
    return meta && typeof meta === 'object' ? meta : {}
  }

  // 每 tick 看一眼 meta:版本变了就重载映射,之前的轮次作废
  const syncMap = async () => {
    let meta
    try { meta = await readMeta() } catch (err) {
      // 没部署过 / 文件没了:没有组可管;已加载的映射也清掉(配置不在了)
      if (version !== null || states.size) { version = null; states.clear() }
      paused = 'config'
      lastError = errText(err)
      return false
    }
    paused = ''
    const v = String(meta.generatedAt || '')
    if (v !== version) {
      version = v
      loadMap(meta)
      log(`[failover] 载入运行映射 ${v || '(无版本)'}:${states.size} 个故障转移组`)
    }
    return true
  }

  const fetchProxies = async () => {
    const { res, body } = await fetchJson(fetchImpl, api('/proxies'), { headers: headers() }, 5000)
    if (!res || !res.ok) throw new Error(`proxies HTTP ${res ? res.status : 'none'}`)
    return (body && body.proxies) || {}
  }
  const fetchProxy = async (tag) => {
    const { res, body } = await fetchJson(fetchImpl, api(`/proxies/${encodeURIComponent(tag)}`), { headers: headers() }, 5000)
    if (!res || !res.ok) throw new Error(`proxy ${tag} HTTP ${res ? res.status : 'none'}`)
    return body
  }
  // 单个节点的端到端探测。内核用这个节点出站访问测速地址:200 = 通过;503 / 504 = 这个节点失败
  // (超时 / 出错);别的情况(接口不可达、404、5xx)是探测基础设施的问题,记未知,不算节点失败。
  // 随包内核的 Clash API 保留 HTTP / HTTPS 地址，与内部子组的定时探测使用同一配置。
  // 优先级(内核 1.14.1-openbox-tcp14 起全内核一份测速额度):例行检测 interactive——排在后台大批测速(定时测速、组自己的
  // 间隔检测)前面,几个节点而已;10 秒复查 critical——保流量,排在最前(内核里后台最多占 3 个名额,总有一个给它)。排队不占节点自己的超时(内核拿到名额才开始计),
  // 本地等回话要给排队留时间;老内核不认 priority 参数也照常测
  // since(毫秒):复查时带上这一次失败的时刻——内核自己对正在用的节点也会在 10 秒后复查(tcp14),两边都是「比这次失败更新的
  // 一个结果」:谁先到谁真测,后到的直接用那个结果(正在测就等它),同一个节点只多测一次
  // expected:可接受状态码(内核 tcp19),回别的状态码内核按失败答(503)
  // priority:这一项在名额里和内核里排哪一档(默认 force 是 critical、否则 interactive;「重新检测」是 force + interactive)。
  // 这个函数拿到名额才调用,期限只算内核那边(内核里也可能排一会儿:后台的组自检、手动测速)
  // 失败时内核回应里的 error(原始报错,比如 unexpected status 404)一并带回,面板照原样显示,不用再测一次
  const probeNode = async (tag, url, timeoutMs, intervalMs, force = false, since = 0, expected = '', priority = force ? 'critical' : 'interactive') => {
    const at = now()
    const sinceQuery = force && since > 0 ? `&since=${Math.floor(since)}` : ''
    try {
      const { res, body } = await fetchJson(fetchImpl, api(`/proxies/${encodeURIComponent(tag)}/delay?url=${encodeURIComponent(url)}&timeout=${timeoutMs}&force=${force}&interval=${intervalMs}&priority=${priority}${sinceQuery}${expectedQuery(expected)}`), { headers: headers() }, timeoutMs + (force ? 20_000 : 60_000))
      if (!res) return { ok: null, at, reason: 'no-response' }
      // 内核复用结果时必须保留原始完成时间,不能把缓存读取记成一次新探测。reused:这次是内核缓存里别的使用者
      // (自动优选、内核自己的定时检测、手动测速)刚测完的结果,不是这一轮新发的请求
      const completedAt = Date.parse(body?.time)
      const observedAt = Number.isFinite(completedAt) && completedAt > 0 ? completedAt : now()
      const reused = Boolean(body && body.reused === true)
      // kind:失败归哪一类(和手动测速同一套:timeout / status / refused / tls …,界面翻成人话),error 是原文
      const errorText = body && typeof body.error === 'string' ? body.error.slice(0, 200) : ''
      if (res.ok) {
        const delay = body && Number.isFinite(Number(body.delay)) ? Number(body.delay) : 0
        return delay > 0 ? { ok: true, delay, at: observedAt, reused } : { ok: false, delay: 0, at: observedAt, reused, reason: 'zero-delay', kind: 'error' }
      }
      if (res.status === 503 || res.status === 504) {
        const kind = errorText ? classifyProbeError(errorText) : res.status === 504 ? 'timeout' : 'error'
        return { ok: false, delay: 0, at: observedAt, reused, reason: res.status === 504 ? 'timeout' : 'failed', kind, ...(errorText ? { error: errorText } : {}) }
      }
      return { ok: null, at, reason: `http-${res.status}` }
    } catch (err) {
      // 测速接口自己没在期限内应答:探测基础设施的问题,记未知(不算节点失败、不复查、不切换)
      return { ok: null, at, reason: err && err.name === 'AbortError' ? 'probe-timeout' : errText(err) }
    }
  }
  // 只更新选择。即使节点刚超时、没有成功 history,这里也不允许偷偷再发请求。
  const retestSub = async (subTag, url, timeoutMs) => {
    try {
      // reselect_only:只按已有结果重选,不测(内核直接重选、马上回,不等组正在跑的检测)
      const { res } = await fetchJson(fetchImpl, api(`/group/${encodeURIComponent(subTag)}/delay?url=${encodeURIComponent(url)}&timeout=${timeoutMs}&force=false&reselect_only=true`), { headers: headers() }, 10_000)
      return Boolean(res && res.ok)
    } catch { return false }
  }
  const switchTo = async (state, ref) => {
    const { res } = await fetchJson(fetchImpl, api(`/proxies/${encodeURIComponent(state.tag)}`), {
      method: 'PUT', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ name: ref }),
    }, 5000)
    if (!res || !(res.ok || res.status === 204)) throw new Error(`PUT ${state.tag} → ${ref}:HTTP ${res ? res.status : 'none'}`)
    const back = await fetchProxy(state.tag)
    if (back?.now !== ref) throw new Error(`切到 ${ref} 后读回的是 ${back?.now ?? '(空)'}`)
    return back.now
  }

  // 一个测速项交给名额排队(协调器在时经它去重:同一节点同一地址正在测就加入)。signal 是这一轮的:轮次作废时
  // 还在排队的撤掉,回 { ok: null, reason: 'cancelled' }
  const scheduleProbe = ({ tag, keyUrl, intervalMs, run, force, priority, signal }) => {
    if (probeCoordinator) {
      const viaLimiter = probeCoordinator.limiter ? run : () => probeLimiter.run(priority, run, { signal })
      return probeCoordinator.request({ tag, url: keyUrl, intervalMs, run: viaLimiter, force, priority, signal })
    }
    return probeLimiter.run(priority, run, { signal })
      .catch((err) => ({ ok: null, at: now(), reason: err && err.cancelled ? 'cancelled' : errText(err) }))
  }

  // 跑一轮:探测 → 页签健康 → 决策 → 切换。判断都在 engine/failover-core.mjs,这里按顺序读写内核。返回摘要给日志 / 测试看。
  // round:这一轮的令牌(startRound 给的);刷新 / 重新检测 / 新版本 / 看门狗作废它之后,这里读到就停手,结果一律不用
  const runRound = async (state, proxies, kernelStartedAt, round) => {
    const roundVersion = version
    const roundId = ++state.lastRoundId
    const startedAt = now()
    // 这轮开始前内核对这个组的看法:父组和页签引用都在才动手,并给出这轮要测的节点(复查轮强制重测当前页签的)
    const manualAt = Number(state.manualRecheckAt) || 0
    const plan = roundPlan(state, proxies, { now: startedAt })
    if (plan.skip) return { skipped: plan.skip }
    const { url, expected = '', timeoutMs, recheckRound } = plan
    const ownInterval = plan.intervalMs
    const keyUrl = probeKeyUrl(url, expected)
    const stale = () => stopped || version !== roundVersion || states.get(state.id) !== state || state.round !== round

    // 1. 节点探测:这一轮的测速项一次全交给名额排队(先派的组排在前面,先出结果),拿到名额才发
    const results = new Map()
    const probeInterval = (tag) => (probeCoordinator ? probeCoordinator.intervalFor(probeCoordinator.keyOf(tag, keyUrl), ownInterval) : ownInterval)
    if (plan.probes.length) {
      round.total = plan.probes.length
      const list = await Promise.all(plan.probes.map(async ({ tag, force, since, priority }) => {
        const level = priority || (force ? 'critical' : 'interactive')
        const run = () => probeNode(tag, url, timeoutMs, probeInterval(tag), force, since, expected, level)
        const r = await scheduleProbe({ tag, keyUrl, intervalMs: force ? probeInterval(tag) : ownInterval, run, force, priority: level, signal: round.controller.signal })
        round.done += 1
        return r || { ok: null, at: now(), reason: 'no-result' }
      }))
      list.forEach((r, i) => results.set(plan.probes[i].tag, r))
    }
    if (stale()) return { skipped: 'stale' }
    // 「重新检测」要的全量强制测速这一轮做完了(之后照常)
    if (manualAt && state.manualRecheckAt === manualAt) state.manualRecheckAt = 0
    const byTag = Object.fromEntries(results)
    recordProbes(state, byTag, roundId)
    // 探测结果进公共延迟历史(失败的记一笔超时,通过的内核自己已经记了,scheduler 同步时会看到)
    if (history) {
      try {
        // 复用来的(自动优选 / 内核缓存 / 之前轮次已经记过的)不再记:同一次失败只记一笔
        const samples = [...results].filter(([, r]) => r.ok === false && !r.reused).map(([name, r]) => ({ name, time: new Date(r.at).toISOString(), delay: 0 }))
        if (samples.length) history.recordSamples(samples)
      } catch { /* 历史记不上不影响决策 */ }
    }

    // 2. 页签健康(先确认内核还在)。要读内核的页签:手动选择的读子组 now;多节点页签有节点通过就让内核按已有结果
    //    重选(reselect_only)再读 now,选中的不在通过的节点里时再读它的最新历史(更新的通过也算确认)
    try { await fetchProxies() } catch { return { skipped: 'kernel' } }
    if (stale()) return { skipped: 'stale' }
    for (const lane of state.lanes) {
      const need = laneObservation(lane, byTag, url)
      let observed = null
      if (need) {
        if (need.reselect) {
          await retestSub(lane.subTag, url, timeoutMs)
          if (stale()) return { skipped: 'stale' }
        }
        let sub = null
        try { sub = await fetchProxy(lane.subTag) } catch { /* 读不到就按未确认 */ }
        if (!need.reselect && stale()) return { skipped: 'stale' }
        const kernelNow = sub && typeof sub.now === 'string' ? sub.now : ''
        observed = { now: kernelNow, latest: null }
        if (need.reselect && needsLatestHistory(lane, byTag, kernelNow)) {
          let p = null
          try { p = await fetchProxy(kernelNow) } catch { /* 读不到就不算更新的通过 */ }
          const h = p && Array.isArray(p.history) ? p.history[p.history.length - 1] : null
          observed.latest = h ? { time: h.time, delay: h.delay } : null
        }
      }
      const line = assessLane(lane, byTag, observed, { url, startedAt, tag: state.tag })
      if (line) log(line)
    }

    // 3. 决策 → 切换(PUT 父组,再读回 now 确认)
    let parentNow = ''
    try { parentNow = String((await fetchProxy(state.tag))?.now || '') } catch { return { skipped: 'kernel' } }
    if (stale()) return { skipped: 'stale' }
    const at = now()
    const decided = decideRound(state, { parentNow, recheckRound, at })
    for (const line of decided.logs) log(line)
    let outcome = null
    if (needsSwitch(decided.decision, parentNow)) {
      try {
        const nowRef = await switchTo(state, decided.decision.target.ref)
        if (stale()) return { skipped: 'stale' }
        outcome = { now: nowRef }
      } catch (err) {
        outcome = { error: errText(err) }
      }
    }
    // 4. 收尾:状态、复查、摘要
    const finished = finishRound(state, decided.decision, { parentNow, at, startedAt, outcome })
    for (const line of finished.logs) log(line)
    persist()
    if (history && kernelStartedAt !== undefined) {
      try {
        const groupIntervals = Object.fromEntries([...states.values()].flatMap((g) => {
          const interval = Number(g.settings?.intervalMs) || 300_000
          return [[g.tag, interval], ...g.lanes.filter((l) => l.subTag).map((l) => [l.subTag, interval])]
        }))
        history.recordFromProxies(await fetchProxies(), { kernelStartedAt, at: now(), groupIntervals })
      } catch { /* 忽略 */ }
    }
    return finished.result
  }

  // 作废一个组正在跑的轮次:还在名额里排队的测速撤掉,这一轮之后读写内核的步骤读到令牌变了就停手
  const cancelRound = (g, why = '') => {
    if (!g || !g.round) return
    g.round.controller.abort()
    g.round = null
    g.inFlight = false
    if (why) log(`[failover] ${g.tag}:正在进行的一轮作废(${why})`)
  }

  const registerOwners = () => {
    if (!probeCoordinator) return
    const currentOwners = new Set([...states.values()].map((g) => `failover:${g.id}`))
    for (const id of registeredOwners) if (!currentOwners.has(id)) {
      probeCoordinator.unregisterOwner(id)
      registeredOwners.delete(id)
    }
    for (const g of states.values()) {
      const id = `failover:${g.id}`
      probeCoordinator.unregisterOwner(id)
      const intervalMs = Math.max(5000, Number(g.settings?.intervalMs) || 300_000)
      // 去重的键带上可接受状态码:同一节点同一地址,状态码要求不同的不能共用结果
      const url = probeKeyUrl(kernelTestUrl(g.settings?.testUrl || ''), normalizeExpectedStatus(g.settings?.expectedStatus) ?? '')
      for (const lane of g.lanes) for (const tag of lane.valid) probeCoordinator.register(id, tag, url, intervalMs)
      registeredOwners.add(id)
    }
  }

  // 开一个组的一轮,不等它跑完(派发不被一个大组拖住);跑完自己排下一轮
  const startRound = (g, proxies, kernelStartedAt) => {
    const round = { token: ++roundSeq, controller: new AbortController(), startedAt: now(), done: 0, total: 0 }
    g.round = round
    g.inFlight = true
    return (async () => {
      try {
        const r = await runRound(g, proxies, kernelStartedAt, round)
        if (g.round !== round) return r && r.skipped ? r : { skipped: 'stale' } // 作废了:下一轮由作废它的人安排
        if (r && r.skipped) {
          g.paused = r.skipped === 'kernel-mismatch' || r.skipped === 'parent-missing' ? 'kernel-mismatch' : r.skipped === 'kernel' ? 'kernel' : ''
          // 内核和映射对不上(部署到一半)/ 内核刚倒:很快再看;作废的轮次由新版本自己安排
          if (r.skipped !== 'stale') g.nextRoundAt = now() + nextRoundDelay(g, { skip: r.skipped })
        } else {
          g.paused = ''
          g.nextRoundAt = now() + nextRoundDelay(g, { result: r })
        }
        return r
      } catch (err) {
        if (g.round === round) {
          g.lastError = errText(err)
          g.nextRoundAt = now() + nextRoundDelay(g, { skip: 'error' })
        }
        log(`[failover] ${g.tag} 这轮出错:${errText(err)}`)
        return { skipped: 'error' }
      } finally {
        if (g.round === round) { g.round = null; g.inFlight = false }
      }
    })()
  }

  // 派发一次:读 meta(版本变了重载映射)、登记去重、看门狗、把到点的组派出去。返回派出去的轮次(不等)
  const dispatchOnce = async () => {
    if (!(await syncMap())) return { skipped: 'config' }
    if (!states.size) return { skipped: 'none' }
    registerOwners()
    for (const g of states.values()) {
      if (g.round && now() - g.round.startedAt > ROUND_WATCHDOG_MS) {
        cancelRound(g, `超过 ${Math.round(ROUND_WATCHDOG_MS / 60_000)} 分钟还没跑完,当作卡住了`)
        g.nextRoundAt = now() + 10_000
      }
    }
    const due = [...states.values()].filter((g) => !g.inFlight && now() >= g.nextRoundAt)
    if (!due.length) return { skipped: 'idle' }
    let proxies
    try { proxies = await fetchProxies() } catch (err) {
      // 内核不可达 / 正在重启:到点的组暂停,不动健康、不动计数;10 秒后再看
      paused = 'kernel'
      lastError = errText(err)
      for (const g of due) { g.paused = 'kernel'; g.nextRoundAt = now() + Math.min(10_000, g.settings?.intervalMs || 10_000) }
      return { skipped: 'kernel' }
    }
    paused = ''
    lastError = ''
    let kernelStartedAt = null
    try { const up = await processUptime(ctx, 'sing-box'); kernelStartedAt = typeof up === 'number' ? now() - up * 1000 : null } catch { /* 没有也行 */ }
    // 上面等内核回话的时候可能刷新过 / 换了版本:只派还在、还没在跑的
    const started = due.filter((g) => states.get(g.id) === g && !g.inFlight).map((g) => [g, startRound(g, proxies, kernelStartedAt)])
    return { started }
  }

  // 测试和状态接口用:派发一次,并等这次派出去的轮次跑完,回各组这一轮的摘要
  const tick = async () => {
    if (dispatching) return { skipped: 'busy' }
    dispatching = true
    let r
    try { r = await dispatchOnce() } finally { dispatching = false }
    if (r.skipped) return r
    const ran = {}
    await Promise.all(r.started.map(async ([g, p]) => { ran[g.tag] = await p }))
    return { ran }
  }

  // 后台用:派发,不等轮次;正在派发时有人要求立刻再派(刷新 / 重新检测),派完马上再来一次
  const pump = async () => {
    if (dispatching) { dispatchAgain = true; return }
    dispatching = true
    try {
      do {
        dispatchAgain = false
        try { await dispatchOnce() } catch (err) { log(`[failover] 派发出错:${errText(err)}`) }
      } while (dispatchAgain && !stopped)
    } finally { dispatching = false }
  }

  const start = () => {
    if (timer) return
    stopped = false
    const loop = () => {
      timer = setTimeout(async () => {
        await pump()
        if (!stopped) loop()
      }, tickMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }
    loop()
  }
  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    for (const g of states.values()) cancelRound(g)
  }
  // 部署 / 组定义改动后立刻重载映射并重新检测(不等 interval,也不等正在跑的轮次):正在跑的作废、排队的测速撤掉。
  // 没 start 的(测试)只重置,下一次 tick 生效
  const refresh = () => {
    version = null
    let i = 0
    for (const g of states.values()) {
      cancelRound(g)
      g.nextRoundAt = now() + i * FIRST_ROUND_STAGGER_MS
      i += 1
    }
    if (timer) void pump()
  }
  // 「重新检测」一个组(GitHub #514):正在跑的那轮作废,马上开一轮把这个组的节点全部强制测一遍(比点的那一刻新的结果才算)。
  // 组不在(没部署 / id 不对)回 false
  const recheck = (groupId) => {
    const g = states.get(String(groupId || ''))
    if (!g) return false
    cancelRound(g, '有人点了重新检测')
    g.manualRecheckAt = now()
    g.nextRoundAt = 0
    if (timer) void pump()
    return true
  }

  // probes:面板全局测速名额此刻的情况(在测 / 各档排队)、最近每秒测完几个、按各组间隔每秒要测几个
  //(需求长期超过吞吐 = 测不过来,界面提示减少节点或加大间隔)
  const probeStats = () => {
    const q = probeLimiter.stats()
    const throughput = probeLimiter.throughput()
    return {
      ...q,
      throughputPerSec: throughput === null ? null : Math.round(throughput * 100) / 100,
      demandPerSec: probeCoordinator ? Math.round(probeCoordinator.demandPerSec() * 100) / 100 : null,
    }
  }

  const status = () => ({
    version, paused, lastError, running: !stopped,
    probes: probeStats(),
    groups: [...states.values()].map((g) => ({
      id: g.id, tag: g.tag, status: g.status, paused: g.paused, lastError: g.lastError, rejectTag: g.rejectTag,
      currentLaneId: g.currentLaneId, currentSince: g.currentSince, kernelNow: g.kernelNow || null,
      lastSwitch: g.lastSwitch, lastRoundAt: g.lastRoundAt || null, nextRoundAt: g.nextRoundAt || null, inFlight: g.inFlight,
      // 正在跑的这一轮:什么时候开始的、节点测了几个(界面显示「检测中 x / y」);manualRecheck:「重新检测」还没做完
      round: g.round ? { startedAt: g.round.startedAt, done: g.round.done, total: g.round.total } : null,
      manualRecheck: Boolean(g.manualRecheckAt),
      laneOrder: g.laneOrder, reorder: g.reorder || null,
      settings: g.settings,
      lanes: g.lanes.map((l) => ({
        id: l.id, name: l.name, index: l.index, role: laneRole(l.index), mode: l.mode, ref: l.ref, subTag: l.subTag,
        members: l.members, valid: l.valid, health: l.health, failStreak: l.failStreak, upSince: l.upSince,
        kernelNow: l.kernelNow, confirmed: l.confirmed,
        nodes: Object.fromEntries(l.valid.map((t) => [t, g.nodes[t] ? { ok: g.nodes[t].ok, delay: g.nodes[t].delay ?? null, at: g.nodes[t].at, reason: g.nodes[t].reason || null, kind: g.nodes[t].kind || null, error: g.nodes[t].error || null } : null])),
      })),
    })),
  })

  return { start, stop, tick, refresh, recheck, status, _states: states }
}
