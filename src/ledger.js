// The achievement ledger: a pure reducer over real harness events.
//
// Design rule, and the reason this plugin exists: an achievement may only be
// created by an observed event — a tool result that reported failure, a turn
// that ran long and completed, a test command that failed and was followed by a
// passing one, a successful commit followed by a successful push. There is no
// timer that "levels up" the pet, no counter that increments on a UI click, and
// no path from the demo endpoint into this state.
//
// Every achievement keeps the evidence rows that caused it: session id, tool,
// the command line, the result excerpt, timestamp, duration. That is what makes
// it checkable instead of decorative.
//
// The functions mutate the passed state and return the achievements earned by
// that single event. They never throw on malformed input; a pet must not be able
// to break the turn it observes.

export const DEFAULTS = {
  idleGapMs: 5 * 60_000,
  longTaskMs: 90_000,
  timeZone: 'Asia/Shanghai',
}

const MAX_EVIDENCE = 8
const MAX_CALLS_PER_SESSION = 40
const MAX_ACHIEVEMENTS = 200
const MAX_DEMO = 20
const MAX_SESSIONS = 32

export const FAMILIES = [
  {
    key: 'failure-streak',
    label: '工具连续失败',
    tiers: [
      { id: 'failure-streak-3', need: 3, title: '逆风三连', tier: 'bronze', desc: '连续三次工具调用失败后没有停下，继续推进' },
      { id: 'failure-streak-6', need: 6, title: '逆风六连', tier: 'silver', desc: '连续六次工具调用失败后仍然继续推进' },
      { id: 'failure-streak-10', need: 10, title: '十次不倒', tier: 'gold', desc: '连续十次工具调用失败后仍然继续推进' },
    ],
  },
  {
    key: 'long-task',
    label: '长任务完成',
    tiers: [
      { id: 'long-task-1', need: 1, title: '长跑完赛', tier: 'bronze', desc: '完成一次达到阈值时长并正常结束的真实任务' },
      { id: 'long-task-3', need: 3, title: '耐力选手', tier: 'silver', desc: '完成三次达到阈值时长的真实任务' },
      { id: 'long-task-10', need: 10, title: '马拉松常客', tier: 'gold', desc: '完成十次达到阈值时长的真实任务' },
    ],
  },
  {
    key: 'red-green',
    label: '测试由红转绿',
    tiers: [
      { id: 'red-green-1', need: 1, title: '红转绿', tier: 'bronze', desc: '同一会话里先有失败的测试，随后测试真实通过' },
      { id: 'red-green-3', need: 3, title: '修复循环', tier: 'silver', desc: '三次把失败的测试跑成通过' },
      { id: 'red-green-8', need: 8, title: '常绿', tier: 'gold', desc: '八次把失败的测试跑成通过' },
    ],
  },
  {
    key: 'commit-push',
    label: '提交并推送成功',
    tiers: [
      { id: 'commit-push-1', need: 1, title: '落地成篇', tier: 'bronze', desc: '一次真实提交之后，推送成功' },
      { id: 'commit-push-5', need: 5, title: '持续交付', tier: 'silver', desc: '五次提交并推送成功' },
      { id: 'commit-push-15', need: 15, title: '推手', tier: 'gold', desc: '十五次提交并推送成功' },
    ],
  },
]

const FAMILY_BY_KEY = {}
for (const family of FAMILIES) FAMILY_BY_KEY[family.key] = family

export function createState() {
  return {
    version: 1,
    counters: { failureStreakMax: 0, longTasks: 0, redGreen: 0, commitPush: 0 },
    earned: {},
    achievements: [],
    demo: [],
    demoSeq: 0,
    daily: {},
    quests: {},
    runtime: { sessions: {} },
  }
}

export function normalizeOptions(options) {
  const o = options && typeof options === 'object' ? options : {}
  return {
    idleGapMs: Number.isFinite(o.idleGapMs) && o.idleGapMs > 0 ? o.idleGapMs : DEFAULTS.idleGapMs,
    longTaskMs: Number.isFinite(o.longTaskMs) && o.longTaskMs >= 0 ? o.longTaskMs : DEFAULTS.longTaskMs,
    timeZone: typeof o.timeZone === 'string' && o.timeZone.length > 0 ? o.timeZone : DEFAULTS.timeZone,
  }
}

