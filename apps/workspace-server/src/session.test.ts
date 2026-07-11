import type { PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Event } from '@mce/protocol'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Config } from './config.ts'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import { makeRedactor } from './redact.ts'
import { AgentSession, type QueryFn } from './session.ts'

/**
 * Drives the real message loop and approval bridge with a fake `query`, so the
 * heart of the server is testable without the SDK, a token, or a network call.
 */

const CONFIG: Config = {
  port: 0,
  host: '127.0.0.1',
  dbPath: ':memory:',
  projectPath: tmpdir(),
  projectId: 'test',
  projectsRoot: tmpdir(),
  claudeToken: 'test-token',
  model: undefined,
  isDev: true,
  webDist: '/nonexistent',
  vapid: undefined,
}

// The SDK message union has ~38 variants; we construct the five we map.
const init = (): SDKMessage =>
  ({ type: 'system', subtype: 'init', session_id: 'claude-1', model: 'opus', apiKeySource: 'oauth' }) as unknown as SDKMessage

const say = (text: string): SDKMessage =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as unknown as SDKMessage

const useTool = (id: string, name: string, input: unknown): SDKMessage =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }) as unknown as SDKMessage

const done = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 2 }) as unknown as SDKMessage

/** The `options` bag the real SDK hands `canUseTool`. */
interface QueryParams {
  prompt: AsyncIterable<SDKUserMessage>
  options: {
    canUseTool?: (t: string, i: Record<string, unknown>, o: Record<string, unknown>) => Promise<PermissionResult | null>
    abortController?: AbortController
  }
}

const fakeQuery = (gen: (params: QueryParams) => AsyncGenerator<SDKMessage, void>): QueryFn =>
  ((params: QueryParams) => gen(params) as unknown as Query) as unknown as QueryFn

function makeSession(queryFn: QueryFn): { session: AgentSession; log: EventLog } {
  const log = new EventLog(openDb(':memory:'), makeRedactor([]))
  const session = new AgentSession({
    id: 's1',
    log,
    config: CONFIG,
    projectId: 'test',
    threadId: 'th1',
    projectPath: CONFIG.projectPath,
    queryFn,
  })
  return { session, log }
}

const types = (log: EventLog): string[] => log.replaySince(0).map((e) => e.type)
const last = (log: EventLog): Event => log.replaySince(0).at(-1)!

/**
 * A holder, not a `let`. The fake `query` writes from inside a closure, which
 * TypeScript's flow analysis cannot see — a plain `let` stays narrowed to `null`
 * at every read, so the assertions would need casts that defeat the point.
 */
const capture = (): { verdict: PermissionResult | null } => ({ verdict: null })

async function waitFor(predicate: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await sleep(5)
  }
}

// ---------------------------------------------------------------------------

test('a turn maps SDK messages onto the log', async () => {
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt }) {
      yield init()
      for await (const _ of prompt) {
        yield say('looking')
        yield useTool('tu1', 'Read', { file_path: '/tmp/a.ts' })
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_input', 'turn to finish')

  assert.deepEqual(types(log), [
    'user_prompt',
    'session_started',
    'assistant_text',
    'tool_use',
    'turn_complete',
  ])
  assert.equal(session.claudeSessionId, 'claude-1')

  const started = log.replaySince(0).find((e) => e.type === 'session_started')
  assert.equal(started?.type === 'session_started' && started.apiKeySource, 'oauth')

  await session.stop()
})

test('a re-emitted system/init does not start a second session', async () => {
  // The SDK emits init again on later turns. Observed in a real session: two
  // session_started rows for one AgentSession, same claude session id.
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt }) {
      yield init()
      for await (const _ of prompt) {
        yield init() // same session_id, second turn
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('one')
  await waitFor(() => session.status === 'awaiting_input', 'turn one')
  session.prompt('two')
  await waitFor(() => types(log).filter((t) => t === 'turn_complete').length === 2, 'turn two')

  assert.equal(types(log).filter((t) => t === 'session_started').length, 1)
  await session.stop()
})

test('an init with a CHANGED session id records a new session — the conversation forked', async () => {
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt }) {
      yield init()
      for await (const _ of prompt) {
        yield { type: 'system', subtype: 'init', session_id: 'claude-2', model: 'opus' } as unknown as SDKMessage
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_input', 'turn')

  assert.equal(types(log).filter((t) => t === 'session_started').length, 2)
  assert.equal(session.claudeSessionId, 'claude-2')
  await session.stop()
})

