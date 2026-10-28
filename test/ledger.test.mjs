import { strict as assert } from 'node:assert'
import test from 'node:test'
import { classifyTool, describeCall } from '../src/commands.js'
import {
  clearDemo,
  createDemo,
  createState,
  createState as makeState,
  dayKey,
  emptyDay,
  ingestAgentDisposed,
  ingestAgentStatus,
  ingestSessionCreated,
  ingestToolResult,
  ingestToolStart,
  ingestTurnEnd,
  normalizeOptions,
  pruneDays,
  snapshot,
} from '../src/ledger.js'

const OPTIONS = { timeZone: 'UTC', idleGapMs: 5 * 60_000, longTaskMs: 60_000 }
const T0 = Date.UTC(2026, 9, 28, 8, 0, 0)

function call(state, spec) {
  const tool = spec.tool || 'pwsh'
  const args = spec.args === undefined ? { command: spec.command || 'echo hi' } : spec.args
  const info = classifyTool(tool, args)
  const at = spec.at === undefined ? T0 : spec.at
  const session = spec.session || 'session-1'
  const label = spec.label === undefined ? 'D:/Projects/demo' : spec.label
  const callId = spec.callId || ('c-' + Math.random().toString(36).slice(2))
  ingestToolStart(state, {
    callId: callId,
    tool: tool,
    args: args,
    info: info,
    sessionId: session,
    label: label,
    at: at,
  }, OPTIONS)
  return ingestToolResult(state, {
    callId: callId,
    tool: tool,
    args: args,
    kind: info.kind,
    command: info.command,
    line: describeCall(tool, args),
    sessionId: session,
    label: label,
    at: at + (spec.ms === undefined ? 30 : spec.ms),
    isError: spec.isError === true,
    result: spec.result === undefined ? 'ok' : spec.result,
    ms: spec.ms === undefined ? 30 : spec.ms,
  }, OPTIONS)
}

test('three consecutive failures earn one achievement with all three evidence rows', () => {
  const state = createState()
  assert.equal(call(state, { command: 'node -e "process.exit(1)"', isError: true, result: 'exit 1' }).length, 0)
  assert.equal(call(state, { command: 'node -e "process.exit(1)"', isError: true, result: 'exit 1' }).length, 0)
  const earned = call(state, { command: 'node -e "process.exit(1)"', isError: true, result: 'exit 1' })
  assert.equal(earned.length, 1)
  const record = earned[0]
  assert.equal(record.id, 'failure-streak-3')
  assert.equal(record.family, 'failure-streak')
  assert.equal(record.source, 'real')
  assert.equal(record.demo, false)
  assert.equal(record.sessionId, 'session-1')
  assert.equal(record.sessionLabel, 'D:/Projects/demo')
  assert.equal(record.evidence.length, 3)
  for (const row of record.evidence) {
    assert.equal(row.ok, false)
    assert.match(row.line, /process\.exit\(1\)/)
    assert.equal(row.sessionId, 'session-1')
  }
  assert.equal(state.counters.failureStreakMax, 3)
  assert.equal(state.achievements.length, 1)
})

test('a success resets the failure streak, and an earned tier is never awarded twice', () => {
  const state = createState()
  call(state, { isError: true })
  call(state, { isError: true })
  call(state, { isError: false })
  call(state, { isError: true })
  call(state, { isError: true })
  assert.equal(call(state, { isError: true }).length, 1)
  assert.equal(state.counters.failureStreakMax, 3)
  assert.equal(call(state, { isError: true }).length, 0, 'tier already earned')
  assert.equal(state.achievements.length, 1)
  assert.equal(state.counters.failureStreakMax, 4)
})

