// 故障转移(failover 组)的判断逻辑:路由器的后台管理器(system/failover-manager.mjs)和 App(client-engine 的
// OpenBoxEngine.failover*)用同一份(用户 2026-10-05:手机上的故障转移也要自动切,对齐路由器版)。
// 这里只有判断:一轮测哪些节点、哪些页签要读内核、页签健康、切不切 / 切到哪、收尾和下一轮隔多久。读写内核
// (测速、让自动组重选、读 now、切父组、落盘)由调用方自己做,顺序见 failover-manager.mjs 的 runRound。
//
// 状态是一个能 JSON 往返的对象(App 每一步把上一步还回来的原样传进来);这里的函数直接改它,同时返回要打的日志。
// 规则(用户 2026-09-30 定):当前页签仍通过就留着;确认失败 → RECHECK_DELAY_MS 后强制复查当前页签 → 仍不通才按
// 顺序换到第一个通过的候选;主用连续通过满 recoveryHoldMs 且开了「恢复后切回」就切回主用;全部候选确认失败切兜底
// 拒绝;未知不触发切换;用户改了页签顺序是一次「按新优先级重选」的待办。细节见 failover-manager.mjs 文件头
import { kernelTestUrl, normalizeExpectedStatus } from './test-url.mjs'

// 当前页签不通之后多久复查一次(用户 2026-09-30 定的规则:不通 → 10 秒后再测一次 → 仍不通才换页签)
export const RECHECK_DELAY_MS = 10_000

export const laneRole = (index) => (index === 0 ? 'primary' : `backup-${index}`)
const sameOrder = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])

export const freshLane = (lane) => ({
  id: lane.id, name: lane.name || '', index: lane.index, mode: lane.mode, ref: lane.ref, subTag: lane.subTag,
  members: [...(lane.members || [])], valid: [...(lane.valid || [])],
  health: lane.mode === 'empty' ? 'down' : 'unknown', failStreak: 0, upSince: null, kernelNow: null, confirmed: null,
})

// 一个组的运行状态:定义(config.meta.json 的 failover 运行映射 / App 生成配置时的 failover)+ 上一份运行状态(prev,
// 配置版本变了之前那份)+ 落盘的关联(saved)。同一页签 id 的节点探测结果不带过版本:配置一变,节点参数可能变了,健康重新测
export const initFailoverState = (def, { prev = null, saved = null, now }) => {
  const logs = []
  const lanes = (Array.isArray(def.lanes) ? def.lanes : []).map(freshLane)
  const laneIds = new Set(lanes.map((l) => l.id))
  const hintLane = prev?.currentLaneId && laneIds.has(prev.currentLaneId) ? prev.currentLaneId
    : saved?.laneId && laneIds.has(saved.laneId) ? saved.laneId : null
  // 页签顺序(稳定 id 的先后)和上一次已经应用的顺序比:变了就是用户改了主备优先级,记一条待办,
  // 下一轮按新顺序重选(decideRound);上次的待办没办完就带过来。老的落盘记录没有顺序信息
  // (这个功能之前存下的):不知道用户有没有改过,记一次「按当前顺序校正」的待办,只校正到当前
  // 页签就是新顺序里第一个通过的为止,不把停在备用上的强行挪回主用(那是「恢复后切回」开关的事)
  const order = lanes.map((l) => l.id)
  const prevOrder = Array.isArray(prev?.laneOrder) ? prev.laneOrder : Array.isArray(saved?.laneOrder) ? saved.laneOrder : null
  const carried = prev?.reorder ?? saved?.reorder ?? null
  let reorder = carried && typeof carried === 'object' ? { since: carried.since, reason: carried.reason, evaluated: Boolean(carried.evaluated) } : null
  if (prevOrder && !sameOrder(prevOrder, order)) {
    reorder = { since: now, reason: 'priority-changed', evaluated: false }
    logs.push(`[failover] ${def.tag}:页签顺序从 ${prevOrder.join('/')} 改成 ${order.join('/')},下一轮按新顺序重选`)
  } else if (!prevOrder && saved && !reorder) {
    reorder = { since: now, reason: 'order-unknown', evaluated: false }
  }
  const state = {
    id: def.id, tag: def.tag, rejectTag: def.rejectTag || '', settings: def.settings || {},
    lanes, laneOrder: order, reorder,
    // 关联提示:上个版本 / 上次重启前在哪个页签。只是提示——健康没重新核过之前不据此宣布任何事
    currentLaneId: hintLane, currentSince: prev?.currentSince ?? saved?.at ?? null,
    lastSwitch: prev?.lastSwitch ?? saved?.lastSwitch ?? null,
    status: 'pending', paused: '', lastRoundAt: 0, nextRoundAt: 0, lastRoundId: 0, lastRoundResult: '',
    primaryUpSince: null, nodes: {}, inFlight: false, lastError: '',
  }
  return { state, logs }
}

