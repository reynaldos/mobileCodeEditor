import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PreviewTracker } from './preview-tracker.ts'

test('a fresh preview starts in the starting phase', () => {
  const t = new PreviewTracker()
  t.start('p1')
  assert.deepEqual(t.snapshot('p1'), { projectId: 'p1', phase: 'starting', lines: [] })
  assert.equal(t.activeProjectId(), 'p1')
})

test('phase/line updates only apply to the currently active project', () => {
  const t = new PreviewTracker()
  t.start('p1')
  t.phase('p2', 'running') // no-op: p2 isn't the active one
  t.line('p2', 'should not appear')
  assert.deepEqual(t.snapshot('p1'), { projectId: 'p1', phase: 'starting', lines: [] })
  assert.equal(t.snapshot('p2'), undefined)
})

test('line splits on CR/LF, drops empty lines, and buffers oldest-first', () => {
  const t = new PreviewTracker()
  t.start('p1')
  t.line('p1', 'VITE v6 ready\n\n  Local: http://localhost:5173/\r\n')
  assert.deepEqual(t.snapshot('p1')?.lines, ['VITE v6 ready', '  Local: http://localhost:5173/'])
})

test('phase(error) records the message; activeProjectId drops once terminal', () => {
  const t = new PreviewTracker()
  t.start('p1')
  t.phase('p1', 'error', 'dev server did not start listening within 30000ms')
  assert.equal(t.activeProjectId(), undefined)
  assert.deepEqual(t.snapshot('p1'), {
    projectId: 'p1',
    phase: 'error',
    lines: [],
    error: 'dev server did not start listening within 30000ms',
  })
})

test('stopped is terminal too — activeProjectId drops, snapshot survives for a late viewer', () => {
  const t = new PreviewTracker()
  t.start('p1')
  t.phase('p1', 'running')
  t.phase('p1', 'stopped')
  assert.equal(t.activeProjectId(), undefined)
  assert.equal(t.snapshot('p1')?.phase, 'stopped')
})

test('starting a new preview replaces the previous one outright', () => {
  const t = new PreviewTracker()
  t.start('p1')
  t.line('p1', 'p1 booting')
  t.start('p2')
  assert.equal(t.activeProjectId(), 'p2')
  assert.equal(t.snapshot('p1'), undefined)
  assert.deepEqual(t.snapshot('p2'), { projectId: 'p2', phase: 'starting', lines: [] })
})

test('subscribers receive line and phase messages in order, and only for the active project', () => {
  const t = new PreviewTracker()
  t.start('p1')
  const seen: unknown[] = []
  const unsubscribe = t.subscribe('p1', (m) => seen.push(m))

  t.line('p1', 'booting…')
  t.phase('p1', 'running')

  assert.deepEqual(seen, [{ type: 'line', line: 'booting…' }, { type: 'phase', phase: 'running' }])

  unsubscribe()
  t.line('p1', 'after unsubscribe')
  assert.equal(seen.length, 2)
})

test('subscribe on a project that is not the active one is a harmless no-op', () => {
  const t = new PreviewTracker()
  t.start('p1')
  let called = false
  const unsubscribe = t.subscribe('someone-else', () => {
    called = true
  })
  t.line('p1', 'x')
  unsubscribe() // must not throw
  assert.equal(called, false)
})

test('a subscriber that throws does not break delivery to the others', () => {
  const t = new PreviewTracker()
  t.start('p1')
  const seen: unknown[] = []
  t.subscribe('p1', () => {
    throw new Error('dead SSE connection')
  })
  t.subscribe('p1', (m) => seen.push(m))

  t.line('p1', 'still works')
  assert.deepEqual(seen, [{ type: 'line', line: 'still works' }])
})
