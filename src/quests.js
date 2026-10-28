// Daily quests generated from today's real usage.
//
// There is deliberately no fixed checklist. The focus target is derived from
// the active time actually accumulated so far, and the command quests are the
// command kinds actually executed today, weighted by how often they ran. If
// nothing real has happened yet, the panel says so instead of inventing work.
//
// A quest is generated once per local day and then frozen: progress is measured
// against the frozen baseline, so the target cannot drift away as the day goes
// on. That is the difference between a goal and a moving number.

import { COMMAND_KINDS, KIND_LABELS } from './commands.js'
import { dayKey, emptyDay } from './ledger.js'

export const QUEST_DEFAULTS = {
  minActiveMs: 60_000,
  minToolCalls: 3,
  keepDays: 7,
}

const FIVE_MIN = 5 * 60_000

export function normalizeQuestOptions(options) {
  const o = options && typeof options === 'object' ? options : {}
  return {
    minActiveMs: Number.isFinite(o.minActiveMs) && o.minActiveMs >= 0 ? o.minActiveMs : QUEST_DEFAULTS.minActiveMs,
    minToolCalls: Number.isFinite(o.minToolCalls) && o.minToolCalls >= 0 ? o.minToolCalls : QUEST_DEFAULTS.minToolCalls,
  }
}

function roundUpToFiveMinutes(ms) {
  return Math.ceil(ms / FIVE_MIN) * FIVE_MIN
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function formatMinutes(ms) {
  const minutes = Math.max(0, Number(ms) || 0) / 60_000
  if (minutes < 1) return '不到 1'
  return String(Math.round(minutes))
}

function commandTypesOf(day) {
  const byType = day && day.byType && typeof day.byType === 'object' ? day.byType : {}
  const list = []
  for (const kind of COMMAND_KINDS) {
    const count = Number.isFinite(byType[kind]) ? byType[kind] : 0
    if (count > 0) list.push({ type: kind, label: KIND_LABELS[kind] || kind, count: count })
  }
  list.sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count
    return COMMAND_KINDS.indexOf(a.type) - COMMAND_KINDS.indexOf(b.type)
  })
  return list
}

/**
 * Generate the day's quests if they do not exist yet.
 * @returns {object|null} the stored quest day, or null when there is not enough
 *   real activity to justify a quest.
 */
export function ensureQuests(day, questStore, options) {
  const opts = normalizeQuestOptions(options)
  const stats = day && typeof day === 'object' ? day : emptyDay('')
  const key = typeof stats.day === 'string' && stats.day.length > 0 ? stats.day : dayKey(Date.now(), 'Asia/Shanghai')
  if (questStore === undefined || questStore === null || typeof questStore !== 'object') return null

  const existing = questStore[key]
  if (existing !== undefined && existing !== null) {
    return Array.isArray(existing.items) ? existing : null
  }

  const activeMs = Number.isFinite(stats.activeMs) ? stats.activeMs : 0
  const toolCalls = Number.isFinite(stats.toolCalls) ? stats.toolCalls : 0
  if (activeMs < opts.minActiveMs && toolCalls < opts.minToolCalls) return null

  const commandTypes = commandTypesOf(stats)
  const items = []

  const focusTarget = clamp(
    roundUpToFiveMinutes(Math.max(60_000, Math.round(activeMs * 0.5))),
    10 * 60_000,
    60 * 60_000,
  )
  items.push({
    id: key + '-focus',
    kind: 'focus',
    title: '再专注 ' + formatMinutes(focusTarget) + ' 分钟',
    desc: '有效使用时长；相邻事件间隔超过 5 分钟就当作离开，不把挂机算成陪伴。',
    metric: 'activeMs',
    target: focusTarget,
    baseline: activeMs,
    unit: 'ms',
  })

  for (const entry of commandTypes.slice(0, 2)) {
    const target = clamp(Math.ceil(entry.count / 2), 1, 5)
    items.push({
      id: key + '-cmd-' + entry.type,
      kind: 'command',
      commandType: entry.type,
      title: '再跑 ' + target + ' 次' + entry.label,
      desc: '今天真实跑过 ' + entry.count + ' 次' + entry.label + '，按实际命令类型生成。',
      metric: 'byType.' + entry.type,
      target: target,
      baseline: entry.count,
      unit: 'count',
    })
  }

  const record = {
    day: key,
    generatedAt: Date.now(),
    basis: {
      activeMs: activeMs,
      toolCalls: toolCalls,
      commandTypes: commandTypes.slice(0, 5),
    },
    items: items,
  }
  questStore[key] = record

  const keys = Object.keys(questStore).sort().reverse()
  for (const stale of keys.slice(QUEST_DEFAULTS.keepDays)) delete questStore[stale]

  return record
}

export function questProgress(item, day) {
  const stats = day && typeof day === 'object' ? day : emptyDay('')
  const target = Number.isFinite(item && item.target) ? item.target : 0
  const baseline = Number.isFinite(item && item.baseline) ? item.baseline : 0
  let current = 0
  if (item.kind === 'focus') {
    current = Number.isFinite(stats.activeMs) ? stats.activeMs : 0
  } else if (typeof item.commandType === 'string') {
    const byType = stats.byType && typeof stats.byType === 'object' ? stats.byType : {}
    current = Number.isFinite(byType[item.commandType]) ? byType[item.commandType] : 0
  }
  const raw = Math.max(0, current - baseline)
  const done = Math.min(target, raw)
  const percent = target <= 0 ? 100 : Math.min(100, Math.round((done / target) * 100))
  return {
    current: current,
    baseline: baseline,
    done: done,
    target: target,
    percent: percent,
    complete: raw >= target,
    unit: item.unit,
  }
}

/**
 * The exact object the panel renders. Before generation it is an explicit
 * pending state with a reason, never an empty list that looks like a bug.
 */
export function questView(questStore, day, now) {
  const stats = day && typeof day === 'object' ? day : emptyDay('')
  const key = typeof stats.day === 'string' && stats.day.length > 0
    ? stats.day
    : dayKey(Number.isFinite(now) ? now : Date.now(), 'Asia/Shanghai')
  const stored = questStore && typeof questStore === 'object' ? questStore[key] : undefined
  if (stored === undefined || stored === null || !Array.isArray(stored.items)) {
    return {
      day: key,
      generatedAt: 0,
      pending: true,
      reason: '今天还没有足够的真实使用记录，任务不会凭空生成。跑几次工具、累计一点有效使用后再来看。',
      basis: null,
      items: [],
    }
  }
  return {
    day: key,
    generatedAt: stored.generatedAt,
    pending: false,
    reason: '',
    basis: stored.basis,
    items: stored.items.map(function (item) {
      return {
        id: item.id,
        kind: item.kind,
        commandType: item.commandType,
        title: item.title,
        desc: item.desc,
        metric: item.metric,
        unit: item.unit,
        progress: questProgress(item, stats),
      }
    }),
  }
}
