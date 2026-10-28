// Host half of dsh-pet-ledger.
//
// The pet cannot see the truth from the client, so this half listens to the
// harness's real event bus and folds it into one ledger:
//
//   tools/pre-execute  -> what is about to run (pending call; never blocked)
//   tools/result       -> what actually happened (isError, output, duration)
//   agent/status       -> a turn opened / closed
//   session/event      -> why a turn ended (only `completed` can earn a long-task)
//   session/created    -> the session's working directory, for the evidence header
//
// `tools/pre-execute` is a waterfall that decides whether a tool runs at all,
// so the listener here always reaches `next()` — including when its own recording
// throws. A pet that can block the work it observes is worse than no pet.
//
// Demo records are produced only by POST /demo and never enter the real ledger.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { classifyTool, describeCall } from './commands.js'
import {
  clearDemo,
  createDemo,
  createState,
  dayKey,
  emptyDay,
  ingestAgentDisposed,
  ingestAgentStatus,
  ingestSessionCreated,
  ingestToolResult,
  ingestToolStart,
  ingestTurnEnd,
  normalizeOptions,
  snapshot,
} from './ledger.js'
import { ensureQuests, normalizeQuestOptions, questView } from './quests.js'
import { loadState, saveState } from './store.js'

export const name = 'dsh-pet-ledger'
export const inject = ['webServer']

const ROUTE = '/dsh-pet-ledger'
const MAX_BODY = 65_536
const SAVE_DELAY_MS = 1500

// One process must have one owner of a ledger file. A hot reload can mount the
// host half again before the old fiber is torn down; without this registry the
// two instances would double-count the same event and race on the same file.
const HOSTS = new Map()

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = ''
    let settled = false
    function finish(value) {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > MAX_BODY) {
        finish(undefined)
        req.destroy()
      }
    })
    req.on('end', function () {
      if (raw.length === 0) return finish({})
      try {
        const parsed = JSON.parse(raw)
        finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined)
      } catch (error) {
        finish(undefined)
      }
    })
    req.on('error', function () { finish(undefined) })
  })
}

function methodOf(url) {
  const path = String(url || '').split('?')[0]
  if (path === ROUTE || path === ROUTE + '/') return ''
  if (path.indexOf(ROUTE + '/') !== 0) return null
  return path.slice(ROUTE.length + 1)
}

function resultText(result) {
  if (result === undefined || result === null || typeof result !== 'object') return ''
  const parts = []
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
  }
  if (result.error !== undefined && result.error !== null && typeof result.error.message === 'string') {
    parts.push(result.error.message)
  }
  return parts.join('\n')
}

// A failed shell call is not necessarily `isError: true`: the terminal tools
// report a non-zero exit code inside a successful result value. Both are real
// failures to the person looking at the session, so both must count.
function failureOf(result) {
  if (result === undefined || result === null) return false
  if (result.isError === true) return true
  const value = result.value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['exitCode', 'exit_code', 'code']) {
      const code = value[key]
      if (typeof code === 'number' && Number.isFinite(code) && code !== 0) return true
    }
  }
  return /(?:^|\n)\[exit code: [1-9]\d*\]/.test(resultText(result))
}

/**
 * @param {object} ctx cordis context
 * @param {{longTaskMs?:number, idleGapMs?:number, timeZone?:string,
 *          minActiveMs?:number, minToolCalls?:number, dataPath?:string,
 *          enabled?:boolean}} [config]
 */
