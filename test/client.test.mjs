// The client half is CommonJS and expects the harness to supply React, so it is
// loaded here with React and the browser globals stubbed. The real module is the
// one the browser runs; only the platform is replaced.
//
// The promises this panel makes — every real card can be opened to show the
// session and tool-call evidence, every demo card carries the 演示 watermark, and
// an empty ledger says so honestly — only exist in the rendered tree. So these
// tests render the registered component, not just the pure helpers.

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let effectCleanups = []
let slots = []
let slotIndex = 0

const React = {
  createElement: function (type) {
    const children = Array.prototype.slice.call(arguments, 2)
    const props = Object.assign({}, arguments[1] || {})
    if (children.length > 0) props.children = children.length === 1 ? children[0] : children
    return { type: type, props: props, children: children }
  },
  useState: function (initial) {
    const index = slotIndex
    slotIndex += 1
    if (slots.length <= index) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], function (next) {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next
    }]
  },
  useEffect: function (fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
  },
}

const originalRequire = Module.prototype.require
Module.prototype.require = function (id) {
  if (id === 'react') return React
  return originalRequire.apply(this, arguments)
}

let fetched = null
let fetchMode = 'ok'
const warnings = []

global.fetch = function () {
  if (fetchMode === 'reject') return Promise.reject(new Error('host is offline'))
  return Promise.resolve({ json: function () { return Promise.resolve(fetched) } })
}
global.document = {
  createElement: function () { return { dataset: {}, textContent: '', remove: function () {} } },
  head: { appendChild: function () {} },
}
global.console.warn = function (message) { warnings.push(String(message)) }

const client = require('../src/client.cjs')

let registered = null
function makeCtx(registerThrows) {
  return {
    effect: function (fn) {
      const cleanup = fn()
      const wrapped = typeof cleanup === 'function' ? cleanup : function () {}
      effectCleanups.push(wrapped)
      return wrapped
    },
    slots: {
      inject: function (name, fn) { fn() },
      register: function (options, component) {
        if (registerThrows === true) throw new Error('slot contract changed')
        registered = { options: options, component: component }
        return function () {}
      },
    },
  }
}

function reset() {
  const pending = effectCleanups.splice(0)
  for (const cleanup of pending) cleanup()
  slots = []
  slotIndex = 0
  warnings.length = 0
}

function settle() {
  return new Promise(function (resolve) { setTimeout(resolve, 0) })
}

async function render(data) {
  fetched = data
  fetchMode = 'ok'
  slots = []
  slotIndex = 0
  registered.component()
  await settle()
  await settle()
  slotIndex = 0
  return registered.component()
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walk(node.type(node.props || {}), visit)
    return
  }
  visit(node)
  for (const child of node.children || []) {
    if (Array.isArray(child)) {
      for (const entry of child) walk(entry, visit)
    } else {
      walk(child, visit)
    }
  }
}

function collect(node, predicate) {
  const found = []
  walk(node, function (entry) {
    if (predicate(entry)) found.push(entry)
  })
  return found
}

function textOf(node) {
  let text = ''
  walk(node, function (entry) {
    for (const child of entry.children || []) {
      if (typeof child === 'string' || typeof child === 'number') text += String(child) + '\n'
    }
  })
  return text
}

function byClass(tree, className) {
  return collect(tree, function (node) {
    return typeof node.props.className === 'string' && node.props.className.split(' ').indexOf(className) >= 0
  })
}

