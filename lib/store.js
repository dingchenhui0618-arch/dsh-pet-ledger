// Durable state for dsh-pet-ledger.
//
// Only the ledger itself is persisted: counters, real achievements (with their
// evidence rows), per-day aggregates, and the day's generated quests. Demo
// records are deliberately not persisted — they are a preview, and a demo card
// that survives a restart is exactly the "self-deception" this plugin exists to
// avoid. In-flight session state (pending calls, current turn) is process-local.
//
// A corrupt file is ignored rather than fatal: a broken pet ledger must not stop
// a session from starting.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createState, pruneDays } from './ledger.js'

const KEEP_DAYS = 7
const MAX_ACHIEVEMENTS = 200

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function normalizeDay(raw, key) {
  if (raw === null || typeof raw !== 'object') return undefined
  const day = {
    day: typeof raw.day === 'string' && raw.day.length > 0 ? raw.day : key,
    activeMs: Math.max(0, numberOr(raw.activeMs, 0)),
    firstAt: numberOr(raw.firstAt, 0),
    lastAt: numberOr(raw.lastAt, 0),
    events: Math.max(0, numberOr(raw.events, 0)),
    toolCalls: Math.max(0, numberOr(raw.toolCalls, 0)),
    failures: Math.max(0, numberOr(raw.failures, 0)),
    testsFailed: Math.max(0, numberOr(raw.testsFailed, 0)),
    testsPassed: Math.max(0, numberOr(raw.testsPassed, 0)),
    commits: Math.max(0, numberOr(raw.commits, 0)),
    pushes: Math.max(0, numberOr(raw.pushes, 0)),
    byType: {},
    sessions: [],
  }
  if (raw.byType && typeof raw.byType === 'object') {
    for (const [kind, count] of Object.entries(raw.byType)) {
      if (typeof kind === 'string' && Number.isFinite(count) && count > 0) day.byType[kind] = count
    }
  }
  if (Array.isArray(raw.sessions)) {
    for (const id of raw.sessions) {
      if (typeof id === 'string' && day.sessions.indexOf(id) < 0) day.sessions.push(id)
    }
  }
  return day
}

function normalizeAchievement(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  // Only real achievements are ever persisted; a demo record in the file is
  // either corruption or a bug, and is dropped rather than shown as earned.
  if (raw.source !== 'real' || raw.demo === true) return undefined
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  if (typeof raw.title !== 'string' || typeof raw.family !== 'string') return undefined
  if (!Number.isFinite(raw.at)) return undefined
  const evidence = []
  if (Array.isArray(raw.evidence)) {
    for (const row of raw.evidence.slice(0, 8)) {
      if (row === null || typeof row !== 'object') continue
      evidence.push({
        callId: String(row.callId || ''),
        at: numberOr(row.at, 0),
        tool: String(row.tool || ''),
        kind: String(row.kind || 'other'),
        line: String(row.line || ''),
        command: String(row.command || ''),
        result: String(row.result || ''),
        ok: row.ok === true,
        ms: numberOr(row.ms, 0),
        sessionId: String(row.sessionId || ''),
      })
    }
  }
  return {
    id: raw.id,
    family: raw.family,
    familyLabel: String(raw.familyLabel || ''),
    tier: String(raw.tier || 'bronze'),
    title: raw.title,
    desc: String(raw.desc || ''),
    at: raw.at,
    sessionId: String(raw.sessionId || ''),
    sessionLabel: String(raw.sessionLabel || ''),
    source: 'real',
    demo: false,
    watermark: '',
    evidence: evidence,
    detail: raw.detail === undefined ? null : raw.detail,
  }
}

/** Read a state file. Never throws; `error` is reported, not raised. */
export function loadState(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { state: createState(), error: 'no data path configured' }
  }
  if (!existsSync(filePath)) return { state: createState(), error: '' }
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    return { state: createState(), error: String(error.message || error) }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('state file is not a JSON object')
    const state = createState()
    if (parsed.counters && typeof parsed.counters === 'object') {
      state.counters.failureStreakMax = Math.max(0, numberOr(parsed.counters.failureStreakMax, 0))
      state.counters.longTasks = Math.max(0, numberOr(parsed.counters.longTasks, 0))
      state.counters.redGreen = Math.max(0, numberOr(parsed.counters.redGreen, 0))
      state.counters.commitPush = Math.max(0, numberOr(parsed.counters.commitPush, 0))
    }
    if (parsed.earned && typeof parsed.earned === 'object') {
      for (const [id, value] of Object.entries(parsed.earned)) {
        if (value === true) state.earned[id] = true
      }
    }
    if (Array.isArray(parsed.achievements)) {
      for (const entry of parsed.achievements) {
        const record = normalizeAchievement(entry)
        if (record !== undefined) state.achievements.push(record)
      }
      state.achievements = state.achievements.slice(0, MAX_ACHIEVEMENTS)
    }
    if (parsed.daily && typeof parsed.daily === 'object') {
      for (const [key, entry] of Object.entries(parsed.daily)) {
        const day = normalizeDay(entry, key)
        if (day !== undefined) state.daily[key] = day
      }
    }
    if (parsed.quests && typeof parsed.quests === 'object') {
      for (const [key, entry] of Object.entries(parsed.quests)) {
        if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.items)) continue
        state.quests[key] = entry
      }
    }
    pruneDays(state, KEEP_DAYS)
    return { state: state, error: '' }
  } catch (error) {
    return { state: createState(), error: 'ignored unreadable ledger: ' + String(error.message || error) }
  }
}

function persisted(state) {
  return {
    version: state.version,
    counters: state.counters,
    earned: state.earned,
    achievements: state.achievements.filter(function (record) {
      return record.source === 'real' && record.demo !== true
    }),
    daily: state.daily,
    quests: state.quests,
  }
}

/** Write the durable subset. Returns an error string instead of throwing. */
export function saveState(filePath, state) {
  if (typeof filePath !== 'string' || filePath.length === 0) return { ok: false, error: 'no data path configured' }
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const json = JSON.stringify(persisted(state))
    const temporary = filePath + '.tmp'
    writeFileSync(temporary, json, 'utf8')
    try {
      renameSync(temporary, filePath)
    } catch (error) {
      // Some Windows configurations refuse to rename over an existing file.
      writeFileSync(filePath, json, 'utf8')
      try { rmSync(temporary, { force: true }) } catch (inner) { /* best effort */ }
    }
    return { ok: true, error: '' }
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  }
}

export const internals = { persisted: persisted, normalizeDay: normalizeDay, normalizeAchievement: normalizeAchievement }
