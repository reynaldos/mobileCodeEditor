import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { LEGACY_THREAD_ID } from '@mce/protocol'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { BuildTracker } from './build-tracker.ts'
import type { Config } from './config.ts'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import { Presence } from './presence.ts'
import { PreviewManager } from './preview-manager.ts'
import { PreviewTracker } from './preview-tracker.ts'
import { ProjectStore } from './projects.ts'
import { Pusher } from './push.ts'
import { PushStore } from './push-store.ts'
import { makeRedactor } from './redact.ts'
import { buildServer } from './server.ts'
import { SessionManager } from './session-manager.ts'
import type { QueryFn } from './session.ts'
import { UploadStore } from './uploads.ts'

/** A minimal fake SDK query, so a test can drive a real session without a token or network call. */
const fakeQueryFn: QueryFn = ((params: { prompt: AsyncIterable<unknown> }) =>
  (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'c1', model: 'opus' } as unknown as SDKMessage
    for await (const _ of params.prompt) {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1 } as unknown as SDKMessage
    }
  })()) as unknown as QueryFn

/**
 * These boot the real Fastify app over a real socket.
 *
 * The SSE route calls `reply.hijack()`, which takes it out of Fastify's
 * lifecycle — so plugin hooks (CORS, most notably) do not apply to it. No unit
 * test of the log or the reducer can see that. Only a real request can.
 */

const DEV: Config = {
  port: 0,
  host: '127.0.0.1',
  dbPath: ':memory:',
  projectPath: tmpdir(),
  projectId: 'test',
  projectsRoot: tmpdir(),
  uploadsRoot: mkdtempSync(join(tmpdir(), 'mce-uploads-')),
  claudeToken: undefined,
  model: undefined,
  isDev: true,
  webDist: '/nonexistent-so-static-serving-is-skipped',
  vapid: undefined,
  previewPort: 0,
  previewIdleTimeoutMs: 30 * 60 * 1000,
}

const teardown: Array<() => Promise<void>> = []
after(async () => {
  for (const fn of teardown) await fn()
})

async function boot(
  config: Config = DEV,
  opts: { queryFn?: QueryFn } = {},
): Promise<{
  base: string
  log: EventLog
  presence: Presence
  uploads: UploadStore
  builds: BuildTracker
  previewTracker: PreviewTracker
  sessions: SessionManager
}> {
  const db = openDb(':memory:')
  const log = new EventLog(db, makeRedactor([]))
  const pushStore = new PushStore(db)
  const builds = new BuildTracker()
  const projects = new ProjectStore(config.projectsRoot, log, undefined, builds)
  const presence = new Presence()
  const uploads = new UploadStore(config.uploadsRoot)
  const previewTracker = new PreviewTracker()
  const previews = new PreviewManager(log, previewTracker, projects, presence, config)
  const sessions = new SessionManager(log, config, projects, uploads, opts.queryFn ? { queryFn: opts.queryFn } : {})
  const app = await buildServer(config, {
    log,
    sessions,
    projects,
    builds,
    github: undefined,
    pushStore,
    pusher: new Pusher(pushStore, config.vapid),
    presence,
    uploads,
    previews,
    previewTracker,
  })
  app.log.level = 'silent'

  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no port')

  teardown.push(() => app.close())
  return { base: `http://127.0.0.1:${address.port}`, log, presence, uploads, builds, previewTracker, sessions }
}

const ORIGIN = 'http://localhost:5173'

test('SSE carries CORS headers in dev — hijack() bypasses the cors plugin', async () => {
  const { base } = await boot()
  const abort = new AbortController()

  const response = await fetch(`${base}/api/events`, {
    headers: { Origin: ORIGIN },
    signal: abort.signal,
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  // Without this the browser blocks the stream and the client says
  // "reconnecting" forever, with nothing in the server log.
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN)
  assert.equal(response.headers.get('vary'), 'Origin')

  abort.abort()
})

test('SSE echoes no CORS header in production, where we are same-origin', async () => {
  const { base } = await boot({ ...DEV, isDev: false })
  const abort = new AbortController()

  const response = await fetch(`${base}/api/events`, {
    headers: { Origin: ORIGIN },
    signal: abort.signal,
  })

  assert.equal(response.headers.get('access-control-allow-origin'), null)
  abort.abort()
})

test('/api/health is CORS-enabled in dev, for contrast', async () => {
  const { base } = await boot()
  const response = await fetch(`${base}/api/health`, { headers: { Origin: ORIGIN } })

  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN)
  assert.equal(((await response.json()) as { agentReady: boolean }).agentReady, false)
})