export function dayKey(at, timeZone) {
  const date = new Date(Number.isFinite(at) ? at : Date.now())
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || DEFAULTS.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const map = {}
    for (const part of parts) map[part.type] = part.value
    if (map.year && map.month && map.day) return map.year + '-' + map.month + '-' + map.day
  } catch (error) {
    // An invalid time zone falls back to UTC rather than dropping the event.
  }
  return date.toISOString().slice(0, 10)
}

export function emptyDay(day) {
  return {
    day: typeof day === 'string' ? day : '',
    activeMs: 0,
    firstAt: 0,
    lastAt: 0,
    events: 0,
    toolCalls: 0,
    failures: 0,
    testsFailed: 0,
    testsPassed: 0,
    commits: 0,
    pushes: 0,
    byType: {},
    sessions: [],
  }
}

function timeOf(event) {
  return Number.isFinite(event && event.at) ? event.at : Date.now()
}

function sessionIdOf(event) {
  const id = event && event.sessionId
  return typeof id === 'string' && id.length > 0 ? id : 'unattributed'
}

function sessionState(state, event) {
  if (state.runtime === undefined || state.runtime === null || typeof state.runtime !== 'object') {
    state.runtime = { sessions: {} }
  }
  if (state.runtime.sessions === undefined || state.runtime.sessions === null) state.runtime.sessions = {}
  const id = sessionIdOf(event)
  let session = state.runtime.sessions[id]
  if (session === undefined) {
    const ids = Object.keys(state.runtime.sessions)
    if (ids.length >= MAX_SESSIONS) delete state.runtime.sessions[ids[0]]
    session = {
      id: id,
      label: '',
      streak: 0,
      calls: [],
      pending: {},
      turnStartedAt: null,
      turnCallIndex: 0,
      lastTurnReason: null,
      lastTestFailure: null,
      lastCommit: null,
    }
    state.runtime.sessions[id] = session
  }
  const label = event && event.label
  if (typeof label === 'string' && label.length > 0) session.label = label
  return session
}

function touchDay(state, at, options) {
  if (!Number.isFinite(at)) return emptyDay('')
  const key = dayKey(at, options.timeZone)
  let day = state.daily[key]
  if (day === undefined) {
    day = emptyDay(key)
    day.firstAt = at
    day.lastAt = at
    state.daily[key] = day
  }
  const delta = at - day.lastAt
  // Count at most one idle gap per gap: a 40-minute break must not become 40
  // minutes of "usage", but a single long tool call still counts as focus time.
  if (delta > 0) day.activeMs += Math.min(delta, options.idleGapMs)
  if (day.firstAt === 0 || at < day.firstAt) day.firstAt = at
  if (at > day.lastAt) day.lastAt = at
  day.events += 1
  return day
}

function noteSession(day, sessionId) {
  if (day.sessions.indexOf(sessionId) < 0) {
    day.sessions.push(sessionId)
    if (day.sessions.length > 50) day.sessions.splice(0, day.sessions.length - 50)
  }
}

function callView(call) {
  return {
    callId: String(call.callId === undefined || call.callId === null ? '' : call.callId),
    at: call.at,
    tool: String(call.tool === undefined || call.tool === null ? '' : call.tool),
    kind: String(call.kind || 'other'),
    line: String(call.line || ''),
    command: String(call.command || ''),
    result: String(call.result || ''),
    ok: call.ok === true,
    ms: Number.isFinite(call.ms) ? call.ms : 0,
    sessionId: String(call.sessionId || ''),
  }
}

function cloneEvidence(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.slice(0, MAX_EVIDENCE).map(callView)
}

function award(state, familyKey, need, context) {
  const family = FAMILY_BY_KEY[familyKey]
  if (family === undefined) return null
  const tier = family.tiers.find(function (entry) { return entry.need === need })
  if (tier === undefined || state.earned[tier.id] === true) return null
  state.earned[tier.id] = true
  const record = {
    id: tier.id,
    family: family.key,
    familyLabel: family.label,
    tier: tier.tier,
    title: tier.title,
    desc: tier.desc,
    at: context.at,
    sessionId: context.sessionId,
    sessionLabel: context.sessionLabel || '',
    source: 'real',
    demo: false,
    watermark: '',
    evidence: cloneEvidence(context.evidence),
    detail: context.detail === undefined ? null : context.detail,
  }
  state.achievements.unshift(record)
  if (state.achievements.length > MAX_ACHIEVEMENTS) state.achievements.length = MAX_ACHIEVEMENTS
  return record
}