test('stopping an IDLE session ends it complete, not interrupted', async () => {
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt }) {
      yield init()
      for await (const _ of prompt) {
        yield say('done')
        yield done()
      }
      // Closing the input stream lets us fall out of the loop and return.
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_input', 'idle')

  await session.stop()

  const ended = last(log)
  assert.equal(ended.type, 'session_ended')
  assert.equal(ended.type === 'session_ended' && ended.reason, 'complete')
  assert.equal(session.status, 'ended')
})

test('stopping MID-TURN is interrupted, and says why', async () => {
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt, options }) {
      yield init()
      for await (const _ of prompt) {
        yield say('working')
        // Never finishes on its own; only an abort ends this.
        await new Promise((_resolve, reject) => {
          const signal = options.abortController?.signal
          // Check first: the abort may already have fired by the time we get here.
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'thinking', 'mid-turn')

  await session.stop()

  const ended = last(log)
  assert.equal(ended.type === 'session_ended' && ended.reason, 'interrupted')
  assert.equal(
    ended.type === 'session_ended' && ended.message,
    'Server stopped while the agent was working.',
  )
})

test('Read is auto-approved and never raises a card', async () => {
  const seen = capture()
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt, options }) {
      yield init()
      for await (const _ of prompt) {
        seen.verdict = await options.canUseTool!('Read', { file_path: '/tmp/a.ts' }, { toolUseID: 'tu1', signal: new AbortController().signal })
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_input', 'turn to finish')

  assert.equal(seen.verdict?.behavior, 'allow')
  assert.ok(!types(log).includes('approval_request'), 'Read must not prompt')
  await session.stop()
})

test('Edit parks on canUseTool until an HTTP approval resolves it', async () => {
  const seen = capture()
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt, options }) {
      yield init()
      for await (const _ of prompt) {
        seen.verdict = await options.canUseTool!(
          'Edit',
          { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' },
          { toolUseID: 'tu1', signal: new AbortController().signal },
        )
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_approval', 'the approval card')

  // The agent is genuinely blocked: canUseTool has not returned.
  //
  // Asserted through a local snapshot on purpose. node:assert/strict's `ok` and
  // `equal` are assertion signatures, so asserting on `seen.verdict` directly
  // would narrow the property to `null` for the rest of this function and make
  // every later read a `never`.
  const beforeApproval = seen.verdict
  assert.ok(beforeApproval === null, 'canUseTool must not have returned yet')
  assert.ok(types(log).includes('approval_request'))

  const request = log.replaySince(0).find((e) => e.type === 'approval_request')
  const approvalId = request?.type === 'approval_request' ? request.approvalId : ''
  assert.ok(session.hasPendingApproval(approvalId))

  assert.equal(session.resolveApproval(approvalId, true), true)
  await waitFor(() => session.status === 'awaiting_input', 'the turn to resume')

  const verdict = seen.verdict
  assert.ok(verdict)
  assert.equal(verdict.behavior, 'allow')
  // The tool runs with the input we approved, not something re-derived.
  assert.equal(
    verdict.behavior === 'allow' && (verdict.updatedInput as { new_string: string }).new_string,
    'b',
  )
  await session.stop()
})

test('rejecting an approval denies the tool with a reason', async () => {
  const seen = capture()
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt, options }) {
      yield init()
      for await (const _ of prompt) {
        seen.verdict = await options.canUseTool!('Bash', { command: 'rm -rf /' }, { toolUseID: 'tu1', signal: new AbortController().signal })
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_approval', 'the approval card')

  const request = log.replaySince(0).find((e) => e.type === 'approval_request')
  const approvalId = request?.type === 'approval_request' ? request.approvalId : ''
  session.resolveApproval(approvalId, false, 'Absolutely not.')
  await waitFor(() => session.status === 'awaiting_input', 'the turn to resume')

  const verdict = seen.verdict
  assert.ok(verdict)
  assert.equal(verdict.behavior, 'deny')
  assert.equal(verdict.behavior === 'deny' && verdict.message, 'Absolutely not.')
  assert.ok(types(log).includes('approval_decision'))
})

test('resolving an approval that is not pending returns false', async () => {
  const { session } = makeSession(fakeQuery(async function* () { yield init() }))
  session.start()
  assert.equal(session.resolveApproval('ghost', true), false)
  await session.stop()
})

test('aborting while parked resolves the promise rather than leaking it', async () => {
  // A parked promise nobody resolves hangs the agent forever — the SDK gives
  // permission prompts no deadline. The abort listener is the safety net.
  const abort = new AbortController()
  const seen = capture()

  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt, options }) {
      yield init()
      for await (const _ of prompt) {
        seen.verdict = await options.canUseTool!('Edit', { file_path: '/tmp/a.ts' }, { toolUseID: 'tu1', signal: abort.signal })
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_approval', 'the approval card')

  abort.abort()
  await waitFor(() => seen.verdict !== null, 'the parked promise to resolve')

  assert.equal(seen.verdict?.behavior, 'deny')
  assert.ok(types(log).includes('approval_expired'))
  await session.stop()
})

// ---------------------------------------------------------------------------
// AskUserQuestion arrives via canUseTool like any other tool_use (confirmed:
// without a special case it fell into the generic approval branch and showed
// raw JSON with just Approve/Reject — no picker). These lock that in.

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which library should we use for date formatting?',
      header: 'Library',
      options: [
        { label: 'date-fns', description: 'Tree-shakeable, no prototype patching.' },
        { label: 'dayjs', description: 'Tiny, moment-compatible API.' },
      ],
      multiSelect: false,
    },
  ],
}

