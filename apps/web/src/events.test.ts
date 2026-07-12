import { LEGACY_THREAD_ID, type Event, type EventBody } from '@mce/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDuration, groupTools, initialState, reduce, viewOf, type Item, type ProjectState, type State } from './events.ts'

let seq = 0
/** Events default to thread 'th' in project 'p'; pass a threadId to place elsewhere. */
const at = (body: EventBody, threadId: string | undefined = 'th'): Event =>
  ({ seq: ++seq, sessionId: 's1', projectId: 'p', ...(threadId ? { threadId } : {}), ts: 1, ...body }) as Event

function run(bodies: EventBody[]): State {
  seq = 0
  return bodies.map((b) => at(b)).reduce(reduce, initialState)
}

const view = (state: State): ProjectState => viewOf(state, 'th')
const kinds = (state: State): Item['kind'][] => view(state).items.map((i) => i.kind)

test('a full turn renders in order', () => {
  const state = run([
    { type: 'session_started', claudeSessionId: 'c1', model: 'opus' },
    { type: 'user_prompt', text: 'rename the thing' },
    { type: 'assistant_text', text: 'Looking.' },
    { type: 'tool_use', toolUseId: 't1', name: 'Read', input: { file_path: 'a.ts' } },
    { type: 'tool_result', toolUseId: 't1', ok: true, summary: 'ok' },
    { type: 'turn_complete', costUsd: 0.012 },
  ])

  assert.deepEqual(kinds(state), ['user', 'assistant', 'tool', 'turn'])
  assert.equal(view(state).agent, 'awaiting_input')
  assert.equal(view(state).sessionId, 's1')
})

test('a user_prompt carrying images produces a user item with images populated', () => {
  const images = [{ id: 'a.png', mediaType: 'image/png' as const, size: 123 }]
  const state = run([{ type: 'user_prompt', text: 'what is this?', images }])

  const [item] = view(state).items
  assert.equal(item?.kind, 'user')
  assert.deepEqual(item?.kind === 'user' ? item.images : undefined, images)
})

test('a user_prompt with no images leaves the field absent, not an empty array', () => {
  const state = run([{ type: 'user_prompt', text: 'no images here' }])

  const [item] = view(state).items
  assert.equal(item?.kind, 'user')
  assert.equal(item?.kind === 'user' ? item.images : undefined, undefined)
})

test('tool_result finds its tool_use even with items appended in between', () => {
  const state = run([
    { type: 'tool_use', toolUseId: 't1', name: 'Grep', input: {} },
    { type: 'assistant_text', text: 'meanwhile' },
    { type: 'tool_use', toolUseId: 't2', name: 'Read', input: {} },
    { type: 'tool_result', toolUseId: 't1', ok: false, summary: 'boom' },
  ])

  const items = view(state).items
  assert.equal(items[0]?.kind === 'tool' && items[0].status, 'error')
  assert.equal(items[2]?.kind === 'tool' && items[2].status, 'running')
})

test('approval flows pending -> allowed and releases the agent', () => {
  const state = run([
    { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} },
    { type: 'approval_decision', approvalId: 'a1', allow: true },
  ])

  const card = view(state).items[0]
  assert.equal(card?.kind === 'approval' && card.status, 'allowed')
  assert.equal(view(state).agent, 'thinking')
})

test('agent stays blocked while any approval is still pending', () => {
  const state = run([
    { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} },
    { type: 'approval_request', approvalId: 'a2', toolUseId: 't2', tool: 'Bash', input: {} },
    { type: 'approval_decision', approvalId: 'a1', allow: true },
  ])

  assert.equal(view(state).agent, 'awaiting_approval', 'a2 is still waiting on the user')
})

test('replayed events are idempotent — a reconnect race cannot duplicate a message', () => {
  const first = at({ type: 'assistant_text', text: 'hello' })
  const once = reduce(initialState, first)
  const twice = reduce(once, first)

  assert.equal(viewOf(twice, 'th').items.length, 1)
  assert.equal(twice, once, 'same state object: no re-render')
})