function awardReached(state, familyKey, count, context) {
  const family = FAMILY_BY_KEY[familyKey]
  const earned = []
  if (family === undefined) return earned
  for (const tier of family.tiers) {
    if (count >= tier.need) {
      const record = award(state, familyKey, tier.need, context)
      if (record !== null) earned.push(record)
    }
  }
  return earned
}

function tailFailures(calls, max) {
  const list = []
  for (let index = calls.length - 1; index >= 0 && list.length < max; index -= 1) {
    if (calls[index].ok === true) break
    list.unshift(calls[index])
  }
  return list
}

function excerpt(text, max) {
  const flat = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + ' …' : flat
}

/**
 * Record a tool call that is about to run. This only opens the call; nothing is
 * earned until a real result arrives.
 */
export function ingestToolStart(state, event, options) {
  const opts = normalizeOptions(options)
  const at = timeOf(event)
  const session = sessionState(state, event)
  touchDay(state, at, opts)
  const callId = String(event && event.callId !== undefined && event.callId !== null ? event.callId : '')
  const tool = String(event && event.tool !== undefined && event.tool !== null ? event.tool : '')
  const args = event && event.args
  const info = event && event.info && typeof event.info === 'object'
    ? event.info
    : { kind: 'other', command: '' }
  session.pending[callId] = { at: at, tool: tool, args: args, kind: info.kind, command: info.command }
  // Fallback turn boundary: if the harness did not report `running` to us (for
  // example the plugin loaded mid-turn), the first tool call starts the clock.
  if (session.turnStartedAt === null) {
    session.turnStartedAt = at
    session.turnCallIndex = session.calls.length
  }
  return []
}

/**
 * Record a settled tool result and every achievement it legitimately triggers.
 *
 * @param {object} state
 * @param {{callId?:string, tool?:string, args?:unknown, sessionId?:string, label?:string,
 *          at?:number, isError?:boolean, result?:string, ms?:number,
 *          kind?:string, command?:string, line?:string}} event
 * @param {object} [options]
 */
export function ingestToolResult(state, event, options) {
  const opts = normalizeOptions(options)
  const at = timeOf(event)
  const session = sessionState(state, event)
  const day = touchDay(state, at, opts)
  noteSession(day, session.id)

  const callId = String(event && event.callId !== undefined && event.callId !== null ? event.callId : '')
  const pending = session.pending[callId]
  delete session.pending[callId]

  const tool = String(
    event && event.tool !== undefined && event.tool !== null
      ? event.tool
      : (pending === undefined ? '' : pending.tool),
  )
  const kind = String(
    event && typeof event.kind === 'string' && event.kind.length > 0
      ? event.kind
      : (pending === undefined ? 'other' : pending.kind),
  )
  const command = String(
    event && typeof event.command === 'string'
      ? event.command
      : (pending === undefined ? '' : pending.command),
  )
  const line = String(
    event && typeof event.line === 'string' && event.line.length > 0
      ? event.line
      : tool,
  )
  const isError = event !== undefined && event !== null && event.isError === true
  const started = pending === undefined ? null : pending.at
  const ms = Number.isFinite(event && event.ms)
    ? event.ms
    : (started === null ? 0 : Math.max(0, at - started))

  const call = callView({
    callId: callId,
    at: at,
    tool: tool,
    kind: kind,
    line: line,
    command: command,
    result: excerpt(event && event.result, 420),
    ok: !isError,
    ms: ms,
    sessionId: session.id,
  })
  session.calls.push(call)
  if (session.calls.length > MAX_CALLS_PER_SESSION) {
    session.calls.splice(0, session.calls.length - MAX_CALLS_PER_SESSION)
  }

  day.toolCalls += 1
  day.byType[kind] = (day.byType[kind] || 0) + 1
  if (isError) day.failures += 1

  const earned = []
  const context = {
    at: at,
    sessionId: session.id,
    sessionLabel: session.label,
  }

  // 1. Consecutive failures. A success resets the streak, so this cannot be
  // farmed by failing unrelated calls across a long healthy session.
  if (isError) {
    session.streak += 1
    if (session.streak > state.counters.failureStreakMax) state.counters.failureStreakMax = session.streak
    const failures = tailFailures(session.calls, 10)
    for (const tier of FAMILY_BY_KEY['failure-streak'].tiers) {
      if (session.streak >= tier.need && state.earned[tier.id] !== true) {
        const record = award(state, 'failure-streak', tier.need, {
          at: at,
          sessionId: session.id,
          sessionLabel: session.label,
          evidence: failures.slice(-tier.need),
          detail: { streak: session.streak },
        })
        if (record !== null) earned.push(record)
      }
    }
  } else {
    session.streak = 0
  }

  // 2. Red → green. The failure and the pass must be in the same session, and
  // the pass must be a test command, not merely a successful command.
  if (kind === 'test') {
    if (isError) {
      day.testsFailed += 1
      session.lastTestFailure = call
    } else {
      day.testsPassed += 1
      if (session.lastTestFailure !== null) {
        state.counters.redGreen += 1
        const evidence = [session.lastTestFailure, call]
        session.lastTestFailure = null
        earned.push.apply(earned, awardReached(state, 'red-green', state.counters.redGreen, {
          at: at,
          sessionId: session.id,
          sessionLabel: session.label,
          evidence: evidence,
          detail: { count: state.counters.redGreen },
        }))
      }
    }
  }

  // 3. Commit then push. A failed commit clears the marker; a failed push keeps
  // it, because retrying the same push is still the same delivery.
  if (kind === 'commit') {
    if (isError) {
      session.lastCommit = null
    } else {
      day.commits += 1
      session.lastCommit = call
    }
  }
  if (kind === 'push' && !isError) {
    day.pushes += 1
    if (session.lastCommit !== null) {
      state.counters.commitPush += 1
      const evidence = [session.lastCommit, call]
      session.lastCommit = null
      earned.push.apply(earned, awardReached(state, 'commit-push', state.counters.commitPush, {
        at: at,
        sessionId: session.id,
        sessionLabel: session.label,
        evidence: evidence,
        detail: { count: state.counters.commitPush },
      }))
    }
  }

  return earned
}

