import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { classifyTool, describeCall } from '../src/commands.js'
import {
  createDemo,
  createState,
  ingestToolResult,
  ingestToolStart,
} from '../src/ledger.js'
import { ensureQuests } from '../src/quests.js'
import { loadState, saveState } from '../src/store.js'

const OPTIONS = { timeZone: 'UTC', idleGapMs: 300_000, longTaskMs: 60_000 }
const T0 = Date.UTC(2026, 9, 28, 8, 0, 0)

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'pet-ledger-test-'))
}

function call(state, spec) {
  const tool = 'pwsh'
  const args = { command: spec.command }
  const info = classifyTool(tool, args)
  const callId = spec.callId
  ingestToolStart(state, {
    callId: callId,
    tool: tool,
    args: args,
    info: info,
    sessionId: 's1',
    label: 'D:/repo',
    at: spec.at,
  }, OPTIONS)
  return ingestToolResult(state, {
    callId: callId,
    tool: tool,
    args: args,
    kind: info.kind,
    command: info.command,
    line: describeCall(tool, args),
    sessionId: 's1',
    label: 'D:/repo',
    at: spec.at + 100,
    isError: spec.isError === true,
    result: spec.result || 'ok',
    ms: 100,
  }, OPTIONS)
}

test('a ledger round-trips through the store with its evidence intact', () => {
  const home = makeHome()
  const file = join(home, 'nested', 'pet-ledger.json')
  const state = createState()
  call(state, { callId: 'c1', command: 'git commit -m "feat"', at: T0 })
  call(state, { callId: 'c2', command: 'git push', at: T0 + 1000 })
  ensureQuests({
    day: '2026-10-28',
    activeMs: 120_000,
    toolCalls: 2,
    byType: { commit: 1, push: 1 },
  }, state.quests, {})

  const saved = saveState(file, state)
  assert.equal(saved.ok, true)

  const loaded = loadState(file)
  assert.equal(loaded.error, '')
  assert.equal(loaded.state.achievements.length, 1)
  const record = loaded.state.achievements[0]
  assert.equal(record.id, 'commit-push-1')
  assert.equal(record.source, 'real')
  assert.equal(record.evidence.length, 2)
  assert.match(record.evidence[0].line, /git commit/)
  assert.equal(record.sessionLabel, 'D:/repo')
  assert.equal(loaded.state.counters.commitPush, 1)
  assert.equal(loaded.state.daily['2026-10-28'].commits, 1)
  assert.equal(Object.keys(loaded.state.quests).length, 1)
})

test('demo records are never written to disk', () => {
  const home = makeHome()
  const file = join(home, 'pet-ledger.json')
  const state = createState()
  createDemo(state, T0)
  assert.equal(state.demo.length, 4)
  assert.equal(saveState(file, state).ok, true)
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.indexOf('demo-session'), -1)
  assert.equal(raw.indexOf('演示'), -1)
  assert.equal(loadState(file).state.demo.length, 0)
})

test('a corrupt ledger is ignored with a reported error rather than crashing the host', () => {
  const home = makeHome()
  const file = join(home, 'pet-ledger.json')
  writeFileSync(file, '{ this is not json', 'utf8')
  const loaded = loadState(file)
  assert.equal(loaded.state.achievements.length, 0)
  assert.match(loaded.error, /unreadable ledger/)
})

test('a non-object JSON document is also rejected', () => {
  const home = makeHome()
  const file = join(home, 'pet-ledger.json')
  writeFileSync(file, '[1,2,3]', 'utf8')
  const loaded = loadState(file)
  assert.match(loaded.error, /unreadable ledger/)
})

test('persisted achievements are real only, and malformed rows are dropped', () => {
  const home = makeHome()
  const file = join(home, 'pet-ledger.json')
  const payload = {
    version: 1,
    counters: { failureStreakMax: 3, longTasks: 0, redGreen: 0, commitPush: 0 },
    earned: { 'failure-streak-3': true, bogus: 'yes' },
    achievements: [
      {
        id: 'failure-streak-3',
        family: 'failure-streak',
        familyLabel: '工具连续失败',
        tier: 'bronze',
        title: '逆风三连',
        desc: 'x',
        at: T0,
        sessionId: 's1',
        source: 'real',
        demo: false,
        evidence: [],
        detail: null,
      },
      { id: 'demo-thing', source: 'demo', demo: true, title: 'fake', family: 'x', at: T0 },
      { id: 'broken', source: 'real' },
      { id: 42, source: 'real', title: 'x', family: 'y', at: T0 },
    ],
    daily: {},
    quests: {},
  }
  writeFileSync(file, JSON.stringify(payload), 'utf8')
  const loaded = loadState(file)
  assert.deepEqual(loaded.state.achievements.map(function (record) { return record.id }), ['failure-streak-3'])
  assert.equal(loaded.state.earned['failure-streak-3'], true)
  assert.equal(loaded.state.earned.bogus, undefined)
})

test('the durable file keeps only the newest seven day buckets', () => {
  const home = makeHome()
  const file = join(home, 'pet-ledger.json')
  const state = createState()
  for (let index = 0; index < 10; index += 1) {
    const key = '2026-10-' + String(10 + index).padStart(2, '0')
    state.daily[key] = {
      day: key, activeMs: 1000, firstAt: T0, lastAt: T0, events: 1, toolCalls: 1,
      failures: 0, testsFailed: 0, testsPassed: 0, commits: 0, pushes: 0, byType: {}, sessions: [],
    }
    state.quests[key] = { day: key, items: [] }
  }
  assert.equal(saveState(file, state).ok, true)
  const loaded = loadState(file)
  assert.equal(Object.keys(loaded.state.daily).length, 7)
  assert.equal(Object.keys(loaded.state.quests).length, 7)
})

test('missing files and missing paths are not errors that stop the pet', () => {
  const home = makeHome()
  const loaded = loadState(join(home, 'nope.json'))
  assert.equal(loaded.error, '')
  assert.equal(loaded.state.achievements.length, 0)
  const noPath = loadState('')
  assert.match(noPath.error, /no data path/)
  assert.equal(saveState('', createState()).ok, false)
})

test('a day bucket is normalised instead of trusted', () => {
  const home = makeHome()
  const file = join(home, 'pet-ledger.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    achievements: [],
    daily: {
      '2026-10-28': {
        day: '2026-10-28',
        activeMs: -5,
        toolCalls: 'many',
        byType: { test: 2, bad: -1, other: 'x' },
        sessions: ['s1', 's1', 42],
      },
    },
    quests: {},
  }), 'utf8')
  const loaded = loadState(file)
  const day = loaded.state.daily['2026-10-28']
  assert.equal(day.activeMs, 0)
  assert.equal(day.toolCalls, 0)
  assert.deepEqual(day.byType, { test: 2 })
  assert.deepEqual(day.sessions, ['s1'])
})
