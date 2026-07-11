import type { Event, EventBody } from '@mce/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialState, reduce, viewOf, type Item, type ProjectState, type State } from './events.ts'

let seq = 0
/** Events default to project 'p'; pass a projectId to place one elsewhere. */
const at = (body: EventBody, projectId = 'p'): Event =>
  ({ seq: ++seq, sessionId: 's1', projectId, ts: 1, ...body }) as Event

function run(bodies: EventBody[]): State {
  seq = 0
  return bodies.map((b) => at(b)).reduce(reduce, initialState)
}

/** The default project's view. */
const view = (state: State): ProjectState => viewOf(state, 'p')
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

test('tool_result finds its tool_use even with items appended in between', () => {
  const state = run([
    { type: 'tool_use', toolUseId: 't1', name: 'Grep', input: {} },
    { type: 'assistant_text', text: 'meanwhile' },
    { type: 'tool_use', toolUseId: 't2', name: 'Read', input: {} },
    { type: 'tool_result', toolUseId: 't1', ok: false, summary: 'boom' },
  ])

  const items = view(state).items
  assert.equal(items[0]?.kind === 'tool' && items[0].status, 'error')
  assert.equal(items[0]?.kind === 'tool' && items[0].summary, 'boom')
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

  assert.equal(viewOf(twice, 'p').items.length, 1)
  assert.equal(twice, once, 'same state object: no re-render')
})

test('an out-of-order low seq is ignored', () => {
  const state = reduce(
    reduce(initialState, { seq: 5, sessionId: 's', projectId: 'p', ts: 1, type: 'assistant_text', text: 'b' }),
    { seq: 2, sessionId: 's', projectId: 'p', ts: 1, type: 'assistant_text', text: 'a' },
  )
  assert.deepEqual(viewOf(state, 'p').items.map((i) => (i.kind === 'assistant' ? i.text : '')), ['b'])
  assert.equal(state.lastSeq, 5)
})

test('a conversation_reset clears that project view — the screen forgets what Claude forgot', () => {
  const state = run([
    { type: 'session_started', claudeSessionId: 'c1', model: 'opus' },
    { type: 'user_prompt', text: 'remember this' },
    { type: 'turn_complete' },
    { type: 'conversation_reset' },
  ])

  assert.deepEqual(kinds(state), [])
  assert.equal(view(state).agent, 'idle')
})

test('replaying the whole log after a reset still shows a fresh view', () => {
  const state = run([
    { type: 'user_prompt', text: 'old' },
    { type: 'conversation_reset' },
    { type: 'session_started', claudeSessionId: 'c2', model: 'opus' },
    { type: 'user_prompt', text: 'new' },
  ])

  assert.deepEqual(kinds(state), ['user'])
  const first = view(state).items[0]
  assert.equal(first?.kind === 'user' && first.text, 'new')
})

test('two projects keep separate views — Phase 2 isolation', () => {
  seq = 0
  const events = [
    at({ type: 'user_prompt', text: 'alpha work' }, 'alpha'),
    at({ type: 'user_prompt', text: 'beta work' }, 'beta'),
    at({ type: 'assistant_text', text: 'on beta' }, 'beta'),
  ]
  const state = events.reduce(reduce, initialState)

  assert.deepEqual(viewOf(state, 'alpha').items.map((i) => i.kind), ['user'])
  assert.deepEqual(viewOf(state, 'beta').items.map((i) => i.kind), ['user', 'assistant'])
  const alphaFirst = viewOf(state, 'alpha').items[0]
  assert.equal(alphaFirst?.kind === 'user' && alphaFirst.text, 'alpha work')
  // A project with no events at all is an empty view, not undefined.
  assert.deepEqual(viewOf(state, 'gamma').items, [])
})

test('project_created / project_create_failed drive the picker signals, not a conversation', () => {
  const state = run([
    { type: 'project_created', name: 'newproj' },
    { type: 'project_create_failed', name: 'badproj', error: 'clone failed' },
  ])

  assert.deepEqual(state.created, ['newproj'])
  assert.equal(state.failed['badproj'], 'clone failed')
  // These are not conversation events — no project view got items.
  assert.deepEqual(viewOf(state, 'newproj').items, [])
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