/**
 * Agent status only opens and closes a turn. A long turn is an achievement only
 * when it *completed*; an aborted turn earns nothing.
 */
export function ingestAgentStatus(state, event, options) {
  const opts = normalizeOptions(options)
  const at = timeOf(event)
  const session = sessionState(state, event)
  const status = event && event.status
  if (status === 'running') {
    touchDay(state, at, opts)
    session.turnStartedAt = at
    session.turnCallIndex = session.calls.length
    session.lastTurnReason = null
    return []
  }
  if (status !== 'idle') return []
  const day = touchDay(state, at, opts)
  noteSession(day, session.id)
  if (session.turnStartedAt === null) return []
  const duration = Math.max(0, at - session.turnStartedAt)
  session.turnStartedAt = null
  const reason = session.lastTurnReason
  session.lastTurnReason = null
  if (reason !== null && reason !== 'completed') return []
  if (duration < opts.longTaskMs) return []

  state.counters.longTasks += 1
  const turnCalls = session.calls.slice(session.turnCallIndex)
  return awardReached(state, 'long-task', state.counters.longTasks, {
    at: at,
    sessionId: session.id,
    sessionLabel: session.label,
    evidence: turnCalls.slice(-MAX_EVIDENCE),
    detail: { durationMs: duration, thresholdMs: opts.longTaskMs },
  })
}

/** Remember why a turn ended before the status flips to idle. */
export function ingestTurnEnd(state, event) {
  const session = sessionState(state, event)
  session.lastTurnReason = String(event && event.reason ? event.reason : 'unknown')
  return []
}

export function ingestSessionCreated(state, event) {
  const session = sessionState(state, event)
  const label = event && event.label
  if (typeof label === 'string' && label.length > 0) session.label = label
  return []
}

export function ingestAgentDisposed(state, event) {
  if (state.runtime === undefined || state.runtime.sessions === undefined) return []
  const id = sessionIdOf(event)
  delete state.runtime.sessions[id]
  return []
}

/**
 * Demo records. They exist only to show the card layout and the watermark; they
 * are kept in a separate array, never touch `earned` / counters / daily stats,
 * and every one carries `source: 'demo'` plus the visible watermark.
 */
