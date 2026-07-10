import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Config } from './config.ts'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import { makeRedactor } from './redact.ts'
import type { QueryFn } from './session.ts'
import { SessionManager } from './session-manager.ts'

const CONFIG: Config = {
  port: 0,
  host: '127.0.0.1',
  dbPath: ':memory:',
  projectPath: tmpdir(),
  projectId: 'test',
  claudeToken: 'test-token',
  model: undefined,
  isDev: true,
  webDist: '/nonexistent',
}

const init = (sessionId: string): SDKMessage =>
  ({ type: 'system', subtype: 'init', session_id: sessionId, model: 'opus' }) as unknown as SDKMessage

const done = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1 }) as unknown as SDKMessage

/** Records the `resume` option every started session was given. */
function recordingQuery(claudeSessionIds: string[]): {
  queryFn: QueryFn
  resumes: Array<string | undefined>
} {
  const resumes: Array<string | undefined> = []
  let n = 0

  const queryFn = ((params: {
    prompt: AsyncIterable<unknown>
    options: { resume?: string }
  }) => {
    resumes.push(params.options.resume)
    const claudeSessionId = claudeSessionIds[n++] ?? `claude-${n}`

    return (async function* () {
      yield init(claudeSessionId)
      for await (const _ of params.prompt) yield done()
    })() as unknown as Query
  }) as unknown as QueryFn

  return { queryFn, resumes }
}

function makeLog(): EventLog {
  return new EventLog(openDb(':memory:'), makeRedactor([]))
}

async function waitFor(predicate: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await sleep(5)
  }
}

const startedCount = (log: EventLog): number =>
  log.replaySince(0).filter((e) => e.type === 'session_started').length

// ---------------------------------------------------------------------------

test('the first prompt ever starts a fresh conversation', async () => {
  const log = makeLog()
  const { queryFn, resumes } = recordingQuery(['claude-1'])
  const manager = new SessionManager(log, CONFIG, queryFn)

  await manager.prompt('hello')
  await waitFor(() => startedCount(log) === 1, 'session_started')

  assert.deepEqual(resumes, [undefined])
  await manager.shutdown()
})

test('a restart resumes the last conversation — the whole point of this', async () => {
  const log = makeLog()

  // First process: one conversation, then a clean shutdown.
  const first = recordingQuery(['claude-1'])
  const before = new SessionManager(log, CONFIG, first.queryFn)
  await before.prompt('rename the function')
  await waitFor(() => startedCount(log) === 1, 'first session')
  await before.shutdown()

  // Second process, same log. This is `node --watch` restarting.
  const second = recordingQuery(['claude-1'])
  const after = new SessionManager(log, CONFIG, second.queryFn)
  after.recoverOnBoot()

  assert.equal(after.resumableConversationId, 'claude-1')
  await after.prompt('now do the same in the other file')
  await waitFor(() => startedCount(log) === 2, 'second session')

  assert.deepEqual(second.resumes, ['claude-1'], 'the new session continues the old conversation')
  await after.shutdown()
})

test('a crash resumes exactly as well as a clean exit', async () => {
  const log = makeLog()

  const first = recordingQuery(['claude-1'])
  const before = new SessionManager(log, CONFIG, first.queryFn)
  await before.prompt('go')
  await waitFor(() => startedCount(log) === 1, 'first session')
  // No shutdown(): the process died. session_started has no session_ended.

  const second = recordingQuery(['claude-1'])
  const after = new SessionManager(log, CONFIG, second.queryFn)
  after.recoverOnBoot()

  // Boot recovery closed the orphan session...
  const ended = log.replaySince(0).filter((e) => e.type === 'session_ended')
  assert.equal(ended.length, 1)
  assert.equal(ended[0]?.type === 'session_ended' && ended[0].reason, 'interrupted')

  // ...and the conversation is still resumable.
  await after.prompt('carry on')
  await waitFor(() => startedCount(log) === 2, 'second session')
  assert.deepEqual(second.resumes, ['claude-1'])

  await before.shutdown()
  await after.shutdown()
})

test('fresh: true starts a new conversation and does not resume', async () => {
  const log = makeLog()
  const { queryFn, resumes } = recordingQuery(['claude-1', 'claude-2'])
  const manager = new SessionManager(log, CONFIG, queryFn)

  await manager.prompt('first thing')
  await waitFor(() => startedCount(log) === 1, 'first session')

  await manager.prompt('forget all that', { fresh: true })
  await waitFor(() => startedCount(log) === 2, 'second session')

  assert.deepEqual(resumes, [undefined, undefined], 'neither session resumed')
  await manager.shutdown()
})

test('fresh: true ends the live session before starting the new one', async () => {
  const log = makeLog()
  const { queryFn } = recordingQuery(['claude-1', 'claude-2'])
  const manager = new SessionManager(log, CONFIG, queryFn)

  await manager.prompt('first')
  await waitFor(() => startedCount(log) === 1, 'first session')
  const firstSessionId = manager.currentSessionId

  await manager.prompt('start over', { fresh: true })
  await waitFor(() => startedCount(log) === 2, 'second session')

  assert.notEqual(manager.currentSessionId, firstSessionId)
  const ended = log.replaySince(0).filter((e) => e.type === 'session_ended')
  assert.equal(ended.length, 1, 'the old session was closed, not abandoned')
  assert.equal(ended[0]?.type === 'session_ended' && ended[0].reason, 'complete', 'it was idle')

  await manager.shutdown()
})

test('a second prompt feeds the live session rather than starting another', async () => {
  const log = makeLog()
  const { queryFn, resumes } = recordingQuery(['claude-1'])
  const manager = new SessionManager(log, CONFIG, queryFn)

  const a = await manager.prompt('one')
  await waitFor(() => startedCount(log) === 1, 'session')
  const b = await manager.prompt('two')

  assert.equal(a, b, 'same session id')
  assert.equal(resumes.length, 1, 'query() called once')
  await manager.shutdown()
})

test('recoverOnBoot expires approvals the dead process was parked on', async () => {
  const log = makeLog()
  const base = { sessionId: 's-old', projectId: 'p', ts: 1 } as const
  log.append({ ...base, type: 'session_started', claudeSessionId: 'claude-1', model: 'opus' })
  log.append({ ...base, type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} })

  new SessionManager(log, CONFIG).recoverOnBoot()

  assert.deepEqual(log.pendingApprovals(), [])
  assert.deepEqual(log.openSessions(), [])
  assert.ok(log.replaySince(0).some((e) => e.type === 'approval_expired'))
})