test('six and ten failure streaks earn the higher tiers, including the lower tiers they crossed', () => {
  const six = createState()
  for (let index = 0; index < 6; index += 1) call(six, { isError: true })
  assert.deepEqual(six.achievements.map(function (record) { return record.id }).sort(), ['failure-streak-3', 'failure-streak-6'])

  const ten = createState()
  for (let index = 0; index < 10; index += 1) call(ten, { isError: true })
  assert.equal(ten.achievements.length, 3)
  assert.equal(ten.achievements[0].id, 'failure-streak-10')
  assert.equal(ten.achievements[0].evidence.length, 8, 'evidence is capped, not unbounded')
})

test('a long completed turn earns once, with the calls made during that turn as evidence', () => {
  const state = createState()
  ingestAgentStatus(state, { status: 'running', sessionId: 's1', at: T0 }, OPTIONS)
  call(state, { at: T0 + 1000, session: 's1', command: 'npm run build', ms: 2000 })
  call(state, { at: T0 + 5000, session: 's1', command: 'node --test', isError: true, ms: 800 })
  const beforeEnd = call(state, { at: T0 + 9000, session: 's1', command: 'needs more work' })
  assert.equal(beforeEnd.length, 0)
  ingestTurnEnd(state, { sessionId: 's1', reason: 'completed' })
  const earned = ingestAgentStatus(state, { status: 'idle', sessionId: 's1', at: T0 + 90_000 }, OPTIONS)
  assert.equal(earned.length, 1)
  const record = earned[0]
  assert.equal(record.id, 'long-task-1')
  assert.equal(record.detail.durationMs, 90_000)
  assert.equal(record.detail.thresholdMs, 60_000)
  assert.equal(record.evidence.length, 3, 'all calls since the turn opened')
  assert.match(record.evidence[0].line, /npm run build/)
})

test('an aborted turn earns nothing, and a short turn earns nothing', () => {
  const aborted = createState()
  ingestAgentStatus(aborted, { status: 'running', sessionId: 's1', at: T0 }, OPTIONS)
  call(aborted, { at: T0 + 1000 })
  ingestTurnEnd(aborted, { sessionId: 's1', reason: 'aborted' })
  assert.equal(ingestAgentStatus(aborted, { status: 'idle', sessionId: 's1', at: T0 + 120_000 }, OPTIONS).length, 0)
  assert.equal(aborted.achievements.length, 0)
  assert.equal(aborted.counters.longTasks, 0)

  const short = createState()
  ingestAgentStatus(short, { status: 'running', sessionId: 's1', at: T0 }, OPTIONS)
  ingestTurnEnd(short, { sessionId: 's1', reason: 'completed' })
  assert.equal(ingestAgentStatus(short, { status: 'idle', sessionId: 's1', at: T0 + 59_999 }, OPTIONS).length, 0)
})

test('a turn that never reported a reason still counts if it ran long', () => {
  const state = createState()
  ingestAgentStatus(state, { status: 'running', sessionId: 's1', at: T0 }, OPTIONS)
  const earned = ingestAgentStatus(state, { status: 'idle', sessionId: 's1', at: T0 + 61_000 }, OPTIONS)
  assert.equal(earned.length, 1)
})

test('red to green requires a failed test followed by a passing test in the same session', () => {
  const state = createState()
  assert.equal(call(state, { command: 'node --test', isError: true, at: T0 }).length, 0)
  const earned = call(state, { command: 'node --test', isError: false, at: T0 + 1000 })
  assert.equal(earned.length, 1)
  assert.equal(earned[0].id, 'red-green-1')
  assert.equal(earned[0].evidence.length, 2)
  assert.equal(earned[0].evidence[0].ok, false)
  assert.equal(earned[0].evidence[1].ok, true)
  assert.equal(state.counters.redGreen, 1)

  const afterSuccess = createState()
  call(afterSuccess, { command: 'node --test', isError: true })
  assert.equal(call(afterSuccess, { command: 'git status', isError: false }).length, 0, 'a non-test success is not a green test')

  const otherSession = createState()
  call(otherSession, { command: 'node --test', isError: true, session: 'a' })
  assert.equal(call(otherSession, { command: 'node --test', isError: false, session: 'b' }).length, 0)
})

