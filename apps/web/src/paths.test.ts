import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeTool, relativePath, targetOf } from './paths.ts'

const ROOT = '/Users/rey/Documents/fitnessTracker'

test('paths render relative to the project root', () => {
  assert.equal(relativePath(`${ROOT}/app/(app)/settings/page.tsx`, ROOT), 'app/(app)/settings/page.tsx')
  assert.equal(relativePath(ROOT, ROOT), '.')
})

test('a path outside the project is left absolute rather than mangled', () => {
  assert.equal(relativePath('/etc/hosts', ROOT), '/etc/hosts')
  assert.equal(relativePath('/etc/hosts', undefined), '/etc/hosts')
})

test('a sibling directory sharing the prefix is not treated as inside', () => {
  // A naive startsWith turns this into `-old/app/page.tsx`, which is a lie.
  const sibling = `${ROOT}-old/app/page.tsx`
  assert.equal(relativePath(sibling, ROOT), sibling)
})

test('targetOf finds the first path-ish field', () => {
  assert.equal(targetOf({ file_path: 'a.ts' }), 'a.ts')
  assert.equal(targetOf({ command: 'ls -la' }), 'ls -la')
  assert.equal(targetOf({ replace_all: false }), undefined)
  assert.equal(targetOf(null), undefined)
})

test('describeTool names the file when the SDK gives us no title', () => {
  assert.equal(
    describeTool('Edit', { file_path: `${ROOT}/app/page.tsx` }, ROOT),
    'Edit app/page.tsx',
  )
  assert.equal(describeTool('Bash', { command: 'rm -rf build' }, ROOT), 'Claude wants to run: rm -rf build')
  assert.equal(describeTool('WebFetch', {}, ROOT), 'Claude wants to run WebFetch')
})
