import type { EventBody, NewEvent } from '@mce/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import { Notifier } from './notifier.ts'
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
 * "enabled" (one subscription exists) so the notifier actually runs.
 */
function harness(): { log: EventLog; notifier: Notifier; sent: Sent[] } {
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

  const notifier = new Notifier(log, pusher)
  notifier.start()
  return { log, notifier, sent }
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

test('turn_complete notifies only when nobody is watching', async () => {
  const { log, notifier, sent } = harness()

  // A live SSE subscriber means someone is looking. No notification.
  const unsub = log.subscribe(() => {})
  emit(log, { type: 'turn_complete', numTurns: 2 })
  await sleep(50)
  assert.equal(sent.length, 0, 'someone is watching')

  // Backgrounded: no subscribers. Notify.
  unsub()
  emit(log, { type: 'turn_complete', numTurns: 3 })
  await sleep(50)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.title, 'Claude finished')
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
  assert.equal(sent[0]?.title, 'Claude hit an error')
  assert.equal(sent[0]?.body, 'boom')
  notifier.stop()
})

test('a disabled pusher means the notifier never subscribes', async () => {
  const db = openDb(':memory:')
  const log = new EventLog(db, makeRedactor([]))
  const store = new PushStore(db)
  const pusher = new Pusher(store, undefined) // no VAPID
  const notifier = new Notifier(log, pusher)
  notifier.start()

  emit(log, { type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} })
  await sleep(DEBOUNCE_WAIT)

  // Nothing to assert on the pusher; the point is start() was a no-op and did
  // not attach a listener. subscriberCount stays 0.
  assert.equal(log.subscriberCount, 0)
  notifier.stop()
})
