// Pure command/tool classification.
//
// Achievements are only allowed to fire on real session events, so the first
// honest question is "what did this tool call actually do?". Nothing here
// guesses: it reads the tool name and the command string the model passed, and
// unknown shapes fall back to a generic kind instead of being promoted to a
// test or a push.

const SHELL_TOOLS = new Set(['bash', 'sh', 'shell', 'pwsh', 'powershell', 'cmd', 'terminal', 'zsh'])

const TOOL_KINDS = {
  read: 'read',
  read_image: 'read',
  write: 'edit',
  edit: 'edit',
  glob: 'search',
  grep: 'search',
  web_fetch: 'web',
  web_search: 'web',
}

// A command that *starts* with an installer is an install even when the package
// name contains a test runner: `pip install pytest` is not a test run.
const RE_INSTALL_START = /^\s*(?:(?:npm|pnpm|yarn)\s+(?:i|install|add)\b|(?:pip|uv)\s+(?:install|add)\b|cargo\s+add\b|go\s+(?:get|mod\s+download)\b)/

// Test runners only. `test` is the kind that can turn red → green; matching it
// too loosely would turn an arbitrary command into an achievement source.
const RE_TEST = /\b(?:node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|npx\s+(?:vitest|jest)|vitest|jest|pytest|python\s+-m\s+pytest|phpunit|rspec|rake\s+test|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|mvn\b[^\n]*\btest|gradlew?\b[^\n]*\btest)\b/

// `gh repo create … --push` publishes too, and that is the exact command the
// delivery contract uses, so it counts as a push. A bare `gh repo create` does
// not.
const RE_PUSH = /\bgit\s+push\b|\bgh\s+repo\s+create\b[^\n]*--push\b/
const RE_COMMIT = /\bgit\s+commit\b/
const RE_INSTALL = /\b(?:(?:npm|pnpm|yarn)\s+(?:i|install|add)\b|pip\s+install\b|uv\s+(?:add|pip\s+install)\b|cargo\s+add\b|go\s+(?:get|mod\s+download)\b)/
const RE_BUILD = /\b(?:node\s+scripts[\\/]build|npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|tsc\b|cargo\s+build|go\s+build|make\b|msbuild\b|dotnet\s+build)\b/
const RE_LINT = /\b(?:eslint|prettier|biome|ruff|flake8|pylint|npm\s+run\s+lint|pnpm\s+(?:run\s+)?lint|yarn\s+(?:run\s+)?lint)\b/
const RE_RUN = /\b(?:npm\s+run\s+dev|pnpm\s+(?:run\s+)?dev|yarn\s+(?:run\s+)?dev|node\s+\S+\.(?:mjs|cjs|js)|uvicorn|flask\s+run|vite\b|next\s+dev|serve\b)/

export function isShellTool(name) {
  return SHELL_TOOLS.has(String(name === undefined || name === null ? '' : name).toLowerCase())
}

/** The command string a shell tool was asked to run, or ''. */
export function commandOf(args) {
  if (args === undefined || args === null || typeof args !== 'object') return ''
  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

function firstString(args) {
  if (args === undefined || args === null || typeof args !== 'object') return ''
  for (const key of ['file_path', 'path', 'pattern', 'url', 'query', 'name', 'description']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

function oneLine(text, max) {
  const flat = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + ' …' : flat
}

/**
 * @param {string} tool
 * @param {unknown} args parsed tool arguments
 * @returns {{kind:string, command:string}}
 */
export function classifyTool(tool, args) {
  const name = String(tool === undefined || tool === null ? '' : tool)
  const command = commandOf(args)
  if (!isShellTool(name)) {
    return { kind: TOOL_KINDS[name] || 'other', command: command }
  }
  const text = command.toLowerCase()
  if (RE_INSTALL_START.test(text)) return { kind: 'install', command: command }
  if (RE_TEST.test(text)) return { kind: 'test', command: command }
  if (RE_PUSH.test(text)) return { kind: 'push', command: command }
  if (RE_COMMIT.test(text)) return { kind: 'commit', command: command }
  if (/\bgh\s+repo\s+create\b/.test(text)) return { kind: 'git', command: command }
  if (RE_INSTALL.test(text)) return { kind: 'install', command: command }
  if (RE_BUILD.test(text)) return { kind: 'build', command: command }
  if (RE_LINT.test(text)) return { kind: 'lint', command: command }
  if (RE_RUN.test(text)) return { kind: 'run', command: command }
  if (/\bgit\b/.test(text)) return { kind: 'git', command: command }
  return { kind: 'shell', command: command }
}

/** One short line that identifies the call in an evidence row. */
export function describeCall(tool, args) {
  const name = String(tool === undefined || tool === null ? '' : tool)
  const command = commandOf(args)
  if (isShellTool(name) && command.length > 0) return oneLine(command, 180)
  const subject = firstString(args)
  if (subject.length > 0) return oneLine(name + ' ' + subject, 180)
  if (args !== undefined && args !== null && typeof args === 'object') {
    try {
      return oneLine(name + ' ' + JSON.stringify(args), 180)
    } catch (error) {
      return oneLine(name, 180)
    }
  }
  return oneLine(name || '(未知工具)', 180)
}

export const COMMAND_KINDS = ['test', 'commit', 'push', 'build', 'install', 'lint', 'run', 'git', 'shell']

export const KIND_LABELS = {
  test: '测试',
  commit: '提交',
  push: '推送',
  build: '构建',
  install: '安装依赖',
  lint: '静态检查',
  run: '运行脚本',
  git: 'Git 操作',
  shell: '命令',
  read: '读文件',
  edit: '改文件',
  search: '搜索',
  web: '联网',
  other: '其他',
}