// 落盘的那几样(重启 / 重新生成配置后据此恢复关联,健康一定重新检测过才动手)
export const persistedOf = (state) => ({ laneId: state.currentLaneId, at: state.currentSince, lastSwitch: state.lastSwitch, laneOrder: state.laneOrder, reorder: state.reorder })

export const laneById = (state, id) => state.lanes.find((l) => l.id === id) || null
// 内核此刻的选择对应哪个页签:先信记录的当前页签(它的引用就是 now 时),否则按顺序找第一个引用等于 now 的
export const laneForNow = (state, kernelNow) => {
  if (!kernelNow || kernelNow === state.rejectTag) return null
  const hinted = state.currentLaneId ? laneById(state, state.currentLaneId) : null
  if (hinted && hinted.ref === kernelNow) return hinted
  return state.lanes.find((l) => l.ref === kernelNow) || null
}

const nowOf = (proxies, tag) => (proxies[tag] && typeof proxies[tag].now === 'string' ? proxies[tag].now : '')

// 复查看哪几个节点:外层 selector 此刻选的那个页签(当前页签)。手动选择的页签只看用户选中的那个节点,
// 别的看全部有效节点;兜底拒绝 / 认不出当前页签 / 空页签都不复查
export const recheckTargets = (state, proxies) => {
  const lane = laneForNow(state, nowOf(proxies, state.tag))
  if (!lane || lane.mode === 'empty') return []
  if (lane.mode === 'selector') {
    const picked = nowOf(proxies, lane.subTag)
    return picked && lane.valid.includes(picked) ? [picked] : []
  }
  return [...lane.valid]
}

// 一轮之前:proxies 是 GET /proxies 的 proxies。父组 / 页签引用不在(部署到一半、内核正在重启)就给 skip,不动手;
// 否则给这轮的参数和要测的节点(去重)。复查轮(上一轮当前页签确认失败)只强制重测当前页签的节点,带上那次失败的
// 完成时刻(since);别的照常复用间隔内的结果。没有测速地址就一个都不测(页签全算未知)。
// expected:可接受状态码(内核 tcp19,'' = 不限),测速请求带上它,回别的状态码算这个节点失败
export const roundPlan = (state, proxies) => {
  const s = state.settings || {}
  const parent = proxies[state.tag]
  if (!parent || !Array.isArray(parent.all)) return { skip: 'parent-missing' }
  const expectedRefs = state.lanes.map((l) => l.ref).filter(Boolean)
  if (expectedRefs.some((r) => !parent.all.includes(r) || !proxies[r])) return { skip: 'kernel-mismatch' }
  if (state.rejectTag && !parent.all.includes(state.rejectTag)) return { skip: 'kernel-mismatch' }
  const url = kernelTestUrl(s.testUrl || '')
  const recheckRound = Boolean(state.recheckPending)
  const forced = new Set(recheckRound ? recheckTargets(state, proxies) : [])
  const tags = [...new Set(state.lanes.flatMap((l) => l.valid))]
  const probes = url ? tags.map((tag) => {
    const force = forced.has(tag)
    const node = state.nodes[tag]
    const since = force ? (node && node.ok === false && Number.isFinite(node.at) ? node.at : state.lastRoundAt || 0) : 0
    return { tag, force, since }
  }) : []
  // 不限时不带这个字段(计划和以前一样;App 读不到当空串)
  const expected = normalizeExpectedStatus(s.expectedStatus) ?? ''
  return { url, ...(expected ? { expected } : {}), timeoutMs: Number(s.timeoutMs) || 5000, intervalMs: Number(s.intervalMs) || 300_000, recheckRound, probes }
}

// 记下这一轮的探测结果。results:{ [节点]: { ok: true | false | null, delay, at, reused, reason } }(ok null = 探测本身出了问题)
export const recordProbes = (state, results, roundId) => {
  for (const [tag, r] of Object.entries(results || {})) state.nodes[tag] = { ...r, round: roundId }
}

const okNodesOf = (lane, results) => lane.valid.filter((t) => results[t] && results[t].ok === true)

