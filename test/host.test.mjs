import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, internals } from '../src/host.js'

const T0 = Date.UTC(2026, 9, 28, 8, 0, 0)

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'pet-ledger-host-'))
}

function setup(options) {
  const settings = options || {}
  const home = settings.home || makeHome()
  const dataPath = settings.dataPath || join(home, 'pet-ledger.json')
  const listeners = new Map()
  const routes = []
  const disposers = []
  let sequence = 0

  const sessions = settings.sessions || {
    get() { return { header: { cwd: 'D:/Projects/demo' } } },
  }
  const ctx = {
    get(name) {
      if (settings.getThrows === true && name === 'sessions') throw new Error('sessions service is down')
      return name === 'sessions' ? sessions : undefined
    },
    on(event, listener) {
      listeners.set(event, listener)
      const dispose = function () {
        if (listeners.get(event) === listener) listeners.delete(event)
      }
      disposers.push(dispose)
      return dispose
    },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : function () {}
      disposers.push(wrapped)
      return wrapped
    },
    webServer: {
      register(route) {
        if (settings.registerThrows === true) throw new Error('webServer is unavailable')
        routes.push(route)
        return function () {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }

  apply(ctx, Object.assign({
    dshHome: home,
    dataPath: dataPath,
    longTaskMs: 60_000,
    idleGapMs: 300_000,
    timeZone: 'UTC',
    minActiveMs: 60_000,
    minToolCalls: 3,
  }, settings.config || {}))

  function status(value, sessionId) {
    listeners.get('agent/status')({ agent: { id: sessionId || 's1' }, status: value })
  }

  function turnEnd(reason, sessionId) {
    const id = sessionId || 's1'
    listeners.get('session/event')({ id: id, header: { cwd: 'D:/Projects/demo' } }, {
      type: 'turn/end',
      data: { reason: { kind: reason } },
    })
  }

  async function tool(name, args, spec) {
    const extra = spec || {}
    sequence += 1
    const callId = extra.callId || ('call-' + sequence)
    const exec = { callId: callId, name: name, arguments: args, agent: { id: extra.session || 's1' } }
    const pre = listeners.get('tools/pre-execute')
    assert.ok(pre, 'tools/pre-execute listener registered')
    let nextCalls = 0
    const decision = await pre(exec, async function () { nextCalls += 1; return { kind: 'allow' } })
    assert.equal(nextCalls, 1, 'the listener must always reach next()')
    assert.equal(decision.kind, 'allow')
    const result = {
      isError: extra.isError === true,
      content: [{ type: 'text', text: extra.result === undefined ? 'ok' : extra.result }],
    }
    if (extra.value !== undefined) result.value = extra.value
    if (extra.error) result.error = { message: extra.error }
    listeners.get('tools/result')(exec, result)
    return callId
  }

  async function request(method, path, body, rawBody) {
    assert.ok(routes.length > 0, 'route registered')
    const payload = rawBody !== undefined ? [rawBody] : (body === undefined ? [] : [JSON.stringify(body)])
    const req = {
      method: method,
      url: path,
      on(event, callback) {
        if (event === 'data') {
          for (const chunk of payload) callback(chunk)
        }
        if (event === 'end') callback()
      },
    }
    const response = { statusCode: 0, headers: {}, body: '' }
    const res = {
      statusCode: 0,
      setHeader(key, value) { response.headers[key] = value },
      end(text) { response.body = text },
    }
    await routes[0].handler(req, res)
    return { status: res.statusCode, json: JSON.parse(response.body) }
  }

  return {
    home: home,
    dataPath: dataPath,
    listeners: listeners,
    routes: routes,
    status: status,
    turnEnd: turnEnd,
    tool: tool,
    request: request,
    dispose() {
      const pending = disposers.splice(0)
      for (const dispose of pending) dispose()
    },
    sessions: sessions,
  }
}

async function withClock(start, fn) {
  const realNow = Date.now
  let current = start
  Date.now = function () { return current }
  try {
    return await fn(function (delta) { current += delta })
  } finally {
    Date.now = realNow
  }
}

test('three real failing tool results earn an achievement with session and call evidence', async () => {
  await withClock(T0, async function () {
    const h = setup()
    await h.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { isError: true, result: 'exit code 1' })
    await h.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { isError: true, result: 'exit code 1' })
    await h.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { isError: true, result: 'exit code 1' })

    const state = await h.request('GET', '/dsh-pet-ledger/state')
    assert.equal(state.status, 200)
    assert.equal(state.json.stats.real, 1)
    assert.equal(state.json.achievements[0].id, 'failure-streak-3')
    assert.equal(state.json.achievements[0].sessionId, 's1')
    assert.equal(state.json.achievements[0].sessionLabel, 'D:/Projects/demo')
    assert.equal(state.json.achievements[0].evidence.length, 3)
    assert.equal(state.json.capture.toolStarts, 3)
    assert.equal(state.json.capture.failures, 3)
    h.dispose()
  })
})