export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const home = typeof settings.dshHome === 'string' ? settings.dshHome : dshHome()
  const dataPath = typeof settings.dataPath === 'string' && settings.dataPath.length > 0
    ? settings.dataPath
    : join(home, 'pet-ledger.json')
  const options = normalizeOptions({
    idleGapMs: settings.idleGapMs,
    longTaskMs: settings.longTaskMs,
    timeZone: settings.timeZone,
  })
  const questOptions = normalizeQuestOptions({
    minActiveMs: settings.minActiveMs,
    minToolCalls: settings.minToolCalls,
  })
  const enabled = settings.enabled !== false

  // Take over from a previous mounting of this half for the same file. It
  // flushes and unregisters its route first, so this instance loads a settled
  // file and is the only one able to register the route.
  const previous = HOSTS.get(dataPath)
  if (previous !== undefined) {
    try {
      previous.dispose()
    } catch (error) {
      // a failing unload must not block the new instance
    }
  }

  const loaded = loadState(dataPath)
  let state = loaded.state
  const stats = {
    events: 0,
    toolStarts: 0,
    results: 0,
    failures: 0,
    awards: 0,
    demos: 0,
    saves: 0,
    saveError: '',
    loadError: loaded.error,
  }

  // callId -> the pre-execute facts. The result event carries the call again,
  // but not always the parsed arguments; keeping them here is what lets an
  // evidence row show the actual command line.
  const pending = new Map()
  const labels = new Map()
  const ownDisposers = []
  let saveTimer = null
  let lastSave = 0
  let disposed = false
  const handle = { dispose: function () {} }
  HOSTS.set(dataPath, handle)

  function on(name, listener) {
    const dispose = ctx.on(name, listener)
    if (typeof dispose === 'function') ownDisposers.push(dispose)
  }

  function alive() {
    return !disposed && HOSTS.get(dataPath) === handle
  }

  function sessionIdOf(agent) {
    if (agent === undefined || agent === null) return 'unattributed'
    const id = agent.id
    return typeof id === 'string' && id.length > 0 ? id : 'unattributed'
  }

  function labelOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return ''
    if (labels.has(sessionId)) return labels.get(sessionId)
    let sessions
    try {
      sessions = ctx.get('sessions')
    } catch (error) {
      return ''
    }
    if (sessions === undefined) return ''
    try {
      const session = sessions.get(sessionId)
      const cwd = session && session.header ? session.header.cwd : undefined
      if (typeof cwd === 'string' && cwd.length > 0) {
        labels.set(sessionId, cwd)
        return cwd
      }
    } catch (error) {
      return ''
    }
    return ''
  }

  function rememberLabel(sessionId, cwd) {
    if (typeof sessionId !== 'string' || typeof cwd !== 'string' || cwd.length === 0) return
    labels.set(sessionId, cwd)
  }

  /** Persist now, or schedule a small delayed write. Failures are reported, not thrown. */
  function persist(immediate) {
    if (!enabled || !alive()) return
    if (immediate) {
      if (saveTimer !== null) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      const result = saveState(dataPath, state)
      lastSave = Date.now()
      stats.saveError = result.error
      if (result.ok) stats.saves += 1
      return
    }
    if (saveTimer !== null) return
    const wait = Math.max(0, SAVE_DELAY_MS - (Date.now() - lastSave))
    saveTimer = setTimeout(function () {
      saveTimer = null
      if (!alive()) return
      try {
        const result = saveState(dataPath, state)
        lastSave = Date.now()
        stats.saveError = result.error
        if (result.ok) stats.saves += 1
      } catch (error) {
        stats.saveError = String((error && error.message) || error)
      }
    }, wait)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  function today(now) {
    const key = dayKey(now, options.timeZone)
    return state.daily[key] || emptyDay(key)
  }

  /** Generate the day's quests as soon as there is enough real activity. */
  function growQuests(now) {
    const key = dayKey(now, options.timeZone)
    const before = state.quests[key]
    const record = ensureQuests(today(now), state.quests, questOptions)
    if (record !== null && before === undefined) {
      persist(true)
      return true
    }
    return false
  }

  function recordStart(exec) {
    if (!enabled || !alive() || exec === undefined || exec === null) return
    const at = Date.now()
    const sessionId = sessionIdOf(exec.agent)
    const label = labelOf(sessionId)
    const callId = String(exec.callId === undefined || exec.callId === null ? '' : exec.callId)
    const tool = String(exec.name === undefined || exec.name === null ? '' : exec.name)
    const args = exec.arguments
    const info = classifyTool(tool, args)
    pending.set(callId, { at: at, tool: tool, args: args, info: info, sessionId: sessionId, label: label })
    if (pending.size > 200) {
      const first = pending.keys().next()
      if (!first.done) pending.delete(first.value)
    }
    stats.events += 1
    stats.toolStarts += 1
    ingestToolStart(state, {
      callId: callId,
      tool: tool,
      args: args,
      info: info,
      sessionId: sessionId,
      label: label,
      at: at,
    }, options)
    persist(false)
  }

  function recordResult(exec, result) {
    if (!enabled || !alive() || exec === undefined || exec === null) return
    const at = Date.now()
    const callId = String(exec.callId === undefined || exec.callId === null ? '' : exec.callId)
    const sessionId = sessionIdOf(exec.agent)
    const label = labelOf(sessionId)
    const started = pending.get(callId)
    pending.delete(callId)
    const tool = String(exec.name === undefined || exec.name === null ? '' : exec.name)
    const args = started === undefined ? exec.arguments : started.args
    const info = started === undefined ? classifyTool(tool, args) : started.info
    const isError = failureOf(result)

    stats.events += 1
    stats.results += 1
    if (isError) stats.failures += 1

    const earned = ingestToolResult(state, {
      callId: callId,
      tool: tool,
      args: args,
      kind: info.kind,
      command: info.command,
      line: describeCall(tool, args),
      sessionId: sessionId,
      label: label,
      at: at,
      isError: isError,
      result: resultText(result),
      ms: started === undefined ? 0 : Math.max(0, at - started.at),
    }, options)
    if (earned.length > 0) {
      stats.awards += earned.length
      persist(true)
    } else {
      persist(false)
    }
    growQuests(at)
  }

  function recordStatus(payload) {
    if (!enabled || !alive() || payload === undefined || payload === null) return
    const status = payload.status
    if (status !== 'running' && status !== 'idle') return
    const sessionId = sessionIdOf(payload.agent)
    const label = labelOf(sessionId)
    stats.events += 1
    const earned = ingestAgentStatus(state, {
      status: status,
      sessionId: sessionId,
      label: label,
      at: Date.now(),
    }, options)
    if (earned.length > 0) {
      stats.awards += earned.length
      persist(true)
    }
  }

  function recordTurnEnd(session, event) {
    if (!enabled || !alive() || event === undefined || event === null) return
    if (event.type !== 'turn/end') return
    const sessionId = session !== undefined && session !== null && typeof session.id === 'string'
      ? session.id
      : 'unattributed'
    rememberLabel(sessionId, session !== undefined && session !== null && session.header
      ? session.header.cwd
      : undefined)
    const reason = event.data !== undefined && event.data !== null && event.data.reason !== undefined
      ? event.data.reason
      : undefined
    const kind = reason !== undefined && reason !== null && typeof reason.kind === 'string'
      ? reason.kind
      : 'unknown'
    stats.events += 1
    ingestTurnEnd(state, { sessionId: sessionId, reason: kind })
  }

  function recordSessionCreated(session) {
    if (!enabled || !alive() || session === undefined || session === null) return
    const sessionId = typeof session.id === 'string' ? session.id : 'unattributed'
    const cwd = session.header !== undefined && session.header !== null && typeof session.header.cwd === 'string'
      ? session.header.cwd
      : ''
    rememberLabel(sessionId, cwd)
    stats.events += 1
    ingestSessionCreated(state, { sessionId: sessionId, label: cwd })
  }

  // A waterfall: reach next() on every path, including our own failures.
  on('tools/pre-execute', async function (exec, next) {
    try {
      recordStart(exec)
    } catch (error) {
      // never let observation stop the call
    }
    return next()
  })

  // Emit events: a thrown listener is contained by the harness, but a throw
  // inside our own bookkeeping is still a bug, so each handler guards itself.
  on('tools/result', function (exec, result) {
    try {
      recordResult(exec, result)
    } catch (error) {
      // ignore
    }
  })

  on('agent/status', function (payload) {
    try {
      recordStatus(payload)
    } catch (error) {
      // ignore
    }
  })

  on('session/event', function (session, event) {
    try {
      recordTurnEnd(session, event)
    } catch (error) {
      // ignore
    }
  })

  on('session/created', function (session) {
    try {
      recordSessionCreated(session)
    } catch (error) {
      // ignore
    }
  })

  on('agent/disposed', function (payload) {
    try {
      if (!enabled || !alive() || payload === undefined || payload === null) return
      const sessionId = sessionIdOf(payload.agent)
      stats.events += 1
      ingestAgentDisposed(state, { sessionId: sessionId })
    } catch (error) {
      // ignore
    }
  })

  // Unload is shared by the Cordis fiber and by a newer instance taking over.
  function disposeSelf() {
    if (disposed) return
    disposed = true
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    try {
      saveState(dataPath, state)
    } catch (error) {
      // unloading must not throw
    }
    if (HOSTS.get(dataPath) === handle) HOSTS.delete(dataPath)
    const pendingDisposers = ownDisposers.splice(0)
    for (const dispose of pendingDisposers) {
      try {
        dispose()
      } catch (error) {
        // best effort
      }
    }
    if (typeof disposeRoute === 'function') disposeRoute()
  }
  handle.dispose = disposeSelf

  // The panel is disposable. If the route cannot be registered — a changed
  // webServer contract, a host without a web server — capture must keep running,
  // because the ledger is the half that matters.
  let disposeRoute
  ctx.effect(function () {
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async function (req, res) {
          try {
            const method = methodOf(req.url)
            if (method === null) {
              sendJson(res, 404, { error: 'not found' })
              return
            }
            if (req.method === 'GET') {
              if (method !== '' && method !== 'state') {
                sendJson(res, 404, { error: 'not found' })
                return
              }
              const now = Date.now()
              growQuests(now)
              const quests = questView(state.quests, today(now), now)
              const data = snapshot(state, {
                now: now,
                idleGapMs: options.idleGapMs,
                longTaskMs: options.longTaskMs,
                timeZone: options.timeZone,
              })
              data.quests = quests
              data.capture = {
                toolStarts: stats.toolStarts,
                results: stats.results,
                failures: stats.failures,
                awards: stats.awards,
                demos: stats.demos,
                saves: stats.saves,
                saveError: stats.saveError,
                loadError: stats.loadError,
                enabled: enabled,
              }
              data.dataPath = dataPath
              sendJson(res, 200, data)
              return
            }
            if (req.method === 'POST') {
              const body = await readBody(req)
              if (body === undefined) {
                sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
                return
              }
              if (method === 'demo') {
                const added = createDemo(state, Date.now())
                stats.demos += added.length
                sendJson(res, 200, { ok: true, added: added.length, watermark: '演示' })
                return
              }
              if (method === 'demo-clear') {
                const removed = clearDemo(state)
                sendJson(res, 200, { ok: true, removed: removed })
                return
              }
              sendJson(res, 404, { error: 'unknown method' })
              return
            }
            sendJson(res, 405, { error: 'method not allowed' })
          } catch (error) {
            sendJson(res, 500, { error: String((error && error.message) || error) })
          }
        },
      })
    } catch (error) {
      disposeRoute = undefined
    }
    return disposeSelf
  })
}

/** Exposed for the test suite: the route shape is part of the contract. */
export const internals = {
  ROUTE: ROUTE,
  methodOf: methodOf,
  resultText: resultText,
  failureOf: failureOf,
}
