import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffSubjectOf, lineDiff } from './diff.ts'

const render = (before: string, after: string): string[] =>
  lineDiff(before, after).map((r) => `${r.kind[0]} ${r.text}`)

test('a single changed line shows one removal and one addition', () => {
  assert.deepEqual(render('a\nb\nc', 'a\nB\nc'), ['c a', 'r b', 'a B', 'c c'])
})

test('pure insertion has no removals', () => {
  const rows = lineDiff('a\nc', 'a\nb\nc')
  assert.deepEqual(rows.filter((r) => r.kind === 'removed'), [])
  assert.deepEqual(rows.filter((r) => r.kind === 'added').map((r) => r.text), ['b'])
})

test('long unchanged runs collapse to a gap', () => {
  const before = ['x', ...Array.from({ length: 20 }, (_, i) => `line ${i}`), 'y'].join('\n')
  const after = before.replace('x', 'X')
  const rows = lineDiff(before, after)

  const gaps = rows.filter((r) => r.kind === 'gap')
  assert.equal(gaps.length, 1)
  assert.match(gaps[0]!.text, /unchanged lines/)
  assert.ok(rows.length < 25, 'the whole file should not be rendered')
})

test('identical input renders as all context, no gap', () => {
  const rows = lineDiff('a\nb', 'a\nb')
  assert.deepEqual(rows.map((r) => r.kind), ['context', 'context'])
})

test('Edit input yields a diff subject from old_string/new_string', () => {
  const subject = diffSubjectOf('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })
  assert.deepEqual(subject, { filePath: 'a.ts', before: 'x', after: 'y' })
})

test('Write input diffs against an empty file', () => {
  const subject = diffSubjectOf('Write', { file_path: 'new.ts', content: 'hello' })
  assert.deepEqual(subject, { filePath: 'new.ts', before: '', after: 'hello' })
})

test('Bash has no diff subject — it renders as a command', () => {
  assert.equal(diffSubjectOf('Bash', { command: 'ls -la' }), undefined)
  assert.equal(diffSubjectOf('Edit', { file_path: 'a.ts' }), undefined, 'incomplete Edit input')
})