// 这个页签这轮要从内核读什么:手动选择的读子组 now;多节点页签有节点通过才让内核按已有结果重选(reselect)再读 now;
// 别的(单节点 / 空页签 / 多节点但没有通过的 / 没有测速地址)不读
export const laneObservation = (lane, results, url) => {
  if (!url || lane.mode === 'empty' || lane.mode === 'single') return null
  if (lane.mode === 'selector') return { subTag: lane.subTag, reselect: false }
  return okNodesOf(lane, results).length ? { subTag: lane.subTag, reselect: true } : null
}
// 多节点页签:内核选中的不在这轮通过的节点里时,还要读它的最新一次历史(看是不是更新的通过),交给 assessLane 的 latest
export const needsLatestHistory = (lane, results, kernelNow) => Boolean(kernelNow) && !okNodesOf(lane, results).includes(kernelNow)

// 页签健康:通过 = 有节点通过(多节点页签还要内核实际选中的是通过的节点);失败 = 所有有效节点都明确失败;
// 其余 = 未知。observed = laneObservation 读到的 { now, latest: { time, delay } | null }。返回要打的日志(没有就是 null)
export const assessLane = (lane, results, observed, { url, startedAt, tag }) => {
  lane.kernelNow = null
  lane.confirmed = null
  if (lane.mode === 'empty') { lane.health = 'down'; return null }
  if (!url) { lane.health = 'unknown'; return null }
  const rs = lane.valid.map((t) => results[t])
  const okNodes = okNodesOf(lane, results)
  const allFailed = rs.length > 0 && rs.every((r) => r && r.ok === false)
  if (lane.mode === 'single') {
    lane.health = okNodes.length ? 'up' : allFailed ? 'down' : 'unknown'
    return null
  }
  // 手动选择的页签(内部 selector,GitHub #188):不让内核重选,就看用户选中的那个节点这轮通没通过
  if (lane.mode === 'selector') {
    const kernelNow = observed && typeof observed.now === 'string' ? observed.now : ''
    lane.kernelNow = kernelNow || null
    const r = kernelNow ? results[kernelNow] : null
    lane.confirmed = Boolean(kernelNow)
    lane.health = r && r.ok === true ? 'up' : r && r.ok === false ? 'down' : 'unknown'
    return null
  }
  if (!okNodes.length) { lane.health = allFailed ? 'down' : 'unknown'; return null }
  const kernelNow = observed && typeof observed.now === 'string' ? observed.now : ''
  lane.kernelNow = kernelNow || null
  // 并发的手动测速等显式操作可能让节点恢复;有本轮开始之后的新鲜结果也算确认。内核(1.14.1-openbox-tcp14 起)
  // 对正在用的节点也是「不通 → 10 秒后复查」:这一轮拿到的是它的失败,内核复查通过后留着它、记了一笔更新的通过——
  // 比这一轮的失败还新的通过同样算确认,不然要一直「未确认」到这个节点的失败结果过期
  const kernelFresh = (() => {
    if (!kernelNow || okNodes.includes(kernelNow)) return false
    const h = observed && observed.latest
    const t = h ? Date.parse(h.time) : NaN
    if (!h || !Number.isFinite(t) || !(Number(h.delay) > 0)) return false
    const seen = results[kernelNow]
    return t >= startedAt - 1000 || Boolean(seen && seen.ok === false && Number.isFinite(seen.at) && t > seen.at)
  })()
  lane.confirmed = Boolean(kernelNow && (okNodes.includes(kernelNow) || kernelFresh))
  lane.health = lane.confirmed ? 'up' : 'unknown'
  return lane.confirmed ? null : `[failover] ${tag} 页签 ${laneRole(lane.index)} 有节点通过但内核实际选中的是 ${kernelNow || '(空)'},这轮算未确认`
}

const unknownAbove = (state, lane) => state.lanes.some((l) => l.health === 'unknown' && l.index < lane.index)
const settleReorder = (state, why, logs) => {
  if (!state.reorder) return
  logs.push(`[failover] ${state.tag}:按页签顺序重选已落定（${why}）`)
  state.reorder = null
}
// 当前页签就是新顺序里第一个通过的:落定(或记为已判断)。决策前和切换后各看一次,切到位就当轮落定
const settleIfDone = (state, logs) => {
  if (!state.reorder) return
  const cur = state.currentLaneId ? laneById(state, state.currentLaneId) : null
  if (!cur || cur.health !== 'up') return
  const preferred = state.lanes.find((l) => l.health === 'up') || null
  if (!preferred || preferred.id !== cur.id || unknownAbove(state, preferred)) return
  const nothingAbove = state.lanes.every((l) => l.index >= cur.index || l.mode === 'empty')
  if (nothingAbove || state.reorder.reason !== 'priority-changed') settleReorder(state, `当前已是顺序里第一个通过的页签 ${laneRole(cur.index)}`, logs)
  else state.reorder.evaluated = true
}

