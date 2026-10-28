import { strict as assert } from 'node:assert'
import test from 'node:test'
import { classifyTool, commandOf, describeCall, KIND_LABELS } from '../src/commands.js'

function kind(tool, args) {
  return classifyTool(tool, args).kind
}

test('test runners are recognised, and only test runners', () => {
  const commands = [
    'node --test test/*.test.mjs',
    'npm test',
    'npm run test',
    'npm run test:unit',
    'pnpm test',
    'pnpm run test:e2e',
    'yarn test',
    'npx vitest run',
    'vitest run',
    'jest --ci',
    'pytest -q',
    'python -m pytest',
    'go test ./...',
    'cargo test --all',
    'cargo nextest run',
    'dotnet test',
    'mvn -q test',
    './gradlew test',
    'gradle test',
  ]
  for (const command of commands) {
    assert.equal(kind('pwsh', { command: command }), 'test', command)
  }
  assert.equal(kind('pwsh', { command: 'printf hello' }), 'shell')
  assert.equal(kind('pwsh', { command: 'git status' }), 'git')
})

test('push and commit are separate, and gh repo create counts only with --push', () => {
  assert.equal(kind('pwsh', { command: 'git push origin main' }), 'push')
  assert.equal(kind('pwsh', { command: 'gh repo create dsh-pet-ledger --public --source . --push' }), 'push')
  assert.equal(kind('pwsh', { command: 'gh repo create dsh-pet-ledger --public --source .' }), 'git')
  assert.equal(kind('pwsh', { command: 'git commit -m "feat: ledger"' }), 'commit')
  assert.equal(kind('pwsh', { command: 'git push --force' }), 'push')
})

test('install, build, lint and run are classified before the generic git/shell fallback', () => {
  assert.equal(kind('pwsh', { command: 'npm install' }), 'install')
  assert.equal(kind('pwsh', { command: 'pnpm add -D esbuild' }), 'install')
  assert.equal(kind('pwsh', { command: 'pip install pytest' }), 'install')
  assert.equal(kind('pwsh', { command: 'uv add requests' }), 'install')
  assert.equal(kind('pwsh', { command: 'cargo add serde' }), 'install')
  assert.equal(kind('pwsh', { command: 'node scripts/build.mjs' }), 'build')
  assert.equal(kind('pwsh', { command: 'npm run build' }), 'build')
  assert.equal(kind('pwsh', { command: 'tsc --noEmit' }), 'build')
  assert.equal(kind('pwsh', { command: 'npm run lint' }), 'lint')
  assert.equal(kind('pwsh', { command: 'eslint src' }), 'lint')
  assert.equal(kind('pwsh', { command: 'npm run dev' }), 'run')
  assert.equal(kind('pwsh', { command: 'node server.mjs' }), 'run')
  assert.equal(kind('pwsh', { command: 'git status' }), 'git')
  assert.equal(kind('pwsh', { command: 'echo hello' }), 'shell')
})

test('non-shell tools carry their own kind instead of being promoted to a command', () => {
  assert.equal(kind('read', { file_path: 'a.txt' }), 'read')
  assert.equal(kind('read_image', { file_path: 'a.png' }), 'read')
  assert.equal(kind('write', { file_path: 'a.txt', content: 'x' }), 'edit')
  assert.equal(kind('edit', { file_path: 'a.txt' }), 'edit')
  assert.equal(kind('grep', { pattern: 'x' }), 'search')
  assert.equal(kind('glob', { pattern: '**/*.js' }), 'search')
  assert.equal(kind('web_fetch', { url: 'https://example.com' }), 'web')
  assert.equal(kind('mystery', { command: 'rm -rf /' }), 'other')
})

test('a shell command mentioning a test runner in prose is still a test', () => {
  // Deliberately coarse: the consequence of a false test match is one extra
  // achievement candidate, not a false assertion about a test passing — the
  // result's isError is what actually decides red vs green.
  assert.equal(kind('pwsh', { command: 'echo npm test' }), 'test')
})

test('commandOf reads only shell command fields and never invents one', () => {
  assert.equal(commandOf({ command: '  git status  ' }), 'git status')
  assert.equal(commandOf({ cmd: 'dir' }), 'dir')
  assert.equal(commandOf({ script: 'console.log(1)' }), 'console.log(1)')
  assert.equal(commandOf({ command: '   ' }), '')
  assert.equal(commandOf(undefined), '')
  assert.equal(commandOf('git status'), '')
  assert.equal(commandOf({ content: 'git status' }), '')
})

test('evidence lines identify the call without leaking whole payloads', () => {
  assert.equal(describeCall('pwsh', { command: 'node --test\n  test/*.test.mjs' }), 'node --test test/*.test.mjs')
  assert.equal(describeCall('read', { file_path: 'D:\\a\\b.txt' }), 'read D:\\a\\b.txt')
  assert.equal(describeCall('write', { file_path: 'src/a.js', content: 'x'.repeat(500) }), 'write src/a.js')
  assert.equal(describeCall('mystery', { a: 1 }), 'mystery {"a":1}')
  assert.equal(describeCall('empty', undefined), 'empty')
  assert.ok(describeCall('pwsh', { command: 'x'.repeat(500) }).length <= 183)
})

test('every kind the engine can produce has a human label', () => {
  for (const key of ['test', 'commit', 'push', 'build', 'install', 'lint', 'run', 'git', 'shell', 'read', 'edit', 'search', 'web', 'other']) {
    assert.equal(typeof KIND_LABELS[key], 'string')
    assert.ok(KIND_LABELS[key].length > 0)
  }
})
