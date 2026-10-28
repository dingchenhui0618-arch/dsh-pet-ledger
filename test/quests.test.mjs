import { strict as assert } from 'node:assert'
import test from 'node:test'
import { emptyDay } from '../src/ledger.js'
import { ensureQuests, formatMinutes, normalizeQuestOptions, questProgress, questView } from '../src/quests.js'

const T0 = Date.UTC(2026, 9, 28, 8, 0, 0)
const DAY = '2026-10-28'

function dayWith(overrides) {
  return Object.assign(emptyDay(DAY), overrides || {})
}

test('nothing is generated before there is real activity', () => {
  const store = {}
  const day = dayWith({ activeMs: 30_000, toolCalls: 2 })
  assert.equal(ensureQuests(day, store, {}), null)
  const view = questView(store, day, T0)
  assert.equal(view.pending, true)
  assert.equal(view.items.length, 0)
  assert.match(view.reason, /不会凭空生成/)
})

test('either enough active time or enough tool calls justifies generation', () => {
  const byTime = {}
  assert.ok(ensureQuests(dayWith({ activeMs: 60_000, toolCalls: 0 }), byTime, {}) !== null)
  const byTools = {}
  assert.ok(ensureQuests(dayWith({ activeMs: 0, toolCalls: 3 }), byTools, {}) !== null)
})

test('quests are generated from actual usage and actual command types, not a fixed list', () => {
  const store = {}
  const day = dayWith({
    activeMs: 10 * 60_000,
    toolCalls: 9,
    byType: { test: 3, commit: 1, read: 8, grep: 2 },
  })
  const record = ensureQuests(day, store, {})
  assert.ok(record !== null)
  assert.equal(record.items.length, 3, 'focus + two command types')
  assert.equal(record.items[0].kind, 'focus')
  assert.equal(record.items[0].baseline, 10 * 60_000)
  assert.equal(record.items[0].target, 10 * 60_000, 'half the current usage, clamped to 10 minutes')
  assert.equal(record.items[1].commandType, 'test')
  assert.equal(record.items[1].target, 2)
  assert.equal(record.items[2].commandType, 'commit')
  assert.equal(record.items[2].target, 1)
  assert.equal(record.basis.commandTypes.length, 2, 'read/grep are not command types')
  assert.equal(record.basis.commandTypes[0].type, 'test')
})

test('fewer real command types means fewer quests, never filler', () => {
  const store = {}
  const record = ensureQuests(dayWith({ activeMs: 120_000, toolCalls: 4, byType: { build: 2 } }), store, {})
  assert.equal(record.items.length, 2)
  assert.equal(record.items[1].commandType, 'build')
})

test('targets stay frozen after generation even as the day grows', () => {
  const store = {}
  const day = dayWith({ activeMs: 10 * 60_000, toolCalls: 4, byType: { test: 2 } })
  const first = ensureQuests(day, store, {})
  const target = first.items[0].target
  day.activeMs = 90 * 60_000
  day.byType.test = 9
  const second = ensureQuests(day, store, {})
  assert.equal(second.items[0].target, target)
  assert.equal(second.items[1].target, 1)
  assert.equal(second, first)
})

test('progress is measured against the frozen baseline and completes at the target', () => {
  const store = {}
  const day = dayWith({ activeMs: 10 * 60_000, toolCalls: 4, byType: { test: 2 } })
  const record = ensureQuests(day, store, {})
  const focus = record.items[0]
  assert.deepEqual(questProgress(focus, day), {
    current: 10 * 60_000,
    baseline: 10 * 60_000,
    done: 0,
    target: 10 * 60_000,
    percent: 0,
    complete: false,
    unit: 'ms',
  })
  day.activeMs += 5 * 60_000
  assert.equal(questProgress(focus, day).percent, 50)
  day.activeMs += 5 * 60_000
  assert.equal(questProgress(focus, day).complete, true)

  const command = record.items[1]
  day.byType.test = 4
  assert.equal(questProgress(command, day).complete, true)
  assert.equal(questProgress(command, day).done, 1)
})

test('the rendered quest view carries progress and the generation basis', () => {
  const store = {}
  const day = dayWith({ activeMs: 20 * 60_000, toolCalls: 6, byType: { test: 2, push: 1 } })
  ensureQuests(day, store, {})
  const view = questView(store, day, T0)
  assert.equal(view.pending, false)
  assert.equal(view.day, DAY)
  assert.equal(view.basis.activeMs, 20 * 60_000)
  assert.equal(view.items.length, 3)
  for (const item of view.items) {
    assert.ok(item.progress !== undefined)
    assert.equal(typeof item.progress.percent, 'number')
    assert.equal(item.progress.complete, false)
  }
})

test('a stored bucket with broken items is treated as not generated', () => {
  const store = { [DAY]: { day: DAY, items: 'nope' } }
  const view = questView(store, dayWith({ activeMs: 0 }), T0)
  assert.equal(view.pending, true)
})

test('old quest days are pruned to the newest seven', () => {
  const store = {}
  for (let index = 0; index < 9; index += 1) {
    const key = '2026-10-' + String(10 + index).padStart(2, '0')
    store[key] = { day: key, items: [] }
  }
  ensureQuests(dayWith({ activeMs: 120_000, toolCalls: 3, byType: { shell: 3 } }), store, {})
  assert.equal(Object.keys(store).length, 7)
  assert.equal(store[DAY] !== undefined, true)
})

test('minutes read as minutes and options tolerate nonsense', () => {
  assert.equal(formatMinutes(0), '不到 1')
  assert.equal(formatMinutes(59_000), '不到 1')
  assert.equal(formatMinutes(10 * 60_000), '10')
  const options = normalizeQuestOptions({ minActiveMs: -1, minToolCalls: NaN })
  assert.equal(options.minActiveMs, 60_000)
  assert.equal(options.minToolCalls, 3)
})
