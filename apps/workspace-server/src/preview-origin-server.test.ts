import assert from 'node:assert/strict'
import http from 'node:http'
import { after, test } from 'node:test'
import type { Config } from './config.ts'
import { buildPreviewOriginServer } from './preview-origin-server.ts'
import { PreviewTracker } from './preview-tracker.ts'

/**
 * Unlike `server.test.ts`'s `boot()`, this stands up a real (plain `node:http`,
 * no Fastify) "dev server" on `previewPort` too — this listener's whole job is
 * proxying to it, so there's nothing to assert without one on the other end.
 */
let nextPort = 35000 + (process.pid % 10000)

const teardown: Array<() => Promise<void>> = []
after(async () => {
  for (const fn of teardown) await fn()
})

function config(previewPort: number): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    projectsRoot: '/nonexistent',
    uploadsRoot: '/nonexistent',
    claudeToken: undefined,
    model: undefined,
    isDev: true,
    webDist: '/nonexistent',
    vapid: undefined,
    previewPort,
    previewOriginPort: 0,
    previewIdleTimeoutMs: 30 * 60 * 1000,
  }
}

async function boot(upstream: http.RequestListener): Promise<{ base: string; previewTracker: PreviewTracker }> {
  const previewPort = nextPort++
  const upstreamServer = http.createServer(upstream)
  await new Promise<void>((resolve) => upstreamServer.listen(previewPort, '127.0.0.1', resolve))
  teardown.push(() => new Promise<void>((resolve) => upstreamServer.close(() => resolve())))

  const previewTracker = new PreviewTracker()
  const app = buildPreviewOriginServer(config(previewPort), previewTracker)
  app.log.level = 'silent'
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no port')

  teardown.push(() => app.close())
  return { base: `http://127.0.0.1:${address.port}`, previewTracker }
}

test('with no preview active, the dedicated origin is a 503', async () => {
  const { base } = await boot((_req, res) => res.end('should never be reached'))
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 503)
})

test('with a preview active, an HTML response gets the nav-reporter injected', async () => {
  const { base, previewTracker } = await boot((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<html><head></head><body>hi</body></html>')
  })
  previewTracker.start('demo', 'vite')

  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.match(body, /__mcePreviewUrl/, 'nav-reporter script spliced in')
  assert.match(body, /hi/, 'original body preserved')
})

test('a non-HTML response streams through untouched', async () => {
  const { base, previewTracker } = await boot((_req, res) => {
    res.setHeader('content-type', 'application/javascript')
    res.end('console.log("hi")')
  })
  previewTracker.start('demo', 'vite')

  const res = await fetch(`${base}/main.js`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'console.log("hi")')
})