// 决策。parentNow = 父组此刻的 now;recheckRound = roundPlan 给的;at = 现在。返回 { decision, logs }:
// decision.target 是 { id, ref }(id null = 兜底拒绝)或 null,要不要真去切看 needsSwitch
export const decideRound = (state, { parentNow, recheckRound, at }) => {
  const logs = []
  const s = state.settings || {}
  const restorePrimary = s.restorePrimary !== false
  const holdMs = Math.max(0, Number(s.recoveryHoldMs) || 0)
  const current = laneForNow(state, parentNow)
  if (current && current.id !== state.currentLaneId) {
    state.currentLaneId = current.id
    state.currentSince = state.currentSince || at
  }
  if (!current) state.currentLaneId = null
  for (const lane of state.lanes) {
    // upSince 是「连续通过」的起点:失败和未知都打断它(未知 = 这轮没测出结果,不能算作还在连续通过;
    // 按顺序重选等 recoveryHoldMs 就靠它计时)。未知不算失败:不增加失败轮数、不触发任何切换
    if (lane.health === 'up') lane.upSince = lane.upSince || at
    else lane.upSince = null
    if (lane.health === 'down') lane.failStreak += 1
    else if (lane.health === 'up') lane.failStreak = 0
  }
  const primary = state.lanes[0] || null
  if (primary && primary.health === 'up') state.primaryUpSince = state.primaryUpSince || at
  else state.primaryUpSince = null

  const firstUp = (exceptId) => state.lanes.find((l) => l.health === 'up' && l.id !== exceptId) || null
  const anyUnknown = state.lanes.some((l) => l.health === 'unknown')
  let target = null
  let reason = ''
  // 按新顺序重选的待办(见 initFailoverState):新顺序里第一个通过的页签就是该用的;它上面还有未知的页签先不动
  // (等那些页签确认了再说)。用户刚改完顺序、第一次能判断时立刻挪,目标是主用也一样——用户把某个页签排到
  // 第一位就是要用它,不受「恢复后切回」开关和等待时间约束;之后(比如目标当时是失败的、后来才恢复)才按
  // 恢复的规则来:目标是主用走「恢复后切回」(开关 + 等待,关着回切这次重排就算落定),目标是备用和主用恢复
  // 一样等它连续通过满 recoveryHoldMs 再挪,免得刚恢复就来回切。
  // 落定:当前页签就是新顺序里第一个通过的,且它上面没有别的页签(或只有空页签);上面还有确认失败的
  // 页签时待办保留——那是用户明确表达的优先级,它恢复了要挪过去(备用之间平时不这么做)。「校正」
  // (order-unknown)不是用户的动作,当前就是第一个通过的就直接落定
  let reorderMove = false
  if (current && state.reorder) {
    const preferred = state.lanes.find((l) => l.health === 'up') || null
    if (preferred && !unknownAbove(state, preferred)) {
      if (preferred.id === current.id) {
        settleIfDone(state, logs)
      } else if (!state.reorder.evaluated && state.reorder.reason === 'priority-changed') {
        target = preferred; reason = 'priority-changed'; reorderMove = true
      } else if (preferred.index === 0) {
        if (!restorePrimary) settleReorder(state, '目标是主用而「恢复后切回」关着', logs)
        else state.reorder.evaluated = true
      } else if (!state.reorder.evaluated || (preferred.upSince !== null && at - preferred.upSince >= holdMs)) {
        target = preferred; reason = 'priority-changed'; reorderMove = true
      } else {
        state.reorder.evaluated = true
      }
    }
  }
  if (target) {
    /* 按新顺序重选已经定了目标 */
  } else if (current) {
    if (current.health === 'up') {
      if (restorePrimary && primary && current.id !== primary.id && primary.health === 'up' && state.primaryUpSince !== null && at - state.primaryUpSince >= holdMs) {
        target = primary; reason = 'restore-primary'
      }
    } else if (current.health === 'down' && recheckRound) {
      // 复查仍不通:换页签
      const next = firstUp(current.id)
      if (next) { target = next; reason = 'lane-failed' } else if (!anyUnknown && state.rejectTag) { target = { id: null, ref: state.rejectTag }; reason = 'all-failed' }
    }
  } else {
    const next = firstUp(null)
    if (next) { target = next; reason = parentNow === state.rejectTag ? 'recovered' : 'initial' } else if (!anyUnknown && state.rejectTag && parentNow !== state.rejectTag) { target = { id: null, ref: state.rejectTag }; reason = 'all-failed' }
  }
  const decision = {
    currentId: current ? current.id : null,
    target: target ? { id: target.id ?? null, ref: target.ref, index: target.index ?? null } : null,
    reason, reorderMove, recheckRound: Boolean(recheckRound),
  }
  return { decision, logs }
}