test('red-to-green counters drive the 3 and 8 tiers', () => {
  const state = createState()
  for (let index = 0; index < 3; index += 1) {
    call(state, { command: 'npm test', isError: true, at: T0 + index * 10_000 })
    call(state, { command: 'npm test', isError: false, at: T0 + index * 10_000 + 1000 })
  }
  assert.equal(state.counters.redGreen, 3)
  assert.deepEqual(state.achievements.map(function (record) { return record.id }).sort(), ['red-green-1', 'red-green-3'])
})

test('a commit followed by a successful push earns, with both lines as evidence', () => {
  const state = createState()
  call(state, { command: 'git commit -m "feat: ledger"', at: T0 })
  const earned = call(state, { command: 'git push origin main', at: T0 + 2000 })
  assert.equal(earned.length, 1)
  assert.equal(earned[0].id, 'commit-push-1')
  assert.equal(earned[0].evidence.length, 2)
  assert.match(earned[0].evidence[0].line, /git commit/)
  assert.match(earned[0].evidence[1].line, /git push/)
})

test('pushes without a commit, and pushes after a failed commit, do not earn', () => {
  const noCommit = createState()
  assert.equal(call(noCommit, { command: 'git push origin main' }).length, 0)

  const failedCommit = createState()
  call(failedCommit, { command: 'git commit -m "wip"', isError: true })
  assert.equal(call(failedCommit, { command: 'git push origin main' }).length, 0)
})

test('a failed push keeps the commit, so a retry is still the same delivery', () => {
  const state = createState()
  call(state, { command: 'git commit -m "feat: ship"' })
  assert.equal(call(state, { command: 'git push origin main', isError: true }).length, 0)
  const earned = call(state, { command: 'git push origin main' })
  assert.equal(earned.length, 1)
})

test('five commit+push pairs earn the second tier', () => {
  const state = createState()
  for (let index = 0; index < 5; index += 1) {
    call(state, { command: 'git commit -m "c' + index + '"', at: T0 + index * 5000 })
    call(state, { command: 'git push', at: T0 + index * 5000 + 1000 })
  }
  assert.equal(state.counters.commitPush, 5)
  assert.deepEqual(state.achievements.map(function (record) { return record.id }).sort(), ['commit-push-1', 'commit-push-5'])
})

test('demo records are watermarked, separate, and never touch the real ledger', () => {
  const state = createState()
  call(state, { isError: true })
  const before = JSON.stringify({
    achievements: state.achievements,
    counters: state.counters,
    earned: state.earned,
    daily: state.daily,
  })
  const added = createDemo(state, T0)
  assert.equal(added.length, 4)
  assert.equal(state.demo.length, 4)
  for (const record of state.demo) {
    assert.equal(record.source, 'demo')
    assert.equal(record.demo, true)
    assert.equal(record.watermark, '演示')
    assert.equal(record.sessionId, 'demo-session')
    assert.ok(record.title.indexOf('演示') >= 0)
    for (const row of record.evidence) assert.match(row.line, /演示/)
  }
  assert.equal(JSON.stringify({
    achievements: state.achievements,
    counters: state.counters,
    earned: state.earned,
    daily: state.daily,
  }), before)
  assert.equal(clearDemo(state), 4)
  assert.equal(state.demo.length, 0)
})

test('the daily aggregate counts active time with a capped idle gap', () => {
  const state = createState()
  ingestToolStart(state, { callId: 'a', tool: 'read', args: { file_path: 'a' }, info: { kind: 'read' }, sessionId: 's', at: T0 }, OPTIONS)
  ingestToolStart(state, { callId: 'b', tool: 'read', args: { file_path: 'b' }, info: { kind: 'read' }, sessionId: 's', at: T0 + 60_000 }, OPTIONS)
  ingestToolStart(state, { callId: 'c', tool: 'read', args: { file_path: 'c' }, info: { kind: 'read' }, sessionId: 's', at: T0 + 10 * 60_000 }, OPTIONS)
  const day = state.daily[dayKey(T0, 'UTC')]
  assert.ok(day !== undefined)
  assert.equal(day.activeMs, 60_000 + 5 * 60_000, 'a 9-minute gap contributes at most one idle gap')
  assert.equal(day.events, 3)
})