test('the stream replays from Last-Event-ID over a real socket', async () => {
  const { base, log } = await boot()
  for (const text of ['one', 'two', 'three']) {
    log.append({ sessionId: 's', projectId: 'p', ts: 1, type: 'assistant_text', text })
  }

  const abort = new AbortController()
  const response = await fetch(`${base}/api/events`, {
    headers: { 'Last-Event-ID': '2' },
    signal: abort.signal,
  })

  const reader = response.body!.getReader()
  const chunk = new TextDecoder().decode((await reader.read()).value)
  abort.abort()

  assert.match(chunk, /^id: 3$/m, 'replays strictly after seq 2')
  assert.doesNotMatch(chunk, /"text":"two"/, 'does not resend the event the client already saw')
  assert.match(chunk, /"text":"three"/)
})

test('a live append reaches an already-connected subscriber', async () => {
  const { base, log } = await boot()
  const abort = new AbortController()

  const response = await fetch(`${base}/api/events`, { signal: abort.signal })
  const reader = response.body!.getReader()

  log.append({ sessionId: 's', projectId: 'p', ts: 1, type: 'assistant_text', text: 'live' })

  const chunk = new TextDecoder().decode((await reader.read()).value)
  abort.abort()

  assert.match(chunk, /"text":"live"/)
})

test('POST /api/presence records a tab as visible, reachable from the SSE route', async () => {
  const { base, presence } = await boot()

  const response = await fetch(`${base}/api/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'tab-1', visible: true }),
  })

  assert.equal(response.status, 204)
  assert.equal(presence.anyVisible, true)
})

test('POST /api/presence rejects a malformed body rather than silently no-op', async () => {
  const { base } = await boot()

  const response = await fetch(`${base}/api/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'tab-1' }), // missing `visible`
  })

  assert.equal(response.status, 400)
})

test('a dropped SSE connection clears that tab from presence', async () => {
  const { base, presence } = await boot()
  presence.set('tab-1', true)

  const abort = new AbortController()
  // Headers arrive only after the route handler's synchronous setup (including
  // `log.subscribe`) has already run — no need to wait on a body frame, which
  // would block until the next 20s keepalive ping.
  await fetch(`${base}/api/events?clientId=tab-1`, { signal: abort.signal })
  abort.abort()

  // The server's `close` handler runs asynchronously after the abort.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(presence.anyVisible, false, 'the tab that just disconnected can no longer claim to be visible')
})

test('with a web build: client routes serve index.html, /api routes stay JSON', async () => {
  // The fallback only exists when a build is present, so give it one.
  const webDist = mkdtempSync(join(tmpdir(), 'mce-dist-'))
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>mce</title>')

  const { base } = await boot({ ...DEV, webDist })

  const clientRoute = await fetch(`${base}/settings/profile`)
  assert.equal(clientRoute.status, 200)
  assert.match(await clientRoute.text(), /<title>mce<\/title>/, 'SPA fallback')

  const apiRoute = await fetch(`${base}/api/nope`)
  assert.equal(apiRoute.status, 404)
  assert.equal(((await apiRoute.json()) as { error: string }).error, 'not found', 'must not serve index.html to the API')
})

test('approving something that is not pending is a 409, not a silent success', async () => {
  const { base } = await boot()
  const response = await fetch(`${base}/api/approvals/ghost`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allow: true }),
  })

  assert.equal(response.status, 409)
})

test('prompting without a projectId is a 400', async () => {
  const { base } = await boot()
  const response = await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  })

  assert.equal(response.status, 400)
  assert.match(((await response.json()) as { error: string }).error, /projectId/)
})

test('prompting without a threadId is a 400', async () => {
  const { base } = await boot()
  const response = await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello', projectId: 'app' }),
  })
  assert.equal(response.status, 400)
  assert.match(((await response.json()) as { error: string }).error, /threadId/)
})

