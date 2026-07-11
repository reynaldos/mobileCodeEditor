import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Config } from './config.ts'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import { ProjectStore } from './projects.ts'
import { makeRedactor } from './redact.ts'
import type { QueryFn } from './session.ts'
import { SessionManager, UnknownProjectError } from './session-manager.ts'

const BASE: Omit<Config, 'projectsRoot' | 'projectPath' | 'projectId'> = {
  port: 0,
  host: '127.0.0.1',
  dbPath: ':memory:',
  claudeToken: 'test-token',
  model: undefined,
  isDev: true,
  webDist: '/nonexistent',
  vapid: undefined,
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

  const queryFn = ((params: { prompt: AsyncIterable<unknown>; options: { resume?: string } }) => {
    resumes.push(params.options.resume)
    const claudeSessionId = claudeSessionIds[n++] ?? `claude-${n}`
    return (async function* () {
      yield init(claudeSessionId)
      for await (const _ of params.prompt) yield done()
    })() as unknown as Query
  }) as unknown as QueryFn

  return { queryFn, resumes }
}

/** A projects root on disk with the named projects git-init'd, and a manager over it. */
function harness(
  projectIds: string[],
  claudeSessionIds: string[],
): { manager: SessionManager; log: EventLog; resumes: Array<string | undefined> } {
  const root = mkdtempSync(join(tmpdir(), 'mce-projects-'))
  for (const id of projectIds) {
    const dir = join(root, id)
    mkdirSync(dir)
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  }
  const config: Config = {
    ...BASE,
    projectsRoot: root,
    projectPath: join(root, projectIds[0] ?? 'app'),
    projectId: projectIds[0] ?? 'app',
  }

  const log = new EventLog(openDb(':memory:'), makeRedactor([]))
  const projects = new ProjectStore(root, log)
  const { queryFn, resumes } = recordingQuery(claudeSessionIds)
  const manager = new SessionManager(log, config, projects, queryFn)
  return { manager, log, resumes }
}

async function waitFor(predicate: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await sleep(5)
  }
}

const startedFor = (log: EventLog, projectId: string): number =>
  log.replaySince(0).filter((e) => e.type === 'session_started' && e.projectId === projectId).length

// ---------------------------------------------------------------------------

test('the first prompt to a project starts a fresh conversation', async () => {
  const { manager, log, resumes } = harness(['app'], ['claude-1'])

  await manager.prompt('app', 'hello')
  await waitFor(() => startedFor(log, 'app') === 1, 'session_started')

  assert.deepEqual(resumes, [undefined])
  await manager.shutdown()
})

test('prompting an unknown project is an UnknownProjectError', async () => {
  const { manager } = harness(['app'], ['claude-1'])
  await assert.rejects(() => manager.prompt('ghost', 'hi'), UnknownProjectError)
  await manager.shutdown()
})

test('two projects run isolated sessions — the whole point of Phase 2', async () => {
  const { manager, log } = harness(['alpha', 'beta'], ['claude-a', 'claude-b'])

  await manager.prompt('alpha', 'work on alpha')
  await manager.prompt('beta', 'work on beta')
  await waitFor(() => startedFor(log, 'alpha') === 1 && startedFor(log, 'beta') === 1, 'both sessions')

  const alpha = log.replaySince(0).filter((e) => e.projectId === 'alpha')
  const beta = log.replaySince(0).filter((e) => e.projectId === 'beta')
  assert.ok(alpha.some((e) => e.type === 'user_prompt' && e.text === 'work on alpha'))
  assert.ok(beta.some((e) => e.type === 'user_prompt' && e.text === 'work on beta'))
  assert.ok(!alpha.some((e) => e.type === 'user_prompt' && e.text === 'work on beta'), 'no cross-talk')

  await manager.shutdown()
})

test('a second prompt to the same project feeds the live session', async () => {
  const { manager, log, resumes } = harness(['app'], ['claude-1'])

  const a = await manager.prompt('app', 'one')
  await waitFor(() => startedFor(log, 'app') === 1, 'session')
  const b = await manager.prompt('app', 'two')

  assert.equal(a, b, 'same session id')
  assert.equal(resumes.length, 1, 'query() called once')
  await manager.shutdown()
})

test('each project resumes its own last conversation', async () => {
  const { manager, log } = harness(['alpha', 'beta'], ['claude-a', 'claude-b'])
  await manager.prompt('alpha', 'a')
  await manager.prompt('beta', 'b')
  await waitFor(() => startedFor(log, 'alpha') === 1 && startedFor(log, 'beta') === 1, 'both')

  assert.equal(manager.resumableConversationIdOf('alpha'), 'claude-a')
  assert.equal(manager.resumableConversationIdOf('beta'), 'claude-b')
  await manager.shutdown()
})

test('a reset is per-project: that project resumes nothing, the other is untouched', async () => {
  const { manager, log } = harness(['alpha', 'beta'], ['claude-a', 'claude-b'])

  await manager.prompt('alpha', 'a')
  await manager.prompt('beta', 'b')
  await waitFor(() => startedFor(log, 'alpha') === 1 && startedFor(log, 'beta') === 1, 'both')

  await manager.newConversation('alpha')

  assert.equal(manager.resumableConversationIdOf('alpha'), undefined, 'alpha reset')
  assert.equal(manager.resumableConversationIdOf('beta'), 'claude-b', 'beta untouched')
  await manager.shutdown()
})

test('recoverOnBoot closes open sessions and expires parked approvals', async () => {
  const { manager, log } = harness(['app'], ['claude-1'])
  const at = { sessionId: 's-old', projectId: 'app', ts: 1 } as const
  log.append({ ...at, type: 'session_started', claudeSessionId: 'claude-1', model: 'opus' })
  log.append({ ...at, type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} })

  manager.recoverOnBoot()

  assert.deepEqual(log.pendingApprovals(), [])
  assert.deepEqual(log.openSessions(), [])
  assert.ok(log.replaySince(0).some((e) => e.type === 'approval_expired'))
  await manager.shutdown()
})

test('resolveApproval on an unknown id is not_pending', async () => {
  const { manager } = harness(['app'], ['claude-1'])
  assert.equal(manager.resolveApproval('ghost', true), 'not_pending')
  await manager.shutdown()
})