// 要不要真去切父组(PUT /proxies/<父组> { name: decision.target.ref },再读回 now 确认)
export const needsSwitch = (decision, parentNow) => Boolean(decision && decision.target && decision.target.ref && decision.target.ref !== parentNow)

// 收尾:outcome = 切换的结果 { now }(读回确认后的 now)/ { error } / null(没切)。更新状态,返回这一轮的摘要和日志。
// startedAt = 这一轮开始的时刻(roundPlan 之前取的)
export const finishRound = (state, decision, { parentNow, at, startedAt, outcome = null }) => {
  const logs = []
  const { target, reason, reorderMove } = decision
  const current = decision.currentId ? laneById(state, decision.currentId) : null
  let switched = null
  if (needsSwitch(decision, parentNow) && outcome && typeof outcome.now === 'string') {
    const from = current ? { laneId: current.id, ref: parentNow } : { laneId: null, ref: parentNow }
    state.currentLaneId = target.id
    state.currentSince = at
    state.lastSwitch = { at, from, to: { laneId: target.id, ref: outcome.now }, reason }
    state.lastError = ''
    switched = { from: from.ref, to: outcome.now, reason }
    if (reorderMove && state.reorder) state.reorder.evaluated = true
    logs.push(`[failover] ${state.tag}:${from.ref || '(空)'} → ${outcome.now}（${reason}）`)
  } else if (needsSwitch(decision, parentNow) && outcome && outcome.error) {
    // 切换失败:保留实际状态,下一轮再试(按顺序重选的待办也原样留着,不算已经判断过)
    state.lastError = `切换失败:${outcome.error}`
    logs.push(`[failover] ${state.tag} 切换到 ${target.ref} 失败:${outcome.error}`)
  } else if (target && target.id && target.ref === parentNow && target.id !== state.currentLaneId) {
    // 目标页签引用的出站和内核当前选的是同一个(两个页签都只挂同一个节点):不用切,只把关联挪过去
    state.currentLaneId = target.id
    state.currentSince = at
    if (reorderMove && state.reorder) state.reorder.evaluated = true
    logs.push(`[failover] ${state.tag}:关联改到页签 ${laneRole(target.index)},出站不变（${reason}）`)
  }
  // 当前页签不通(第一次)→ RECHECK_DELAY_MS 后复查。复查通过回到正常周期;复查仍不通就换页签,新页签从正常周期开始。
  // 没换成(候选都还未知、切换被拒)或复查本身没测出结果(未知)的,继续每 RECHECK_DELAY_MS 复查一次,不在坏页签上干等一个完整周期
  const moved = Boolean(switched) || Boolean(target && target.id && target.ref === parentNow)
  state.recheckPending = Boolean(current && !moved && (current.health === 'down' || (decision.recheckRound && current.health === 'unknown')))
  settleIfDone(state, logs)
  const cur = state.currentLaneId ? laneById(state, state.currentLaneId) : null
  const kernelSel = switched ? switched.to : parentNow
  state.kernelNow = kernelSel
  state.status = kernelSel === state.rejectTag || !cur ? 'reject'
    : cur.health === 'up' ? (cur.index === 0 ? 'ok' : 'backup')
      : cur.health === 'down' ? 'failing' : 'unknown'
  state.lastRoundAt = startedAt
  state.lastRoundResult = switched ? `${switched.reason}` : 'kept'
  // 有页签这轮没能确认内核的选择(内核刚启动、子组自己的首轮检测还没跑完):不等整个 interval,很快再看一次
  const unconfirmed = state.lanes.some((l) => l.confirmed === false)
  return { result: { switched, unconfirmed, recheck: state.recheckPending, status: state.status, lanes: state.lanes.map((l) => [l.id, l.health]) }, logs }
}

// 下一轮隔多久。result = finishRound 的摘要;skip = roundPlan 的 skip 或读内核失败('kernel')
export const roundIntervalOf = (state) => Math.max(5000, Number(state.settings?.intervalMs) || 300_000)
export const nextRoundDelay = (state, { result = null, skip = '' } = {}) => {
  const intervalMs = roundIntervalOf(state)
  if (skip) return Math.min(10_000, intervalMs)
  if (result && result.recheck) return Math.min(RECHECK_DELAY_MS, intervalMs)
  if (result && result.unconfirmed) return Math.min(10_000, intervalMs)
  return intervalMs
}
