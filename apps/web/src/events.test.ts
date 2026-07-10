import type { Event, EventBody } from '@mce/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialState, isSubscription, reduce, type Item, type State } from './events.ts'

let seq = 0
const at = (body: EventBody): Event =>
  ({ seq: ++seq, sessionId: 's1', projectId: 'p', ts: 1, ...body }) as Event

function run(bodies: EventBody[]): State {
  seq = 0
  return bodies.map(at).reduce(reduce, initialState)
}

const kinds = (state: State): Item['kind'][] => state.items.map((i) => i.kind)

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
  assert.equal(state.agent, 'awaiting_input')
  assert.equal(state.costUsd, 0.012)
  assert.equal(state.sessionId, 's1')
})

test('tool_result finds its tool_use even with items appended in between', () => {
  const state = run([
    { type: 'tool_use', toolUseId: 't1', name: 'Grep', input: {} },
    { type: 'assistant_text', text: 'meanwhile' },
    { type: 'tool_use', toolUseId: 't2', name: 'Read', input: {} },
    { type: 'tool_result', toolUseId: 't1', ok: false, summary: 'boom' },
  ])

  const first = state.items[0]
  const second = state.items[2]
  assert.equal(first?.kind === 'tool' && first.status, 'error')
  assert.equal(first?.kind === 'tool' && first.summary, 'boom')
  assert.equal(second?.kind === 'tool' && second.status, 'running')
})

test('approval flows pending -> allowed and releases the agent', () => {
  const state = run([
    { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} },
    { type: 'approval_decision', approvalId: 'a1', allow: true },
  ])

  const card = state.items[0]
  assert.equal(card?.kind === 'approval' && card.status, 'allowed')
  assert.equal(state.agent, 'thinking')
})

test('agent stays blocked while any approval is still pending', () => {
  const state = run([
    { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} },
    { type: 'approval_request', approvalId: 'a2', toolUseId: 't2', tool: 'Bash', input: {} },
    { type: 'approval_decision', approvalId: 'a1', allow: true },
  ])

  assert.equal(state.agent, 'awaiting_approval', 'a2 is still waiting on the user')
})

test('approval_expired marks the card rather than dropping it', () => {
  const state = run([
    { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Write', input: {} },
    { type: 'approval_expired', approvalId: 'a1' },
  ])

  const card = state.items[0]
  assert.equal(card?.kind === 'approval' && card.status, 'expired')
  assert.equal(state.agent, 'thinking')
})

test('replayed events are idempotent — a reconnect race cannot duplicate a message', () => {
  const first = at({ type: 'assistant_text', text: 'hello' })
  const once = reduce(initialState, first)
  const twice = reduce(once, first)

  assert.equal(twice.items.length, 1)
  assert.equal(twice, once, 'same state object: no re-render')
})

test('an out-of-order low seq is ignored', () => {
  const state = reduce(
    reduce(initialState, { seq: 5, sessionId: 's', projectId: 'p', ts: 1, type: 'assistant_text', text: 'b' }),
    { seq: 2, sessionId: 's', projectId: 'p', ts: 1, type: 'assistant_text', text: 'a' },
  )
  assert.deepEqual(state.items.map((i) => (i.kind === 'assistant' ? i.text : '')), ['b'])
  assert.equal(state.lastSeq, 5)
})

test('an orphan tool_result does not throw', () => {
  const state = run([{ type: 'tool_result', toolUseId: 'ghost', ok: true, summary: 'x' }])
  assert.deepEqual(kinds(state), [])
  assert.equal(state.lastSeq, 1)
})

test('session_ended is terminal and carries its reason', () => {
  const state = run([
    { type: 'session_started', claudeSessionId: 'c1', model: 'opus' },
    { type: 'session_ended', reason: 'interrupted', message: 'Server restarted.' },
  ])

  assert.equal(state.agent, 'ended')
  const last = state.items.at(-1)
  assert.equal(last?.kind === 'ended' && last.reason, 'interrupted')
})

test('apiKeySource=oauth marks the session as subscription-backed, not billed', () => {
  const state = run([
    { type: 'session_started', claudeSessionId: 'c1', model: 'opus', apiKeySource: 'oauth' },
    { type: 'turn_complete', costUsd: 0.239 },
  ])

  assert.equal(state.apiKeySource, 'oauth')
  assert.equal(isSubscription(state.apiKeySource), true)
  // The cost is still tracked — it just isn't a charge.
  assert.equal(state.costUsd, 0.239)
})

test('an API key session is billed, and says so', () => {
  const state = run([{ type: 'session_started', claudeSessionId: 'c1', model: 'opus', apiKeySource: 'user' }])
  assert.equal(isSubscription(state.apiKeySource), false)
})

test('a session_started without apiKeySource does not clobber a known one', () => {
  const state = run([
    { type: 'session_started', claudeSessionId: 'c1', model: 'opus', apiKeySource: 'oauth' },
    { type: 'session_ended', reason: 'interrupted' },
    { type: 'session_started', claudeSessionId: 'c2', model: 'opus' },
  ])
  assert.equal(state.apiKeySource, 'oauth')
})