test('an out-of-order low seq is ignored', () => {
  const hi = { seq: 5, sessionId: 's', projectId: 'p', threadId: 'th', ts: 1, type: 'assistant_text', text: 'b' } as Event
  const lo = { seq: 2, sessionId: 's', projectId: 'p', threadId: 'th', ts: 1, type: 'assistant_text', text: 'a' } as Event
  const state = reduce(reduce(initialState, hi), lo)
  assert.deepEqual(viewOf(state, 'th').items.map((i) => (i.kind === 'assistant' ? i.text : '')), ['b'])
  assert.equal(state.lastSeq, 5)
})

test('two threads keep separate views — Phase 2.5 isolation', () => {
  seq = 0
  const events = [
    at({ type: 'user_prompt', text: 'thread A work' }, 'tA'),
    at({ type: 'user_prompt', text: 'thread B work' }, 'tB'),
    at({ type: 'assistant_text', text: 'on B' }, 'tB'),
  ]
  const state = events.reduce(reduce, initialState)

  assert.deepEqual(viewOf(state, 'tA').items.map((i) => i.kind), ['user'])
  assert.deepEqual(viewOf(state, 'tB').items.map((i) => i.kind), ['user', 'assistant'])
  const aFirst = viewOf(state, 'tA').items[0]
  assert.equal(aFirst?.kind === 'user' && aFirst.text, 'thread A work')
  assert.deepEqual(viewOf(state, 'unknown').items, [])
})

test('legacy events (no threadId) collect under the sentinel bucket', () => {
  // Built inline with no threadId at all — `at(body, undefined)` would trigger
  // the default and give it one.
  const legacy = { seq: 1, sessionId: 's1', projectId: 'p', ts: 1, type: 'user_prompt', text: 'old convo' } as Event
  const state = reduce(initialState, legacy)
  assert.deepEqual(viewOf(state, LEGACY_THREAD_ID).items.map((i) => i.kind), ['user'])
})

test('project_created / project_create_failed drive picker signals, not a conversation', () => {
  const state = run([
    { type: 'project_created', name: 'newproj' },
    { type: 'project_create_failed', name: 'badproj', error: 'clone failed' },
  ])
  assert.deepEqual(state.created, ['newproj'])
  assert.equal(state.failed['badproj'], 'clone failed')
})

test('session_ended is terminal and carries its reason', () => {
  const state = run([
    { type: 'session_started', claudeSessionId: 'c1', model: 'opus' },
    { type: 'session_ended', reason: 'interrupted', message: 'Server restarted.' },
  ])
  assert.equal(view(state).agent, 'ended')
  const last = view(state).items.at(-1)
  assert.equal(last?.kind === 'ended' && last.reason, 'interrupted')
})

test('groupTools collapses a consecutive run of tool calls into one row', () => {
  const state = run([
    { type: 'user_prompt', text: 'do it' },
    { type: 'tool_use', toolUseId: 't1', name: 'Read', input: { file_path: 'a.ts' } },
    { type: 'tool_result', toolUseId: 't1', ok: true, summary: 'ok' },
    { type: 'tool_use', toolUseId: 't2', name: 'Edit', input: { file_path: 'a.ts' } },
    { type: 'tool_result', toolUseId: 't2', ok: true, summary: 'ok' },
    { type: 'turn_complete' },
  ])

  const rows = groupTools(view(state).items, false)
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['user', 'toolGroup', 'turn'],
  )
  const group = rows[1]
  assert.equal(group?.kind === 'toolGroup' && group.tools.length, 2)
  assert.equal(group?.kind === 'toolGroup' && group.running, false)
})

test('groupTools marks a trailing group "running" only while the agent is still thinking', () => {
  const state = run([{ type: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'ls' } }])
  const items = view(state).items

  const stillThinking = groupTools(items, true)
  assert.equal(stillThinking[0]?.kind === 'toolGroup' && stillThinking[0].running, true)

  const doneThinking = groupTools(items, false)
  assert.equal(doneThinking[0]?.kind === 'toolGroup' && doneThinking[0].running, false)
})

test('formatDuration renders minutes and seconds, and never "0s"', () => {
  assert.equal(formatDuration(0), '1s')
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(9 * 60_000 + 31_000), '9m 31s')
})
