import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Config } from './config.ts'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import { Pusher } from './push.ts'
import { PushStore } from './push-store.ts'
import { makeRedactor } from './redact.ts'
import { buildServer } from './server.ts'
import { SessionManager } from './session-manager.ts'

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
  claudeToken: undefined,
  model: undefined,
  isDev: true,
  webDist: '/nonexistent-so-static-serving-is-skipped',
  vapid: undefined,
}

const teardown: Array<() => Promise<void>> = []
after(async () => {
  for (const fn of teardown) await fn()
})

async function boot(config: Config = DEV): Promise<{ base: string; log: EventLog }> {
  const db = openDb(':memory:')
  const log = new EventLog(db, makeRedactor([]))
  const pushStore = new PushStore(db)
  const app = await buildServer(config, {
    log,
    sessions: new SessionManager(log, config),
    pushStore,
    pusher: new Pusher(pushStore, config.vapid),
  })
  app.log.level = 'silent'

  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no port')

  teardown.push(() => app.close())
  return { base: `http://127.0.0.1:${address.port}`, log }
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

test('prompting without a token is a 503 that says what to do', async () => {
  const { base } = await boot()
  const response = await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  })

  assert.equal(response.status, 503)
  assert.match(((await response.json()) as { error: string }).error, /CLAUDE_CODE_OAUTH_TOKEN/)
})
