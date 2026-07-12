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
import { UnknownImageError, UploadStore } from './uploads.ts'

const BASE: Omit<Config, 'projectsRoot' | 'projectPath' | 'projectId'> = {
  port: 0,
  host: '127.0.0.1',
  dbPath: ':memory:',
  uploadsRoot: mkdtempSync(join(tmpdir(), 'mce-uploads-')),
  claudeToken: 'test-token',
  model: undefined,
  isDev: true,
  webDist: '/nonexistent',
  vapid: undefined,
  previewPort: 0,
  previewIdleTimeoutMs: 30 * 60 * 1000,
}

const init = (sessionId: string): SDKMessage =>
  ({ type: 'system', subtype: 'init', session_id: sessionId, model: 'opus' }) as unknown as SDKMessage

const done = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1 }) as unknown as SDKMessage

/** Records the `resume` option AND the prompt text each started session received. */
function recordingQuery(claudeSessionIds: string[]): {
  queryFn: QueryFn
  resumes: Array<string | undefined>
  firstPrompts: string[]
} {
  const resumes: Array<string | undefined> = []
  const firstPrompts: string[] = []
  let n = 0

  const queryFn = ((params: { prompt: AsyncIterable<{ message: { content: string } }>; options: { resume?: string } }) => {
    resumes.push(params.options.resume)
    const claudeSessionId = claudeSessionIds[n++] ?? `claude-${n}`
    return (async function* () {
      yield init(claudeSessionId)
      let first = true
      for await (const msg of params.prompt) {
        if (first) {
          firstPrompts.push(msg.message.content)
          first = false
        }
        yield done()
      }
    })() as unknown as Query
  }) as unknown as QueryFn

  return { queryFn, resumes, firstPrompts }
}

interface Harness {
  manager: SessionManager
  log: EventLog
  uploads: UploadStore
  resumes: Array<string | undefined>
  firstPrompts: string[]
}

/** A projects root on disk with the named projects git-init'd. `sessionExists`
 *  controls native-resume vs recap (default: never native → always recap/fresh). */
function harness(
  projectIds: string[],
  claudeSessionIds: string[],
  sessionExists: (id: string) => boolean = () => false,
): Harness {
  const root = mkdtempSync(join(tmpdir(), 'mce-projects-'))
  for (const id of projectIds) {
    const dir = join(root, id)
    mkdirSync(dir)
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  }
  const config: Config = { ...BASE, projectsRoot: root, projectPath: join(root, projectIds[0] ?? 'app'), projectId: projectIds[0] ?? 'app' }

  const log = new EventLog(openDb(':memory:'), makeRedactor([]))
  const projects = new ProjectStore(root, log)
  const uploads = new UploadStore(mkdtempSync(join(tmpdir(), 'mce-uploads-')))
  const { queryFn, resumes, firstPrompts } = recordingQuery(claudeSessionIds)
  const manager = new SessionManager(log, config, projects, uploads, { queryFn, sessionExists })
  return { manager, log, uploads, resumes, firstPrompts }
}

async function waitFor(predicate: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await sleep(5)
  }
}

const startedForThread = (log: EventLog, threadId: string): number =>
  log.replaySince(0).filter((e) => e.type === 'session_started' && e.threadId === threadId).length

// ---------------------------------------------------------------------------

test('newThread mints an id; the first prompt starts a fresh session (no resume, no recap)', async () => {
  const { manager, log, resumes, firstPrompts } = harness(['app'], ['c1'])
  const t = manager.newThread('app')

  await manager.prompt('app', t, 'hello')
  await waitFor(() => startedForThread(log, t) === 1, 'session_started')

  assert.deepEqual(resumes, [undefined])
  assert.equal(firstPrompts[0], 'hello', 'no recap folded into a brand-new thread')
  await manager.shutdown()
})

test('newThread on an unknown project throws', () => {
  const { manager } = harness(['app'], ['c1'])
  assert.throws(() => manager.newThread('ghost'), UnknownProjectError)
})

test('two threads in one project stay isolated, each tagged with its own id', async () => {
  const { manager, log } = harness(['app'], ['ca', 'cb'])
  const a = manager.newThread('app')
  const b = manager.newThread('app')

  await manager.prompt('app', a, 'work on A')
  await manager.prompt('app', b, 'work on B')
  await waitFor(() => startedForThread(log, a) === 1 && startedForThread(log, b) === 1, 'both')

  const aEvents = log.replaySince(0).filter((e) => e.threadId === a)
  const bEvents = log.replaySince(0).filter((e) => e.threadId === b)
  assert.ok(aEvents.some((e) => e.type === 'user_prompt' && e.text === 'work on A'))
  assert.ok(bEvents.some((e) => e.type === 'user_prompt' && e.text === 'work on B'))
  assert.ok(!aEvents.some((e) => e.type === 'user_prompt' && e.text === 'work on B'), 'no cross-talk')
  await manager.shutdown()
})