export function createDemo(state, now) {
  const at = Number.isFinite(now) ? now : Date.now()
  const added = []
  for (const family of FAMILIES) {
    state.demoSeq += 1
    const first = family.tiers[0]
    added.push({
      id: 'demo-' + family.key + '-' + state.demoSeq,
      family: family.key,
      familyLabel: family.label,
      tier: first.tier,
      title: '演示 · ' + first.title,
      desc: '演示样张：这条成就不是任何真实会话挣来的，只用于预览卡片与水印。',
      at: at,
      sessionId: 'demo-session',
      sessionLabel: '演示态（非真实会话）',
      source: 'demo',
      demo: true,
      watermark: '演示',
      evidence: [
        {
          callId: 'demo-call-1',
          at: at,
          tool: 'demo',
          kind: 'other',
          line: '演示数据：不来自任何真实会话',
          command: '',
          result: '模拟记录，只存在于演示态，不计入成就数',
          ok: false,
          ms: 0,
          sessionId: 'demo-session',
        },
      ],
      detail: { demo: true },
    })
  }
  state.demo.unshift.apply(state.demo, added)
  if (state.demo.length > MAX_DEMO) state.demo.length = MAX_DEMO
  return added
}

export function clearDemo(state) {
  const count = state.demo.length
  state.demo.length = 0
  return count
}

function cloneAchievement(record) {
  return {
    id: record.id,
    family: record.family,
    familyLabel: record.familyLabel,
    tier: record.tier,
    title: record.title,
    desc: record.desc,
    at: record.at,
    sessionId: record.sessionId,
    sessionLabel: record.sessionLabel,
    source: record.source,
    demo: record.demo === true,
    watermark: record.watermark || '',
    evidence: cloneEvidence(record.evidence),
    detail: record.detail,
  }
}

export function snapshot(state, options) {
  const opts = normalizeOptions(options)
  const now = options !== undefined && options !== null && Number.isFinite(options.now) ? options.now : Date.now()
  const key = dayKey(now, opts.timeZone)
  const day = state.daily[key] || emptyDay(key)
  const achievements = state.achievements.slice(0, 80).map(cloneAchievement)
  const demo = state.demo.slice(0, MAX_DEMO).map(cloneAchievement)
  let evidenceRows = 0
  for (const record of state.achievements) evidenceRows += record.evidence.length
  return {
    version: state.version,
    now: now,
    day: key,
    stats: {
      real: state.achievements.length,
      demo: state.demo.length,
      evidenceRows: evidenceRows,
      events: day.events,
      toolCalls: day.toolCalls,
      failures: day.failures,
      awards: state.achievements.length,
    },
    counters: {
      failureStreakMax: state.counters.failureStreakMax,
      longTasks: state.counters.longTasks,
      redGreen: state.counters.redGreen,
      commitPush: state.counters.commitPush,
    },
    achievements: achievements,
    demo: demo,
    daily: {
      day: day.day,
      activeMs: day.activeMs,
      firstAt: day.firstAt,
      lastAt: day.lastAt,
      events: day.events,
      toolCalls: day.toolCalls,
      failures: day.failures,
      testsFailed: day.testsFailed,
      testsPassed: day.testsPassed,
      commits: day.commits,
      pushes: day.pushes,
      byType: Object.assign({}, day.byType),
      sessions: day.sessions.slice(),
    },
    families: FAMILIES.map(function (family) {
      return {
        key: family.key,
        label: family.label,
        tiers: family.tiers.map(function (tier) {
          return { id: tier.id, need: tier.need, title: tier.title, tier: tier.tier, desc: tier.desc }
        }),
      }
    }),
    config: {
      longTaskMs: opts.longTaskMs,
      idleGapMs: opts.idleGapMs,
      timeZone: opts.timeZone,
    },
  }
}

/** Keep the durable file small: only the newest N day buckets survive. */
export function pruneDays(state, keep) {
  const limit = Number.isFinite(keep) && keep > 0 ? keep : 7
  for (const bucket of ['daily', 'quests']) {
    const map = state[bucket]
    if (map === undefined || map === null || typeof map !== 'object') continue
    const keys = Object.keys(map).sort().reverse()
    for (const key of keys.slice(limit)) delete map[key]
  }
}

/** Exposed for tests and for the host's persistence layer. */
export const internals = {
  MAX_EVIDENCE: MAX_EVIDENCE,
  MAX_CALLS_PER_SESSION: MAX_CALLS_PER_SESSION,
  tailFailures: tailFailures,
  awardReached: awardReached,
  FAMILY_BY_KEY: FAMILY_BY_KEY,
}