test('prompting an unknown project is a 404', async () => {
  const { base } = await boot()
  const response = await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello', projectId: 'ghost', threadId: 't1' }),
  })

  assert.equal(response.status, 404)
})

test('prompting a real project without a token is a 503 that says what to do', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])

  const { base } = await boot({ ...DEV, projectsRoot: root })
  const response = await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello', projectId: 'app', threadId: 't1' }),
  })

  assert.equal(response.status, 503)
  assert.match(((await response.json()) as { error: string }).error, /CLAUDE_CODE_OAUTH_TOKEN/)
})

test('threads: new thread then list it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])
  const { base, log } = await boot({ ...DEV, projectsRoot: root })

  const created = await fetch(`${base}/api/projects/app/threads`, { method: 'POST' })
  assert.equal(created.status, 201)
  const { threadId } = (await created.json()) as { threadId: string }

  // A thread only appears once it has an event — seed one directly.
  log.append({ sessionId: 's', projectId: 'app', threadId, ts: 1, type: 'user_prompt', text: 'add a title here' })

  const list = (await (await fetch(`${base}/api/projects/app/threads`)).json()) as { threads: Array<{ id: string; title: string }> }
  assert.equal(list.threads.length, 1)
  assert.equal(list.threads[0]?.id, threadId)
  // Titleized from the first prompt: sentence-cased, filler stripped.
  assert.equal(list.threads[0]?.title, 'Add a title here')
})

test('threads: the legacy (read-only) bucket is deletable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])
  const { base, log } = await boot({ ...DEV, projectsRoot: root })

  // A pre-threads conversation: an event with no threadId lands in the legacy bucket.
  log.append({ sessionId: 's', projectId: 'app', ts: 1, type: 'user_prompt', text: 'old conversation' })

  const before = (await (await fetch(`${base}/api/projects/app/threads`)).json()) as {
    threads: Array<{ id: string; legacy?: boolean }>
  }
  assert.equal(before.threads.length, 1)
  assert.equal(before.threads[0]?.id, LEGACY_THREAD_ID)
  assert.equal(before.threads[0]?.legacy, true)

  const deleted = await fetch(`${base}/api/projects/app/threads/${LEGACY_THREAD_ID}`, { method: 'DELETE' })
  assert.equal(deleted.status, 204)

  // Hidden by the NULL-thread `thread_deleted` — the bucket drops out of the list.
  const afterList = (await (await fetch(`${base}/api/projects/app/threads`)).json()) as { threads: unknown[] }
  assert.deepEqual(afterList.threads, [])
})

test('github routes 503 when gh is not configured (boot default)', async () => {
  const { base } = await boot()
  assert.equal((await fetch(`${base}/api/github/repos?q=x`)).status, 503)
  assert.equal((await fetch(`${base}/api/github/check-name?name=x`)).status, 503)
})

test('GET /api/projects lists projects; POST creates one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  const { base } = await boot({ ...DEV, projectsRoot: root })

  const empty = (await (await fetch(`${base}/api/projects`)).json()) as { projects: unknown[] }
  assert.deepEqual(empty.projects, [])

  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'fresh' }),
  })
  assert.equal(created.status, 202)
  assert.equal(((await created.json()) as { projectId: string }).projectId, 'fresh')
})

// --- POST /api/projects/:id/install (re-run dependency install) -------------

test('POST /api/projects/:id/install is a 404 for an unknown project', async () => {
  const { base } = await boot()
  const res = await fetch(`${base}/api/projects/ghost/install`, { method: 'POST' })
  assert.equal(res.status, 404)
})

test('POST /api/projects/:id/install is a 400 when there is no package manifest to install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])
  const { base } = await boot({ ...DEV, projectsRoot: root })

  const res = await fetch(`${base}/api/projects/app/install`, { method: 'POST' })
  assert.equal(res.status, 400)
  assert.match(((await res.json()) as { error: string }).error, /nothing to install/i)
})

test('POST /api/projects/:id/install is a 409 while a build is already in progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])
  const { base, builds } = await boot({ ...DEV, projectsRoot: root })

  builds.start('app')
  const res = await fetch(`${base}/api/projects/app/install`, { method: 'POST' })
  assert.equal(res.status, 409)
})