const DATA = {
  version: 1,
  now: Date.UTC(2026, 9, 28, 8, 30, 0),
  day: '2026-10-28',
  stats: { real: 2, demo: 1, evidenceRows: 5, events: 20, toolCalls: 12, failures: 3, awards: 2 },
  counters: { failureStreakMax: 3, longTasks: 1, redGreen: 2, commitPush: 1 },
  achievements: [
    {
      id: 'failure-streak-3',
      family: 'failure-streak',
      familyLabel: '工具连续失败',
      tier: 'bronze',
      title: '逆风三连',
      desc: '连续三次工具调用失败后没有停下，继续推进',
      at: Date.UTC(2026, 9, 28, 8, 10, 0),
      sessionId: 'session-abc',
      sessionLabel: 'D:/Projects/dsh-pet-ledger',
      source: 'real',
      demo: false,
      watermark: '',
      evidence: [
        {
          callId: 'call-1',
          at: Date.UTC(2026, 9, 28, 8, 9, 0),
          tool: 'pwsh',
          kind: 'shell',
          line: 'node -e "process.exit(1)"',
          result: 'exit code 1',
          ok: false,
          ms: 41,
          sessionId: 'session-abc',
        },
      ],
      detail: { streak: 3 },
    },
    {
      id: 'commit-push-1',
      family: 'commit-push',
      familyLabel: '提交并推送成功',
      tier: 'bronze',
      title: '落地成篇',
      desc: '一次真实提交之后，推送成功',
      at: Date.UTC(2026, 9, 28, 8, 20, 0),
      sessionId: 'session-abc',
      sessionLabel: 'D:/Projects/dsh-pet-ledger',
      source: 'real',
      demo: false,
      watermark: '',
      evidence: [],
      detail: { count: 1 },
    },
  ],
  demo: [
    {
      id: 'demo-failure-streak-1',
      family: 'failure-streak',
      familyLabel: '工具连续失败',
      tier: 'bronze',
      title: '演示 · 逆风三连',
      desc: '演示样张：不是任何真实会话挣来的',
      at: Date.UTC(2026, 9, 28, 8, 25, 0),
      sessionId: 'demo-session',
      sessionLabel: '演示态（非真实会话）',
      source: 'demo',
      demo: true,
      watermark: '演示',
      evidence: [
        {
          callId: 'demo-call-1',
          at: Date.UTC(2026, 9, 28, 8, 25, 0),
          tool: 'demo',
          kind: 'other',
          line: '演示数据：不来自任何真实会话',
          result: '模拟记录',
          ok: false,
          ms: 0,
          sessionId: 'demo-session',
        },
      ],
      detail: { demo: true },
    },
  ],
  daily: {
    day: '2026-10-28',
    activeMs: 20 * 60_000,
    firstAt: Date.UTC(2026, 9, 28, 8, 0, 0),
    lastAt: Date.UTC(2026, 9, 28, 8, 30, 0),
    events: 20,
    toolCalls: 12,
    failures: 3,
    testsFailed: 1,
    testsPassed: 2,
    commits: 1,
    pushes: 1,
    byType: { test: 3, commit: 1, shell: 2 },
    sessions: ['session-abc'],
  },
  quests: {
    day: '2026-10-28',
    generatedAt: Date.UTC(2026, 9, 28, 8, 5, 0),
    pending: false,
    reason: '',
    basis: {
      activeMs: 20 * 60_000,
      toolCalls: 12,
      commandTypes: [
        { type: 'test', label: '测试', count: 3 },
        { type: 'commit', label: '提交', count: 1 },
      ],
    },
    items: [
      {
        id: 'q-focus',
        kind: 'focus',
        title: '再专注 10 分钟',
        desc: '有效使用时长',
        metric: 'activeMs',
        unit: 'ms',
        progress: { current: 20 * 60_000, baseline: 20 * 60_000, done: 5 * 60_000, target: 10 * 60_000, percent: 50, complete: false, unit: 'ms' },
      },
      {
        id: 'q-test',
        kind: 'command',
        commandType: 'test',
        title: '再跑 2 次测试',
        desc: '今天真实跑过 3 次测试',
        metric: 'byType.test',
        unit: 'count',
        progress: { current: 3, baseline: 3, done: 1, target: 2, percent: 50, complete: false, unit: 'count' },
      },
    ],
  },
  families: [
    { key: 'failure-streak', label: '工具连续失败', tiers: [] },
    { key: 'long-task', label: '长任务完成', tiers: [] },
    { key: 'red-green', label: '测试由红转绿', tiers: [] },
    { key: 'commit-push', label: '提交并推送成功', tiers: [] },
  ],
  config: { longTaskMs: 90_000, idleGapMs: 300_000, timeZone: 'Asia/Shanghai' },
  dataPath: 'C:/Users/me/.dsh/pet-ledger.json',
}

function emptyData() {
  return Object.assign({}, DATA, {
    stats: { real: 0, demo: 0, evidenceRows: 0, events: 0, toolCalls: 0, failures: 0, awards: 0 },
    counters: { failureStreakMax: 0, longTasks: 0, redGreen: 0, commitPush: 0 },
    achievements: [],
    demo: [],
    quests: { day: '2026-10-28', pending: true, reason: '今天还没有足够的真实使用记录，任务不会凭空生成。', basis: null, items: [] },
    daily: { day: '2026-10-28', activeMs: 0, toolCalls: 0, byType: {}, sessions: [] },
  })
}

afterEach(function () { reset() })

test('the client exports the plugin contract and registers the 宠物账本 view', function () {
  assert.equal(client.name, 'dsh-pet-ledger')
  assert.deepEqual(client.inject, ['slots'])
  assert.equal(typeof client.apply, 'function')
  client.apply(makeCtx())
  assert.ok(registered !== null)
  assert.deepEqual(registered.options, { name: 'conversation.view', id: 'pet-ledger', order: 45, label: '宠物账本' })
  assert.equal(typeof registered.component, 'function')
})

test('the rendered ledger shows the pet, real achievements, and the day quests', async function () {
  const tree = await render(DATA)
  const root = collect(tree, function (node) { return node.props['data-pet-ledger'] === 'ready' })[0]
  assert.ok(root !== undefined, 'root data-pet-ledger=ready')
  const text = textOf(tree)
  assert.match(text, /宠物账本/)
  assert.match(text, /今日任务/)
  assert.match(text, /成就墙/)
  assert.match(text, /逆风三连/)
  assert.match(text, /落地成篇/)
  assert.match(text, /再专注 10 分钟/)
  assert.match(text, /生成依据/)
  assert.match(text, /测试×3/)
  assert.match(text, /20 分钟/)
  assert.equal(byClass(tree, 'pl-stat').length, 4)
  const bars = collect(tree, function (node) { return node.props.role === 'progressbar' })
  assert.equal(bars.length, 2)
  assert.equal(bars[0].props['aria-valuenow'], '50')
  assert.ok(text.indexOf('演示 · 逆风三连') >= 0)
})

