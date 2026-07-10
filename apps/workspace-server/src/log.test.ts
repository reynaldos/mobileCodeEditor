import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AsyncQueue } from './async-queue.ts'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import { makeRedactor } from './redact.ts'

const noRedact = makeRedactor([])

function freshLog(redactor = noRedact): EventLog {
  return new EventLog(openDb(':memory:'), redactor)
}

function text(log: EventLog, body: string, sessionId = 's1') {
  return log.append({ sessionId, projectId: 'p', ts: 1, type: 'assistant_text', text: body })
}

test('seq is global and monotonic from 1', () => {
  const log = freshLog()
  assert.equal(log.lastSeq(), 0)
  assert.equal(text(log, 'a').seq, 1)
  assert.equal(text(log, 'b', 's2').seq, 2) // different session, same seq space
  assert.equal(log.lastSeq(), 2)
})

test('replaySince is strictly greater than seq — the off-by-one that duplicates a message', () => {
  const log = freshLog()
  text(log, 'a')
  text(log, 'b')
  text(log, 'c')

  assert.deepEqual(log.replaySince(0).map((e) => e.seq), [1, 2, 3])
  assert.deepEqual(log.replaySince(2).map((e) => e.seq), [3])
  assert.deepEqual(log.replaySince(3).map((e) => e.seq), [])
})

test('round-trips the discriminated union intact', () => {
  const log = freshLog()
  log.append({
    sessionId: 's1',
    projectId: 'p',
    ts: 7,
    type: 'approval_request',
    approvalId: 'a1',
    toolUseId: 'tu1',
    tool: 'Edit',
    input: { file_path: 'x.ts' },
    title: 'Claude wants to edit x.ts',
  })

  const [event] = log.replaySince(0)
  assert.equal(event?.type, 'approval_request')
  assert.equal(event?.seq, 1)
  assert.equal(event?.sessionId, 's1')
  assert.deepEqual(event?.type === 'approval_request' ? event.input : null, { file_path: 'x.ts' })
})

test('subscribers see appends; unsubscribe stops them', () => {
  const log = freshLog()
  const seen: number[] = []
  const unsubscribe = log.subscribe((e) => seen.push(e.seq))

  text(log, 'a')
  text(log, 'b')
  unsubscribe()
  text(log, 'c')

  assert.deepEqual(seen, [1, 2])
  assert.equal(log.subscriberCount, 0)
})

test('a throwing subscriber does not stop the others or the append', () => {
  const log = freshLog()
  const seen: number[] = []
  log.subscribe(() => {
    throw new Error('dead SSE connection')
  })
  log.subscribe((e) => seen.push(e.seq))

  assert.equal(text(log, 'a').seq, 1)
  assert.deepEqual(seen, [1])
})

test('pendingApprovals excludes decided and expired', () => {
  const log = freshLog()
  const base = { sessionId: 's1', projectId: 'p', ts: 1 } as const

  log.append({ ...base, type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Bash', input: {} })
  log.append({ ...base, type: 'approval_request', approvalId: 'a2', toolUseId: 't2', tool: 'Edit', input: {} })
  log.append({ ...base, type: 'approval_request', approvalId: 'a3', toolUseId: 't3', tool: 'Write', input: {} })
  log.append({ ...base, type: 'approval_decision', approvalId: 'a1', allow: true })
  log.append({ ...base, type: 'approval_expired', approvalId: 'a2' })

  assert.deepEqual(log.pendingApprovals().map((a) => a.approvalId), ['a3'])
})

test('openSessions finds sessions that started and never ended', () => {
  const log = freshLog()
  const at = (sessionId: string) => ({ sessionId, projectId: 'p', ts: 1 }) as const

  log.append({ ...at('s1'), type: 'session_started', claudeSessionId: 'c1', model: 'm' })
  log.append({ ...at('s2'), type: 'session_started', claudeSessionId: 'c2', model: 'm' })
  log.append({ ...at('s1'), type: 'session_ended', reason: 'complete' })

  assert.deepEqual(log.openSessions().map((s) => s.sessionId), ['s2'])
  assert.equal(log.claudeSessionIdOf('s2'), 'c2')
  assert.equal(log.claudeSessionIdOf('nope'), undefined)
})

test('redaction scrubs known secrets and token shapes before write', () => {
  const log = freshLog(makeRedactor(['hunter2-hunter2']))
  text(log, 'literal hunter2-hunter2, key sk-ant-api03-AbCdEf1234567890, pat ghp_ABCDEFGHIJKLMNOPQRST1234')

  const [event] = log.replaySince(0)
  const stored = event?.type === 'assistant_text' ? event.text : ''
  assert.ok(!stored.includes('hunter2-hunter2'), 'literal secret leaked')
  assert.ok(!stored.includes('sk-ant-api03'), 'anthropic key shape leaked')
  assert.ok(!stored.includes('ghp_'), 'github pat shape leaked')
  assert.equal(stored, 'literal [redacted], key [redacted], pat [redacted]')
})

test('AsyncQueue yields pushed items then ends on close', async () => {
  const queue = new AsyncQueue<number>()
  queue.push(1)
  queue.push(2)

  const drained: number[] = []
  const consumer = (async () => {
    for await (const n of queue) drained.push(n)
  })()

  await new Promise((r) => setImmediate(r))
  queue.push(3)
  await new Promise((r) => setImmediate(r))
  queue.close()
  await consumer

  assert.deepEqual(drained, [1, 2, 3])
  assert.throws(() => queue.push(4), /push after close/)
})