// --- DELETE /api/projects/:id (Phase 6 — remove/offload) --------------------

test('DELETE /api/projects/:id removes the directory and appends project_removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])
  const { base, log } = await boot({ ...DEV, projectsRoot: root })

  assert.ok(existsSync(join(root, 'app')))
  const response = await fetch(`${base}/api/projects/app`, { method: 'DELETE' })
  assert.equal(response.status, 204)
  assert.equal(existsSync(join(root, 'app')), false)
  assert.ok(log.replaySince(0).some((e) => e.type === 'project_removed' && e.projectId === 'app'))
})

test('DELETE /api/projects/:id for an unknown project is a 404', async () => {
  const { base } = await boot()
  const response = await fetch(`${base}/api/projects/ghost`, { method: 'DELETE' })
  assert.equal(response.status, 404)
})

test('DELETE /api/projects/:id is a 409 while a build is in progress; force removes anyway', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])
  const { base, builds } = await boot({ ...DEV, projectsRoot: root })

  builds.start('app')
  const blocked = await fetch(`${base}/api/projects/app`, { method: 'DELETE' })
  assert.equal(blocked.status, 409)
  assert.deepEqual((await blocked.json()) as { blockers: string[] }, {
    error: "Can't remove — a build is in progress.",
    blockers: ['a build is in progress'],
  })
  assert.ok(existsSync(join(root, 'app')), 'not removed without force')

  const forced = await fetch(`${base}/api/projects/app`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  })
  assert.equal(forced.status, 204)
  assert.equal(existsSync(join(root, 'app')), false)
})

test('DELETE /api/projects/:id is a 409 while the preview is running for it; force stops it and removes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])
  const { base, previewTracker } = await boot({ ...DEV, projectsRoot: root })

  previewTracker.start('app', 'vite')
  const blocked = await fetch(`${base}/api/projects/app`, { method: 'DELETE' })
  assert.equal(blocked.status, 409)
  assert.deepEqual(((await blocked.json()) as { blockers: string[] }).blockers, ['the preview is running'])

  const forced = await fetch(`${base}/api/projects/app`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  })
  assert.equal(forced.status, 204)
  assert.equal(existsSync(join(root, 'app')), false)
  assert.equal(previewTracker.activeProjectId(), undefined, 'the preview was stopped too')
})

test('DELETE /api/projects/:id is a 409 while a conversation is live for it; force closes it and removes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])
  const { base, sessions } = await boot({ ...DEV, projectsRoot: root, claudeToken: 'test-token' }, { queryFn: fakeQueryFn })

  const threadId = sessions.newThread('app')
  await sessions.prompt('app', threadId, 'hello')
  assert.equal(sessions.hasLiveSession('app'), true)

  const blocked = await fetch(`${base}/api/projects/app`, { method: 'DELETE' })
  assert.equal(blocked.status, 409)
  assert.deepEqual(((await blocked.json()) as { blockers: string[] }).blockers, ['a conversation is still active'])

  const forced = await fetch(`${base}/api/projects/app`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  })
  assert.equal(forced.status, 204)
  assert.equal(existsSync(join(root, 'app')), false)
  assert.equal(sessions.hasLiveSession('app'), false)
})

// ---------------------------------------------------------------------------
// Uploads (images attached to a prompt, forwarded to Claude as multimodal content).

