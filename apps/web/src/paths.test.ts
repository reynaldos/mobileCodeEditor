import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeTool, relativePath, targetOf } from './paths.ts'

// Paths from the agent look like /data/projects/<id>/... ; the client strips
// everything through `/<projectId>/`, since it no longer knows the absolute root.
const ID = 'fitnessTracker'
const ABS = `/data/projects/${ID}`

test('paths render relative to the project directory', () => {
  assert.equal(relativePath(`${ABS}/app/(app)/settings/page.tsx`, ID), 'app/(app)/settings/page.tsx')
  assert.equal(relativePath(`${ABS}/`, ID), '.')
})

test('without a projectId the path is left absolute', () => {
  assert.equal(relativePath('/etc/hosts', undefined), '/etc/hosts')
})

test('a path not under the project is left absolute', () => {
  assert.equal(relativePath('/etc/hosts', ID), '/etc/hosts')
})

test('targetOf finds the first path-ish field', () => {
  assert.equal(targetOf({ file_path: 'a.ts' }), 'a.ts')
  assert.equal(targetOf({ command: 'ls -la' }), 'ls -la')
  assert.equal(targetOf({ replace_all: false }), undefined)
  assert.equal(targetOf(null), undefined)
})

test('describeTool names the file when the SDK gives us no title', () => {
  assert.equal(describeTool('Edit', { file_path: `${ABS}/app/page.tsx` }, ID), 'Edit app/page.tsx')
  assert.equal(describeTool('Bash', { command: 'rm -rf build' }, ID), 'Claude wants to run: rm -rf build')
  assert.equal(describeTool('WebFetch', {}, ID), 'Claude wants to run WebFetch')
})
