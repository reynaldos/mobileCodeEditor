import type { PreviewConflictResponse, PreviewStreamMessage, StartPreviewRequest } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import { PreviewConflictError, PreviewUnsupportedError, type PreviewManager } from '../preview-manager.ts'
import type { PreviewTracker } from '../preview-tracker.ts'

const PING_MS = 20_000

/**
 * Live dev-server output for the active preview (Phase 5), on its own SSE
 * stream — same split `registerBuild` makes: high-volume, ephemeral output
 * stays off the durable log. A joining client gets a `snapshot` (current
 * phase + buffered lines) then live `line`/`phase` messages.
 *
 * The actual iframe traffic (HTML/JS/HMR websocket) does not go through this
 * route — that's the `@fastify/http-proxy` registration in server.ts. This is
 * only the terminal-style status feed for the drawer's "Show output" toggle
 * and its starting/ready/error state.
 */
export function registerPreview(app: FastifyInstance, previews: PreviewManager, tracker: PreviewTracker, config: Config): void {
  app.get('/api/projects/:projectId/preview/stream', (request, reply) => {
    const { projectId } = request.params as { projectId: string }

    reply.hijack()
    const res = reply.raw

    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
    // hijack() bypasses @fastify/cors — mirror the build/events routes (dev only).
    const origin = request.headers.origin
    if (config.isDev && origin) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Vary'] = 'Origin'
    }
    res.writeHead(200, headers)
    res.flushHeaders?.()

    const write = (m: PreviewStreamMessage): void => {
      res.write(`data: ${JSON.stringify(m)}\n\n`)
    }

    const snapshot = tracker.snapshot(projectId)
    write({
      type: 'snapshot',
      snapshot: snapshot ?? { projectId, phase: 'stopped', lines: [] },
    })

    const unsubscribe = tracker.subscribe(projectId, write)
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)

    const cleanup = (): void => {
      clearInterval(ping)
      unsubscribe()
    }
    request.raw.on('close', cleanup)
    res.on('error', cleanup)
  })

  app.post('/api/projects/:projectId/preview/start', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const { force } = (request.body as StartPreviewRequest | undefined) ?? {}

    try {
      await previews.start(projectId, { force })
      return reply.code(202).send()
    } catch (err) {
      if (err instanceof PreviewConflictError) {
        const body: PreviewConflictResponse = { error: err.message, activeProjectId: err.activeProjectId }
        return reply.code(409).send(body)
      }
      if (err instanceof PreviewUnsupportedError) {
        return reply.code(422).send({ error: err.message })
      }
      throw err
    }
  })

  // Always 'closed' — a user-initiated stop from the drawer. idle-timeout and
  // crashed are recorded by PreviewManager itself, not reachable from a route.
  app.post('/api/projects/:projectId/preview/stop', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    await previews.stop(projectId, 'closed')
    return reply.code(202).send()
  })
}