test('a second prompt to the same thread feeds the live session', async () => {
  const { manager, log, resumes } = harness(['app'], ['c1'])
  const t = manager.newThread('app')

  const s1 = await manager.prompt('app', t, 'one')
  await waitFor(() => startedForThread(log, t) === 1, 'session')
  const s2 = await manager.prompt('app', t, 'two')

  assert.equal(s1, s2, 'same session id')
  assert.equal(resumes.length, 1, 'query() called once')
  await manager.shutdown()
})

test('continuing a cold thread NATIVELY resumes when the transcript still exists', async () => {
  // sessionExists → true: native resume, no recap.
  const { manager, log, resumes, firstPrompts } = harness(['app'], ['c1', 'c1'], () => true)
  const t = manager.newThread('app')

  await manager.prompt('app', t, 'first')
  await waitFor(() => startedForThread(log, t) === 1, 'first session')
  // Force the session dead so the next prompt starts a new one (cold path).
  await manager.shutdown()

  await manager.prompt('app', t, 'again')
  await waitFor(() => startedForThread(log, t) === 2, 'resumed session')

  assert.equal(resumes[1], 'c1', 'native resume with the thread claude id')
  assert.equal(firstPrompts[1], 'again', 'no recap folded in when resuming natively')
  await manager.shutdown()
})

test('continuing a cold thread RECAPS when the transcript is gone', async () => {
  // sessionExists → false: no native resume; recap from the log instead.
  const { manager, log, resumes, firstPrompts } = harness(['app'], ['c1', 'c2'], () => false)
  const t = manager.newThread('app')

  await manager.prompt('app', t, 'refactor the auth flow')
  await waitFor(() => startedForThread(log, t) === 1, 'first session')
  await manager.shutdown()

  await manager.prompt('app', t, 'keep going')
  await waitFor(() => startedForThread(log, t) === 2, 'recapped session')

  assert.equal(resumes[1], undefined, 'no native resume')
  const recapped = firstPrompts[1] ?? ''
  assert.match(recapped, /recap/i, 'a recap was folded in')
  assert.match(recapped, /refactor the auth flow/, 'the recap includes the earlier prompt')
  assert.match(recapped, /keep going$/, 'the real prompt follows the recap')
  await manager.shutdown()
})

test('recoverOnBoot closes open sessions and expires parked approvals', async () => {
  const { manager, log } = harness(['app'], ['c1'])
  const at = { sessionId: 's-old', projectId: 'app', threadId: 't-old', ts: 1 } as const
  log.append({ ...at, type: 'session_started', claudeSessionId: 'c1', model: 'opus' })
  log.append({ ...at, type: 'approval_request', approvalId: 'a1', toolUseId: 't1', tool: 'Edit', input: {} })

  manager.recoverOnBoot()

  assert.deepEqual(log.pendingApprovals(), [])
  assert.deepEqual(log.openSessions(), [])
  assert.ok(log.replaySince(0).some((e) => e.type === 'approval_expired'))
  await manager.shutdown()
})

test('resolveApproval on an unknown id is not_pending', async () => {
  const { manager } = harness(['app'], ['c1'])
  assert.equal(manager.resolveApproval('ghost', true), 'not_pending')
  await manager.shutdown()
})

test('prompt() with an unknown image id rejects with UnknownImageError', async () => {
  const { manager } = harness(['app'], ['c1'])
  const t = manager.newThread('app')
  await assert.rejects(() => manager.prompt('app', t, 'go', ['ghost.png']), UnknownImageError)
  await manager.shutdown()
})

// --- hasLiveSession / closeProject (Phase 6 — the remove-project guard) ----

test('hasLiveSession is true only while a project actually has a live session', async () => {
  const { manager } = harness(['app', 'other'], ['c1'])
  assert.equal(manager.hasLiveSession('app'), false)

  const t = manager.newThread('app')
  await manager.prompt('app', t, 'hello')
  assert.equal(manager.hasLiveSession('app'), true)
  assert.equal(manager.hasLiveSession('other'), false, 'a different project is unaffected')

  await manager.shutdown()
  assert.equal(manager.hasLiveSession('app'), false, 'dead once stopped')
})

test('closeProject stops every thread of that project and leaves other projects alone', async () => {
  const { manager } = harness(['app', 'other'], ['ca', 'cb', 'cc'])
  const a1 = manager.newThread('app')
  const a2 = manager.newThread('app')
  const o1 = manager.newThread('other')

  await manager.prompt('app', a1, 'one')
  await manager.prompt('app', a2, 'two')
  await manager.prompt('other', o1, 'three')
  assert.equal(manager.hasLiveSession('app'), true)
  assert.equal(manager.hasLiveSession('other'), true)

  await manager.closeProject('app')

  assert.equal(manager.hasLiveSession('app'), false)
  assert.equal(manager.hasLiveSession('other'), true, "a different project's session survives")

  await manager.shutdown()
})

test('closeProject on a project with no live session is a harmless no-op', async () => {
  const { manager } = harness(['app'], ['c1'])
  await manager.closeProject('app') // must not throw
  assert.equal(manager.hasLiveSession('app'), false)
})