test('every demo card carries the 演示 watermark and is marked as demo', async function () {
  const tree = await render(DATA)
  const demoCards = collect(tree, function (node) { return node.props['data-demo'] === 'true' })
  assert.equal(demoCards.length, 1)
  assert.match(demoCards[0].props.className, /pl-demo/)
  const watermark = byClass(tree, 'pl-watermark')
  assert.equal(watermark.length, 1)
  assert.equal(textOf(watermark[0]).trim(), '演示')

  const realCards = collect(tree, function (node) { return node.props['data-demo'] === 'false' })
  assert.equal(realCards.length, 2)
  const realWatermarks = collect(realCards[0], function (node) { return typeof node.props.className === 'string' && node.props.className.includes('pl-watermark') })
  assert.equal(realWatermarks.length, 0)
})

test('opening a real achievement reveals the session and the tool-call evidence line', async function () {
  let tree = await render(DATA)
  assert.equal(byClass(tree, 'pl-evidence').length, 0, 'evidence is collapsed by default')
  const card = collect(tree, function (node) { return node.props['data-achievement-id'] === 'failure-streak-3' })[0]
  assert.ok(card !== undefined)
  card.props.onClick()
  slotIndex = 0
  tree = registered.component()
  const evidence = byClass(tree, 'pl-evidence')
  assert.equal(evidence.length, 1)
  const text = textOf(evidence[0])
  assert.match(text, /session-abc/)
  assert.match(text, /D:\/Projects\/dsh-pet-ledger/)
  assert.match(text, /node -e "process\.exit\(1\)"/)
  assert.match(text, /exit code 1/)
  assert.equal(collect(evidence[0], function (node) { return node.props['data-evidence-call'] === 'call-1' }).length, 1)
  assert.match(text, /失败/)
})

test('an empty ledger is honest instead of decorated', async function () {
  const tree = await render(emptyData())
  const text = textOf(tree)
  assert.match(text, /还没有真实成就/)
  assert.match(text, /不会凭空生成/)
  assert.match(text, /还没有演示样张/)
  assert.equal(byClass(tree, 'pl-card').length, 0)
  assert.equal(byClass(tree, 'pl-quest').length, 0)
})

test('clicking a family chip narrows the wall without touching the data', async function () {
  let tree = await render(DATA)
  const chips = byClass(tree, 'pl-chip')
  assert.ok(chips.length >= 5)
  const commitChip = chips.find(function (chip) { return textOf(chip).indexOf('提交并推送成功') >= 0 })
  assert.ok(commitChip !== undefined)
  commitChip.props.onClick()
  slotIndex = 0
  tree = registered.component()
  const cards = collect(tree, function (node) { return node.props['data-demo'] === 'false' })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].props['data-achievement-id'], 'commit-push-1')
})

test('a host that cannot be reached is reported instead of rendering fake data', async function () {
  fetchMode = 'reject'
  slots = []
  slotIndex = 0
  registered.component()
  await settle()
  await settle()
  slotIndex = 0
  const tree = registered.component()
  const text = textOf(tree)
  assert.match(text, /与 host 通信失败/)
  assert.match(text, /host is offline/)
})

test('a slot registration failure is contained and says which view failed', function () {
  // The guard lives inside slots.inject's callback: the harness must get a
  // warning and a working plugin graph, not an exception that aborts boot.
  warnings.length = 0
  const ctx = {
    effect: function (fn) { const cleanup = fn(); if (typeof cleanup === 'function') effectCleanups.push(cleanup) },
    slots: {
      inject: function (name, fn) { fn() },
      register: function () { throw new Error('slot contract changed') },
    },
  }
  assert.doesNotThrow(function () { client.apply(ctx) })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /宠物账本/)
})

test('pure helpers format durations and proof counts without a DOM', function () {
  const helpers = client.__test
  assert.equal(helpers.humanDuration(0), '0ms')
  assert.equal(helpers.humanDuration(41), '41ms')
  assert.equal(helpers.humanDuration(1500), '1.5s')
  assert.equal(helpers.humanDuration(90_000), '2 分钟')
  assert.equal(helpers.humanDuration(3_600_000), '1.0 小时')
  assert.equal(helpers.humanActive(0), '0 分钟')
  assert.equal(helpers.humanActive(30_000), '不到 1 分钟')
  assert.equal(helpers.humanActive(20 * 60_000), '20 分钟')
  assert.equal(helpers.tierLabel('gold'), '金')
  assert.equal(helpers.tierLabel('nope'), '铜')
  assert.equal(helpers.clock(0), '—')
  assert.deepEqual(helpers.achievementCounts(DATA), { 'failure-streak': 1, 'commit-push': 1 })
  assert.deepEqual(helpers.proofSummary(DATA), { real: 2, evidence: 5, demo: 1 })
  assert.deepEqual(helpers.proofSummary(null), { real: 0, evidence: 0, demo: 0 })
})