test('the same instant in another time zone lands on the right local day', () => {
  const instant = Date.UTC(2026, 9, 28, 17, 30, 0)
  assert.equal(dayKey(instant, 'UTC'), '2026-10-28')
  assert.equal(dayKey(instant, 'Asia/Shanghai'), '2026-10-29')
  assert.match(dayKey(instant, 'Not/AZone'), /^\d{4}-\d{2}-\d{2}$/)
})

test('a tool result without a pending start is still recorded honestly', () => {
  const state = createState()
  const earned = ingestToolResult(state, {
    callId: 'orphan',
    tool: 'pwsh',
    args: { command: 'git commit -m "x"' },
    kind: 'commit',
    command: 'git commit -m "x"',
    line: 'git commit -m "x"',
    sessionId: 's1',
    at: T0,
    isError: false,
    result: 'committed',
  }, OPTIONS)
  assert.equal(earned.length, 0)
  const day = state.daily[dayKey(T0, 'UTC')]
  assert.equal(day.toolCalls, 1)
  assert.equal(day.commits, 1)
  assert.equal(day.byType.commit, 1)
})

test('session creation labels, disposal and malformed events never throw', () => {
  const state = createState()
  ingestSessionCreated(state, { sessionId: 's1', label: 'D:/repo' })
  call(state, { session: 's1' })
  ingestAgentDisposed(state, { sessionId: 's1' })
  // The host guards every call; the reducer itself is only required not to throw
  // on objects with missing fields.
  ingestToolStart(state, {}, OPTIONS)
  ingestToolResult(state, {}, OPTIONS)
  ingestAgentStatus(state, {}, OPTIONS)
  ingestTurnEnd(state, {})
})

test('snapshot is a copy with the day, config, families and stats the panel needs', () => {
  const state = createState()
  call(state, { isError: true })
  call(state, { isError: true })
  call(state, { isError: true })
  const data = snapshot(state, { now: T0 + 1000, timeZone: 'UTC', longTaskMs: 60_000, idleGapMs: 300_000 })
  assert.equal(data.day, '2026-10-28')
  assert.equal(data.stats.real, 1)
  assert.equal(data.stats.demo, 0)
  assert.equal(data.families.length, 4)
  assert.equal(data.families[0].key, 'failure-streak')
  assert.equal(data.config.longTaskMs, 60_000)
  assert.equal(data.daily.toolCalls, 3)
  assert.equal(data.runtime, undefined, 'runtime state is private')
  data.achievements[0].title = 'mutated'
  assert.notEqual(state.achievements[0].title, 'mutated')
})

test('pruneDays keeps only the newest day buckets', () => {
  const state = createState()
  for (let index = 0; index < 10; index += 1) {
    const at = T0 + index * 86_400_000
    const key = dayKey(at, 'UTC')
    state.daily[key] = emptyDay(key)
    state.quests[key] = { day: key, items: [] }
  }
  pruneDays(state, 7)
  assert.equal(Object.keys(state.daily).length, 7)
  assert.equal(Object.keys(state.quests).length, 7)
})

test('normalizeOptions refuses nonsense instead of producing NaN timing', () => {
  const options = normalizeOptions({ longTaskMs: -1, idleGapMs: 0, timeZone: 42 })
  assert.equal(options.longTaskMs, 90_000)
  assert.equal(options.idleGapMs, 300_000)
  assert.equal(options.timeZone, 'Asia/Shanghai')
  assert.equal(normalizeOptions({ longTaskMs: 0 }).longTaskMs, 0)
  assert.equal(makeState().version, 1)
})
