import type { EventBody, NewEvent } from '@mce/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import { Notifier } from './notifier.ts'
import { Presence } from './presence.ts'
import { Pusher } from './push.ts'
import { PushStore } from './push-store.ts'
import { makeRedactor } from './redact.ts'

const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:x@y.z' }

interface Sent {
  title: string
  body: string
  tag?: string
}

/**
 * A Notifier wired to a fake pusher that records instead of sending. Push is
 * "enabled" (one subscription exists) so the notifier actually runs. Presence
 * starts empty (nobody visible), matching every existing test's expectation
 * that a notification goes out — only the presence-specific tests below mark
 * anyone visible.
 */
function harness(): { log: EventLog; notifier: Notifier; presence: Presence; sent: Sent[] } {
  const db = openDb(':memory:')
  const log = new EventLog(db, makeRedactor([]))
  const store = new PushStore(db)
  store.add({ endpoint: 'https://push/1', keys: { p256dh: 'p', auth: 'a' } }, 1)

  const sent: Sent[] = []
  const pusher = new Pusher(store, VAPID, async (_s, payload) => {
    const p = JSON.parse(payload) as Sent
    sent.push({ title: p.title, body: p.body, tag: p.tag })
    return { statusCode: 201 }
  })

  const presence = new Presence()
  const notifier = new Notifier(log, pusher, presence)
  notifier.start()
  return { log, notifier, presence, sent }
}

// EventBody, not Omit<NewEvent, ...> — Omit does not distribute over a
// discriminated union and collapses every variant to just `{ type }`.
const emit = (log: EventLog, body: EventBody): void => {
  log.append({ sessionId: 's', projectId: 'p', ts: 1, ...body } as NewEvent)
}

/** Approvals debounce over 1500ms; wait past that. */
const DEBOUNCE_WAIT = 1700

test('an approval_request notifies with the SDK-phrased title', async () => {
  const { log, notifier, sent } = harness()

  emit(log, { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {}, title: 'Claude wants to edit foo.ts' })
  await sleep(DEBOUNCE_WAIT)

  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.title, 'Claude needs you')
  assert.equal(sent[0]?.body, 'Claude wants to edit foo.ts')
  assert.equal(sent[0]?.tag, 'approval')
  notifier.stop()
})

test('three approvals in one turn coalesce into a single buzz', async () => {
  const { log, notifier, sent } = harness()

  for (const id of ['a1', 'a2', 'a3']) {
    emit(log, { type: 'approval_request', approvalId: id, toolUseId: id, tool: 'Bash', input: {} })
  }
  await sleep(DEBOUNCE_WAIT)

  assert.equal(sent.length, 1, 'one notification, not three')
  assert.equal(sent[0]?.body, '3 actions waiting for approval')
  notifier.stop()
})

test('approval body never carries the tool input — it would leak to a lock screen', async () => {
  const { log, notifier, sent } = harness()

  // No SDK title, so the fallback runs. It must not echo the command.
  emit(log, { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Bash', input: { command: 'rm -rf /secret' } })
  await sleep(DEBOUNCE_WAIT)

  assert.equal(sent.length, 1)
  assert.doesNotMatch(sent[0]!.body, /rm -rf/, 'no command on the lock screen')
  assert.match(sent[0]!.body, /Bash/)
  notifier.stop()
})

test('turn_complete notifies only when nobody is visible', async () => {
  const { log, notifier, presence, sent } = harness()

  // A visible tab means someone is looking. No notification.
  presence.set('tab-1', true)
  emit(log, { type: 'turn_complete', numTurns: 2 })
  await sleep(50)
  assert.equal(sent.length, 0, 'someone is looking')

  // Backgrounded: nobody visible. Notify.
  presence.set('tab-1', false)
  emit(log, { type: 'turn_complete', numTurns: 3 })
  await sleep(50)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.title, 'Claude finished — p')
  notifier.stop()
})

test('turn_complete body names the thread it finished', async () => {
  const { log, notifier, sent } = harness()

  emit(log, { type: 'user_prompt', text: 'help me refactor the login flow' })
  emit(log, { type: 'turn_complete', numTurns: 1 })
  await sleep(50)

  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.body, '"Refactor the login flow" is ready for your next message.')
  notifier.stop()
})

test('approval_request is suppressed while someone is looking, unlike the old always-notify rule', async () => {
  const { log, notifier, presence, sent } = harness()

  presence.set('tab-1', true)
  emit(log, { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {}, title: 'Claude wants to edit foo.ts' })
  await sleep(DEBOUNCE_WAIT)

  assert.equal(sent.length, 0, 'the agent is blocked, but you are already looking at the card')
  notifier.stop()
})

test('the debounced approval buzz is judged by presence at send time, not at request time', async () => {
  const { log, notifier, presence, sent } = harness()

  // Visible when the tool call comes in...
  presence.set('tab-1', true)
  emit(log, { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} })

  // ...but you glance away before the debounce timer fires.
  presence.set('tab-1', false)
  await sleep(DEBOUNCE_WAIT)

  assert.equal(sent.length, 1, 'evaluated when the buzz actually goes out')
  notifier.stop()
})

test('a second visible tab keeps notifications suppressed after the first goes hidden', async () => {
  const { log, notifier, presence, sent } = harness()

  presence.set('phone', true)
  presence.set('laptop', true)
  presence.set('phone', false)

  emit(log, { type: 'turn_complete', numTurns: 1 })
  await sleep(50)
  assert.equal(sent.length, 0, 'the laptop tab is still visible')
  notifier.stop()
})

test('session_ended notifies on error but not on a clean finish', async () => {
  const { log, notifier, sent } = harness()

  emit(log, { type: 'session_ended', reason: 'complete' })
  emit(log, { type: 'session_ended', reason: 'interrupted', message: 'restart' })
  await sleep(50)
  assert.equal(sent.length, 0, 'complete and interrupted are not errors')

  emit(log, { type: 'session_ended', reason: 'error', message: 'boom' })
  await sleep(50)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.title, 'Claude hit an error — p')
  assert.equal(sent[0]?.body, 'boom')
  notifier.stop()
})

test('a disabled pusher means the notifier never subscribes', async () => {
  const db = openDb(':memory:')
  const log = new EventLog(db, makeRedactor([]))
  const store = new PushStore(db)
  const pusher = new Pusher(store, undefined) // no VAPID
  const notifier = new Notifier(log, pusher, new Presence())
  notifier.start()

  emit(log, { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} })
  await sleep(DEBOUNCE_WAIT)

  // Nothing to assert on the pusher; the point is start() was a no-op and did
  // not attach a listener. subscriberCount stays 0.
  assert.equal(log.subscriberCount, 0)
  notifier.stop()
})
