// Client half of dsh-pet-ledger: the 宠物账本 tab in the conversation view.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness.
//
// The panel renders a snapshot it did not compute. Every achievement, evidence
// row and quest comes from GET /dsh-pet-ledger, which the host folds from real
// harness events. The client never awards anything, never increments a counter,
// and never turns a demo record into a real one.

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-pet-ledger'
const POLL_MS = 1500

let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-pet-ledger] listener failed', error)
    }
  })
}

function load() {
  return fetch(API + '/state', { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) {
      snap = { data: data, error: '', at: Date.now() }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
}

function post(method) {
  return fetch(API + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then(function (res) { return res.json() }).then(function () { return load() }).catch(function () {
    return load()
  })
}

function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

// ---------------------------------------------------------------- pure helpers

function pad(value) {
  return value < 10 ? '0' + value : String(value)
}

function clock(at) {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

function shortDate(at) {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  return (date.getMonth() + 1) + '月' + date.getDate() + '日'
}

function humanDuration(ms) {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (value < 1000) return value + 'ms'
  if (value < 60_000) return (value / 1000).toFixed(1) + 's'
  const minutes = Math.round(value / 60_000)
  if (minutes < 60) return minutes + ' 分钟'
  const hours = value / 3_600_000
  return hours.toFixed(1) + ' 小时'
}

function humanActive(ms) {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (value <= 0) return '0 分钟'
  if (value < 60_000) return '不到 1 分钟'
  return Math.round(value / 60_000) + ' 分钟'
}

const TIER_LABEL = { bronze: '铜', silver: '银', gold: '金' }

function tierLabel(tier) {
  return TIER_LABEL[tier] || '铜'
}

function achievementCounts(data) {
  const list = data && Array.isArray(data.achievements) ? data.achievements : []
  const counts = {}
  for (const item of list) counts[item.family] = (counts[item.family] || 0) + 1
  return counts
}

function proofSummary(data) {
  const stats = (data && data.stats) || {}
  return {
    real: stats.real || 0,
    evidence: stats.evidenceRows || 0,
    demo: stats.demo || 0,
  }
}

// -------------------------------------------------------------------- renderers

function Pet() {
  return h('div', { className: 'pl-pet-wrap' },
    h('svg', {
      className: 'pl-pet',
      viewBox: '0 0 96 96',
      role: 'img',
      'aria-label': '账本精灵',
    },
      h('defs', null,
        h('radialGradient', { id: 'pl-glow', cx: '35%', cy: '28%', r: '78%' },
          h('stop', { offset: '0%', stopColor: 'var(--pl-brand)', stopOpacity: '0.85' }),
          h('stop', { offset: '100%', stopColor: 'var(--pl-success)', stopOpacity: '0.45' }),
        ),
      ),
      h('circle', { cx: '48', cy: '48', r: '38', fill: 'none', stroke: 'var(--pl-line, currentColor)', strokeOpacity: '0.22' }),
      h('circle', { cx: '48', cy: '47', r: '31', fill: 'url(#pl-glow)', opacity: '0.16' }),
      h('path', { d: 'M25 27 L20 10 L38 20 Z', fill: 'var(--pl-brand)', opacity: '0.5' }),
      h('path', { d: 'M71 27 L76 10 L58 20 Z', fill: 'var(--pl-brand)', opacity: '0.5' }),
      h('circle', { cx: '48', cy: '44', r: '24', fill: 'var(--pl-surface, #fff)', stroke: 'var(--pl-line, currentColor)', strokeOpacity: '0.35', strokeWidth: '1.2' }),
      h('circle', { cx: '39', cy: '42', r: '3.1', fill: 'currentColor' }),
      h('circle', { cx: '57', cy: '42', r: '3.1', fill: 'currentColor' }),
      h('path', { d: 'M41 52 Q48 57 55 52', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', opacity: '0.8' }),
      h('rect', { x: '30', y: '62', width: '36', height: '20', rx: '4', fill: 'var(--pl-surface, #fff)', stroke: 'var(--pl-line, currentColor)', strokeOpacity: '0.3' }),
      h('path', { d: 'M37 68 H59 M37 73 H55 M37 78 H59', stroke: 'currentColor', strokeOpacity: '0.4', strokeWidth: '1.4', strokeLinecap: 'round' }),
      h('path', { d: 'M60 20 L60 34 L55 30 L50 34 L50 20 Z', fill: 'var(--pl-warn)', opacity: '0.85' }),
    ),
    h('span', { className: 'pl-pet-shadow' }),
  )
}

function Stat(props) {
  return h('div', { className: 'pl-stat' },
    h('b', null, props.value),
    h('span', null, props.label),
  )
}

function Quest(props) {
  const quest = props.quest
  const progress = quest.progress || { done: 0, target: 0, percent: 0, complete: false, unit: 'count' }
  const doneText = progress.unit === 'ms'
    ? humanDuration(progress.done) + ' / ' + humanDuration(progress.target)
    : String(progress.done) + ' / ' + String(progress.target)
  return h('div', { className: 'pl-quest' + (progress.complete ? ' pl-quest-done' : ''), 'data-quest-id': quest.id },
    h('div', { className: 'pl-quest-top' },
      h('span', { className: 'pl-quest-kind' }, quest.kind === 'focus' ? '专注' : '命令'),
      progress.complete ? h('span', { className: 'pl-quest-done-tag' }, '已完成') : null,
    ),
    h('div', { className: 'pl-quest-title' }, quest.title),
    h('div', { className: 'pl-quest-desc' }, quest.desc),
    h('div', { className: 'pl-bar', role: 'progressbar', 'aria-valuenow': String(progress.percent), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      h('i', { style: { width: Math.max(2, progress.percent) + '%' } }),
    ),
    h('div', { className: 'pl-quest-foot' }, doneText),
  )
}

function EvidenceRow(props) {
  const row = props.row
  const cls = row.ok ? 'pl-ev-ok' : 'pl-ev-fail'
  return h('div', { className: 'pl-ev ' + cls, 'data-evidence-call': row.callId },
    h('div', { className: 'pl-ev-time' }, clock(row.at)),
    h('div', null,
      h('div', { className: 'pl-ev-line' }, row.line || row.tool || '(未知工具)'),
      row.result ? h('div', { className: 'pl-ev-result' }, row.result) : null,
      h('div', { className: 'pl-ev-meta' },
        (row.ok ? '成功' : '失败') + ' · ' + row.tool + (row.kind ? ' · ' + row.kind : '') + (row.ms ? ' · ' + humanDuration(row.ms) : ''),
      ),
    ),
  )
}

function AchievementCard(props) {
  const record = props.record
  const expanded = props.expanded
  const demo = record.demo === true || record.source === 'demo'
  const detail = record.detail && typeof record.detail === 'object' ? record.detail : null
  const duration = detail && Number.isFinite(detail.durationMs) ? detail.durationMs : 0
  return h('button', {
    type: 'button',
    className: 'pl-card' + (demo ? ' pl-demo' : '') + (expanded ? ' pl-card-open' : ''),
    'data-achievement-id': record.id,
    'data-demo': demo ? 'true' : 'false',
    'data-expanded': expanded ? 'true' : 'false',
    'aria-expanded': expanded ? 'true' : 'false',
    onClick: function () { props.onToggle(record.id) },
  },
    demo ? h('span', { className: 'pl-watermark' }, record.watermark || '演示') : null,
    h('div', { className: 'pl-card-top' },
      h('span', { className: 'pl-dot pl-dot-' + (record.tier || 'bronze') }),
      h('span', { className: 'pl-card-title' }, record.title),
      h('span', { className: 'pl-card-time' }, shortDate(record.at) + ' ' + clock(record.at)),
    ),
    h('div', { className: 'pl-card-desc' }, record.desc),
    h('div', { className: 'pl-card-meta' },
      h('span', null, record.familyLabel || record.family),
      h('span', null, tierLabel(record.tier) + '级'),
      h('span', null, (record.evidence ? record.evidence.length : 0) + ' 条证据'),
      duration > 0 ? h('span', null, '本次 ' + humanDuration(duration)) : null,
    ),
    expanded ? h('div', { className: 'pl-evidence' },
      h('div', { className: 'pl-evidence-head' },
        h('span', { className: 'pl-evidence-label' }, '证据链'),
        h('code', null, record.sessionId || 'unattributed'),
        record.sessionLabel ? h('span', { className: 'pl-evidence-path' }, record.sessionLabel) : null,
        demo ? h('span', { className: 'pl-evidence-demo' }, '演示态 · 不计入真实成就') : null,
      ),
      (record.evidence || []).length === 0
        ? h('div', { className: 'pl-ev-empty' }, '这次任务没有留下工具调用；时长与结束原因来自真实的 agent/status 与 session/event。')
        : h('div', { className: 'pl-ev-list' }, (record.evidence || []).map(function (row) {
          return h(EvidenceRow, { key: row.callId + '-' + row.at, row: row })
        })),
    ) : null,
  )
}

function Empty(props) {
  return h('div', { className: 'pl-empty' }, props.children)
}

function LedgerView() {
  const [state, setState] = React.useState(snap)
  const [expanded, setExpanded] = React.useState('')
  const [filter, setFilter] = React.useState('all')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(function () { return subscribe(setState) }, [])

  const data = state.data
  const error = state.error
  const stats = (data && data.stats) || {}
  const daily = (data && data.daily) || {}
  const quests = (data && data.quests) || { pending: true, items: [], reason: '正在读取今日真实使用记录…' }
  const achievements = data && Array.isArray(data.achievements) ? data.achievements : []
  const demo = data && Array.isArray(data.demo) ? data.demo : []
  const families = data && Array.isArray(data.families) ? data.families : []
  const counts = achievementCounts(data)
  const proof = proofSummary(data)
  const filtered = filter === 'all'
    ? achievements
    : achievements.filter(function (record) { return record.family === filter })

  function toggle(id) {
    setExpanded(function (previous) { return previous === id ? '' : id })
  }

  function run(method) {
    setBusy(true)
    post(method).then(function () { setBusy(false) })
  }

  if (data === null) {
    return h('div', { className: 'pl-root', 'data-pet-ledger': 'loading' },
      h('div', { className: 'pl-loading' }, error ? '与 host 通信失败：' + error : '正在读取真实事件账本…'),
    )
  }

  return h('div', { className: 'pl-root', 'data-pet-ledger': 'ready', 'data-pet-day': data.day || '' },
    h('header', { className: 'pl-hero' },
      h(Pet, null),
      h('div', { className: 'pl-hero-copy' },
        h('div', { className: 'pl-kicker' }, 'PET LEDGER · 真实事件账本'),
        h('h1', { className: 'pl-title' }, '宠物账本'),
        h('p', { className: 'pl-sub' }, '成就只从真实会话事件里长出来：连续失败、长任务完成、测试红转绿、提交并推送。每条都能点开看当时的会话与工具调用。'),
      ),
      h('div', { className: 'pl-stats' },
        h(Stat, { label: '真实成就', value: String(proof.real) }),
        h(Stat, { label: '证据行', value: String(proof.evidence) }),
        h(Stat, { label: '今日有效使用', value: humanActive(daily.activeMs) }),
        h(Stat, { label: '连续失败峰值', value: String((data.counters && data.counters.failureStreakMax) || 0) }),
      ),
    ),

    error ? h('div', { className: 'pl-error' }, '与 host 通信失败：' + error + '（下面展示的是最后一次成功读取的快照）') : null,

    h('section', { className: 'pl-section' },
      h('div', { className: 'pl-section-head' },
        h('h2', { className: 'pl-section-title' }, '今日任务'),
        h('span', { className: 'pl-note' }, '按今天的真实使用时长与实际跑过的命令类型生成，不是固定清单'),
        h('div', { className: 'pl-spacer' }),
        h('span', { className: 'pl-updated' }, '更新于 ' + clock(state.at)),
      ),
      quests.pending
        ? h(Empty, null, quests.reason || '今天还没有足够的真实使用记录。')
        : h('div', null,
          h('div', { className: 'pl-quests' }, (quests.items || []).map(function (quest) {
            return h(Quest, { key: quest.id, quest: quest })
          })),
          quests.basis ? h('div', { className: 'pl-basis' },
            '生成依据：今日 ' + humanActive(quests.basis.activeMs) + ' 有效使用 · ' + String(quests.basis.toolCalls) + ' 次工具调用' +
            ((quests.basis.commandTypes || []).length > 0
              ? ' · ' + quests.basis.commandTypes.map(function (entry) { return entry.label + '×' + entry.count }).join(' · ')
              : ''),
          ) : null,
        ),
    ),

    h('section', { className: 'pl-section' },
      h('div', { className: 'pl-section-head' },
        h('h2', { className: 'pl-section-title' }, '成就墙'),
        h('span', { className: 'pl-note' }, '点开一条看证据；没有证据的成就不会出现'),
        h('div', { className: 'pl-spacer' }),
        h('div', { className: 'pl-chips' },
          h('button', {
            type: 'button',
            className: 'pl-chip',
            'aria-pressed': filter === 'all' ? 'true' : 'false',
            onClick: function () { setFilter('all') },
          }, '全部 ' + achievements.length),
          families.map(function (family) {
            return h('button', {
              type: 'button',
              key: family.key,
              className: 'pl-chip',
              'aria-pressed': filter === family.key ? 'true' : 'false',
              onClick: function () { setFilter(family.key) },
            }, family.label + ' ' + (counts[family.key] || 0))
          }),
        ),
      ),
      filtered.length === 0
        ? h(Empty, null,
          achievements.length === 0
            ? '还没有真实成就。跑工具、修一次测试、提交并推送之后，这里会自己长出来——不需要手动点亮。'
            : '这个分类还没有真实成就。',
        )
        : h('div', { className: 'pl-grid' }, filtered.map(function (record) {
          return h(AchievementCard, {
            key: record.id,
            record: record,
            expanded: expanded === record.id,
            onToggle: toggle,
          })
        })),
    ),

    h('section', { className: 'pl-section pl-demo-section' },
      h('div', { className: 'pl-section-head' },
        h('h2', { className: 'pl-section-title' }, '演示样张'),
        h('span', { className: 'pl-note' }, '只用于预览卡片样式；每条都带「演示」水印，不计入成就、不写入本机账本'),
        h('div', { className: 'pl-spacer' }),
        h('button', { type: 'button', className: 'pl-btn', onClick: function () { run('demo') }, disabled: busy }, '生成演示样张'),
        demo.length > 0
          ? h('button', { type: 'button', className: 'pl-btn', onClick: function () { run('demo-clear') }, disabled: busy }, '清除演示')
          : null,
      ),
      demo.length === 0
        ? h(Empty, null, '还没有演示样张。点「生成演示样张」可以看到带水印的卡片长什么样——它不会变成真实成就。')
        : h('div', { className: 'pl-grid' }, demo.map(function (record) {
          return h(AchievementCard, {
            key: record.id,
            record: record,
            expanded: expanded === record.id,
            onToggle: toggle,
          })
        })),
    ),

    h('footer', { className: 'pl-footer' },
      h('span', null, '真实成就来自 tools/result、agent/status 与 session/event；演示记录只存在内存里。'),
      data.dataPath ? h('code', { className: 'pl-path' }, data.dataPath) : null,
    ),
  )
}

function apply(ctx) {
  // dsh can unload a plugin at runtime, so the shared poll has an explicit
  // teardown instead of relying on React unmount.
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-pet-ledger'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  // A changed slot contract degrades this one panel and says so; it must not
  // abort the client boot for every other plugin in the graph.
  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'pet-ledger', order: 45, label: '宠物账本' },
        LedgerView,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-pet-ledger] could not register the 宠物账本 view; the host ledger still records events', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-pet-ledger',
  inject: ['slots'],
  apply: apply,
  __test: {
    clock: clock,
    shortDate: shortDate,
    humanDuration: humanDuration,
    humanActive: humanActive,
    tierLabel: tierLabel,
    achievementCounts: achievementCounts,
    proofSummary: proofSummary,
    load: load,
  },
}