test('POST /api/uploads/images stores the file; GET serves the exact bytes back', async () => {
  const { base } = await boot()
  const bytes = Buffer.from('fake png bytes')

  const form = new FormData()
  form.append('images', new Blob([bytes], { type: 'image/png' }), 'a.png')
  const uploaded = await fetch(`${base}/api/uploads/images`, { method: 'POST', body: form })

  assert.equal(uploaded.status, 201)
  const { images } = (await uploaded.json()) as { images: Array<{ id: string; mediaType: string; size: number }> }
  assert.equal(images.length, 1)
  assert.equal(images[0]?.mediaType, 'image/png')
  assert.equal(images[0]?.size, bytes.length)

  const served = await fetch(`${base}/api/uploads/images/${images[0]?.id}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes)
})

test('GET /api/uploads/images/:id for an unknown id is a 404', async () => {
  const { base } = await boot()
  const response = await fetch(`${base}/api/uploads/images/ghost.png`)
  assert.equal(response.status, 404)
})

test('POST /api/uploads/images rejects a disallowed mimetype with 415', async () => {
  const { base } = await boot()
  const form = new FormData()
  form.append('images', new Blob([Buffer.from('not an image')], { type: 'application/pdf' }), 'a.pdf')

  const response = await fetch(`${base}/api/uploads/images`, { method: 'POST', body: form })
  assert.equal(response.status, 415)
})

test('POST /api/uploads/images rejects a file over the size cap with 413', async () => {
  const { base } = await boot()
  const oversized = Buffer.alloc(15 * 1024 * 1024 + 1)
  const form = new FormData()
  form.append('images', new Blob([oversized], { type: 'image/png' }), 'big.png')

  const response = await fetch(`${base}/api/uploads/images`, { method: 'POST', body: form })
  assert.equal(response.status, 413)
})

test('POST /api/uploads/images with no files is a 400', async () => {
  const { base } = await boot()
  const response = await fetch(`${base}/api/uploads/images`, { method: 'POST', body: new FormData() })
  assert.equal(response.status, 400)
})

// ---------------------------------------------------------------------------
// Preview navigation containment: an absolute-path link inside the previewed app
// (`<a href="/about">`, a logo/Home → `/`) resolves at the app origin and would
// otherwise load the whole workspace app inside the preview iframe (nested-preview
// bug). When a preview is active and the request came from inside it, bounce it
// back into the preview.

test('a preview-escaped absolute link redirects back into the active preview', async () => {
  const { base, previewTracker } = await boot()
  previewTracker.start('app', 'vite')

  const res = await fetch(`${base}/about`, {
    headers: { referer: `${base}/preview/app/` },
    redirect: 'manual',
  })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/preview/app/about')
})

test('a preview home link ("/") redirects into the preview root, not the app shell', async () => {
  const { base, previewTracker } = await boot()
  previewTracker.start('app', 'vite')

  const res = await fetch(`${base}/`, {
    headers: { referer: `${base}/preview/app/about` },
    redirect: 'manual',
  })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/preview/app/')
})

test('a top-level app request (no /preview/ referer) is NOT hijacked by an active preview', async () => {
  const webDist = mkdtempSync(join(tmpdir(), 'mce-dist-'))
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>mce</title>')
  const { base, previewTracker } = await boot({ ...DEV, webDist })
  previewTracker.start('app', 'vite')

  const res = await fetch(`${base}/settings`, { headers: { referer: `${base}/` }, redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.match(await res.text(), /<title>mce<\/title>/, 'still the SPA shell, not a redirect')
})

test('preview containment never touches /api requests, even with a /preview/ referer', async () => {
  const { base, previewTracker } = await boot()
  previewTracker.start('app', 'vite')

  const res = await fetch(`${base}/api/nope`, { headers: { referer: `${base}/preview/app/` }, redirect: 'manual' })
  // A 404 (not a 302) proves the hook left it alone — the exact body depends on
  // whether a web build is present, which isn't what this test is about.
  assert.equal(res.status, 404)
  assert.notEqual(res.headers.get('location'), '/preview/app/api/nope')
})

test('with no preview active, an escaped-looking request is not redirected', async () => {
  const { base } = await boot()
  const res = await fetch(`${base}/about`, { headers: { referer: 'http://x/preview/app/' }, redirect: 'manual' })
  assert.notEqual(res.status, 302)
})

test('POST /api/prompt with an unknown imageId is a 400, not a silent drop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-proot-'))
  mkdirSync(join(root, 'app'))
  execFileSync('git', ['-C', join(root, 'app'), 'init', '-q'])

  const { base } = await boot({ ...DEV, projectsRoot: root, claudeToken: 'test-token' }, { queryFn: fakeQueryFn })
  const response = await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'what is this?', projectId: 'app', threadId: 't1', imageIds: ['ghost.png'] }),
  })

  assert.equal(response.status, 400)
  assert.match(((await response.json()) as { error: string }).error, /unknown image/)
})