test('the demo endpoint only creates watermarked demo records', async () => {
  const h = setup()
  const added = await h.request('POST', '/dsh-pet-ledger/demo', {})
  assert.equal(added.status, 200)
  assert.equal(added.json.added, 4)
  const state = await h.request('GET', '/dsh-pet-ledger/state')
  assert.equal(state.json.stats.real, 0)
  assert.equal(state.json.stats.demo, 4)
  assert.equal(state.json.achievements.length, 0)
  for (const record of state.json.demo) {
    assert.equal(record.watermark, '演示')
    assert.equal(record.demo, true)
    assert.equal(record.source, 'demo')
  }
  const cleared = await h.request('POST', '/dsh-pet-ledger/demo-clear', {})
  assert.equal(cleared.json.removed, 4)
  assert.equal((await h.request('GET', '/dsh-pet-ledger/state')).json.demo.length, 0)
  h.dispose()
})

test('a pre-execute recording failure still allows the tool to run', async () => {
  const h = setup()
  const exec = { callId: 'explode', name: 'pwsh', agent: { id: 's1' } }
  Object.defineProperty(exec, 'arguments', {
    get() { throw new Error('arguments exploded') },
  })
  let nextCalls = 0
  const decision = await h.listeners.get('tools/pre-execute')(exec, async function () {
    nextCalls += 1
    return { kind: 'allow' }
  })
  assert.equal(nextCalls, 1)
  assert.deepEqual(decision, { kind: 'allow' })
  h.dispose()
})

test('a long completed turn earns from agent/status and session/event, an aborted one does not', async () => {
  await withClock(T0, async function (advance) {
    const h = setup()
    h.status('running')
    advance(5_000)
    await h.tool('pwsh', { command: 'npm run build' }, { result: 'built' })
    advance(85_000)
    h.turnEnd('completed')
    h.status('idle')
    let state = await h.request('GET', '/dsh-pet-ledger/state')
    assert.equal(state.json.achievements.length, 1)
    assert.equal(state.json.achievements[0].id, 'long-task-1')
    assert.equal(state.json.achievements[0].detail.durationMs, 90_000)
    assert.equal(state.json.achievements[0].evidence.length, 1)
    assert.match(state.json.achievements[0].evidence[0].line, /npm run build/)

    h.status('running')
    advance(90_000)
    h.turnEnd('aborted')
    h.status('idle')
    state = await h.request('GET', '/dsh-pet-ledger/state')
    assert.equal(state.json.achievements.length, 1, 'aborted turn earned nothing')
    assert.equal(state.json.counters.longTasks, 1)
    h.dispose()
  })
})

test('the host generates daily quests from the observed command types', async () => {
  await withClock(T0, async function (advance) {
    const h = setup()
    advance(10_000)
    await h.tool('pwsh', { command: 'npm test' }, { isError: true })
    advance(10_000)
    await h.tool('pwsh', { command: 'npm test' }, { result: 'pass' })
    advance(10_000)
    await h.tool('pwsh', { command: 'git commit -m "x"' })
    const state = await h.request('GET', '/dsh-pet-ledger/state')
    assert.equal(state.json.quests.pending, false)
    assert.ok(state.json.quests.items.length >= 2)
    const types = state.json.quests.basis.commandTypes.map(function (entry) { return entry.type })
    assert.ok(types.indexOf('test') >= 0)
    assert.ok(types.indexOf('commit') >= 0)
    h.dispose()
  })
})

test('a corrupt ledger still boots, records events, and reports the load error', async () => {
  const home = makeHome()
  const dataPath = join(home, 'pet-ledger.json')
  writeFileSync(dataPath, 'not json at all', 'utf8')
  const h = setup({ home: home, dataPath: dataPath })
  await h.tool('pwsh', { command: 'git commit -m "x"' })
  const state = await h.request('GET', '/dsh-pet-ledger/state')
  assert.equal(state.status, 200)
  assert.match(state.json.capture.loadError, /unreadable ledger/)
  assert.equal(state.json.capture.results, 1)
  h.dispose()
})

test('enabled:false records nothing but the panel still answers', async () => {
  await withClock(T0, async function () {
    const h = setup({ config: { enabled: false } })
    await h.tool('pwsh', { command: 'git commit -m "x"' })
    await h.tool('pwsh', { command: 'git push' })
    const state = await h.request('GET', '/dsh-pet-ledger/state')
    assert.equal(state.json.stats.real, 0)
    assert.equal(state.json.capture.results, 0)
    assert.equal(state.json.daily.toolCalls, 0)
    h.dispose()
  })
})

test('webServer registration failure leaves capture alive', async () => {
  const h = setup({ registerThrows: true })
  assert.equal(h.routes.length, 0)
  await h.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { isError: true })
  await h.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { isError: true })
  await h.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { isError: true })
  assert.equal(h.listeners.size > 0, true)
  h.dispose()
  assert.equal(h.listeners.size, 0)
})