test('AskUserQuestion renders as a question_request, not a generic approval', async () => {
  const seen = capture()
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt, options }) {
      yield init()
      for await (const _ of prompt) {
        seen.verdict = await options.canUseTool!('AskUserQuestion', QUESTION_INPUT, {
          toolUseID: 'tu1',
          signal: new AbortController().signal,
        })
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_approval', 'the question card')

  // The agent is genuinely blocked: canUseTool has not returned yet. Snapshot
  // locally — asserting on `seen.verdict` directly narrows the property to
  // `null` for the rest of the function (see the Edit test above).
  const beforeAnswer = seen.verdict
  assert.ok(beforeAnswer === null, 'canUseTool must not have returned yet')
  assert.ok(types(log).includes('question_request'))
  assert.ok(!types(log).includes('approval_request'), 'must not also raise a generic approval card')

  const request = log.replaySince(0).find((e) => e.type === 'question_request')
  assert.ok(request?.type === 'question_request')
  assert.equal(request.toolUseId, 'tu1')
  assert.deepEqual(request.questions, QUESTION_INPUT.questions)

  const requestId = request.requestId
  assert.ok(session.hasPendingQuestion(requestId))

  assert.equal(session.answerQuestion(requestId, { [QUESTION_INPUT.questions[0]!.question]: 'date-fns' }), true)
  await waitFor(() => session.status === 'awaiting_input', 'the turn to resume')

  const verdict = seen.verdict
  assert.ok(verdict)
  assert.equal(verdict.behavior, 'allow')
  // The answer rides back on updatedInput so the tool_result reflects the pick.
  const updated = verdict.behavior === 'allow' ? (verdict.updatedInput as { answers?: Record<string, string> }) : undefined
  assert.deepEqual(updated?.answers, { [QUESTION_INPUT.questions[0]!.question]: 'date-fns' })

  assert.ok(types(log).includes('question_answered'))
  await session.stop()
})

test('answering an AskUserQuestion that is not pending returns false', async () => {
  const { session } = makeSession(fakeQuery(async function* () { yield init() }))
  session.start()
  assert.equal(session.answerQuestion('ghost', {}), false)
  await session.stop()
})

test('aborting a parked AskUserQuestion resolves rather than leaking it', async () => {
  const abort = new AbortController()
  const seen = capture()

  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt, options }) {
      yield init()
      for await (const _ of prompt) {
        seen.verdict = await options.canUseTool!('AskUserQuestion', QUESTION_INPUT, {
          toolUseID: 'tu1',
          signal: abort.signal,
        })
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_approval', 'the question card')

  abort.abort()
  await waitFor(() => seen.verdict !== null, 'the parked promise to resolve')

  assert.equal(seen.verdict?.behavior, 'deny')
  assert.ok(types(log).includes('question_cancelled'))
  await session.stop()
})

test('a malformed AskUserQuestion input falls back to a generic approval card', async () => {
  const { session, log } = makeSession(
    fakeQuery(async function* ({ prompt, options }) {
      yield init()
      for await (const _ of prompt) {
        // Never resolved in this test — parks like the other approval tests,
        // which is why the loop never reaches `yield done()`.
        await options.canUseTool!('AskUserQuestion', { not: 'a question' }, {
          toolUseID: 'tu1',
          signal: new AbortController().signal,
        })
        yield done()
      }
    }),
  )

  session.start()
  session.prompt('go')
  await waitFor(() => session.status === 'awaiting_approval', 'the approval card')

  assert.ok(types(log).includes('approval_request'))
  assert.ok(!types(log).includes('question_request'))
  await session.stop()
})