test('unload removes the route and listeners and flushes the ledger to disk', async () => {
  await withClock(T0, async function () {
    const h = setup()
    await h.tool('pwsh', { command: 'git commit -m "x"' })
    await h.tool('pwsh', { command: 'git push' })
    assert.equal(h.routes.length, 1)
    h.dispose()
    assert.equal(h.routes.length, 0)
    assert.equal(h.listeners.size, 0)
    assert.equal(existsSync(h.dataPath), true)
    const text = readFileSync(h.dataPath, 'utf8')
    assert.match(text, /commit-push-1/)
  })
})

test('a sessions service that throws only costs the label, not the achievement', async () => {
  await withClock(T0, async function () {
    const h = setup({ getThrows: true })
    await h.tool('pwsh', { command: 'git commit -m "x"' })
    await h.tool('pwsh', { command: 'git push' })
    const state = await h.request('GET', '/dsh-pet-ledger/state')
    assert.equal(state.json.stats.real, 1)
    assert.equal(state.json.achievements[0].sessionLabel, '')
    h.dispose()
  })
})

test('unknown methods, unknown paths and wrong verbs are rejected without a throw', async () => {
  const h = setup()
  assert.equal((await h.request('GET', '/dsh-pet-ledger/nope')).status, 404)
  assert.equal((await h.request('POST', '/dsh-pet-ledger/nope', {})).status, 404)
  assert.equal((await h.request('DELETE', '/dsh-pet-ledger/state')).status, 405)
  assert.equal((await h.request('POST', '/dsh-pet-ledger/demo', undefined, '{not json')).status, 400)
  h.dispose()
})

test('mounting the host twice takes over the file instead of double counting', async () => {
  await withClock(T0, async function () {
    const home = makeHome()
    const dataPath = join(home, 'pet-ledger.json')
    const first = setup({ home: home, dataPath: dataPath })
    await first.tool('pwsh', { command: 'git commit -m "x"' })
    assert.equal(first.routes.length, 1)
    const second = setup({ home: home, dataPath: dataPath })
    assert.equal(first.routes.length, 0, 'the old route is released')
    assert.equal(first.listeners.size, 0, 'the old listeners are released')
    assert.equal(second.routes.length, 1, 'the new instance owns the route')

    await second.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { value: { exitCode: 1 } })
    await second.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { value: { exitCode: 1 } })
    await second.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { value: { exitCode: 1 } })
    const state = await second.request('GET', '/dsh-pet-ledger/state')
    assert.equal(state.json.capture.toolStarts, 3, 'the old instance recorded nothing')
    assert.equal(state.json.stats.real, 1)
    assert.equal(state.json.counters.failureStreakMax, 3)
    second.dispose()
  })
})

test('the route helpers expose the contract the client depends on', () => {
  assert.equal(internals.ROUTE, '/dsh-pet-ledger')
  assert.equal(internals.methodOf('/dsh-pet-ledger'), '')
  assert.equal(internals.methodOf('/dsh-pet-ledger/state'), 'state')
  assert.equal(internals.methodOf('/other/state'), null)
  assert.equal(internals.resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], error: { message: 'c' } }), 'a\nb\nc')
  assert.equal(internals.resultText(undefined), '')
})

test('a failed shell exit code counts even when the tool result is not isError', () => {
  assert.equal(internals.failureOf({ isError: true }), true)
  assert.equal(internals.failureOf({ isError: false, value: { exitCode: 1 } }), true)
  assert.equal(internals.failureOf({ value: { exit_code: 2 } }), true)
  assert.equal(internals.failureOf({ value: { code: -1 } }), true)
  assert.equal(internals.failureOf({ value: { exitCode: 0 } }), false)
  assert.equal(internals.failureOf({ value: { exitCode: '1' } }), false, 'only real numbers count')
  assert.equal(internals.failureOf({ content: [{ type: 'text', text: '[exit code: 1]' }] }), true)
  assert.equal(internals.failureOf({ content: [{ type: 'text', text: 'exit code 1' }] }), false)
  assert.equal(internals.failureOf(null), false)
})

test('three non-zero shell exits earn the failure streak without isError', async () => {
  await withClock(T0, async function () {
    const h = setup()
    await h.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { value: { exitCode: 1 }, result: '[exit code: 1]' })
    await h.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { value: { exitCode: 1 }, result: '[exit code: 1]' })
    await h.tool('pwsh', { command: 'node -e "process.exit(1)"' }, { value: { exitCode: 1 }, result: '[exit code: 1]' })
    const state = await h.request('GET', '/dsh-pet-ledger/state')
    assert.equal(state.json.capture.failures, 3)
    assert.equal(state.json.stats.real, 1)
    assert.equal(state.json.achievements[0].id, 'failure-streak-3')
    h.dispose()
  })
})
