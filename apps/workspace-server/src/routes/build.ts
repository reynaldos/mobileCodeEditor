import type { BuildStreamMessage } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { BuildTracker } from '../build-tracker.ts'
import type { Config } from '../config.ts'
import type { ProjectStore } from '../projects.ts'

const PING_MS = 20_000

/**
 * Live setup output for one project (Phase 2.6), on its own SSE stream — kept off
 * the durable log because git/npm output is high-volume and ephemeral. A joining
 * client gets a `snapshot` (current phase + buffered lines) then live `line` /
 * `phase` messages until the build resolves.
 */
export function registerBuild(
  app: FastifyInstance,
  builds: BuildTracker,
  projects: ProjectStore,
  config: Config,
): void {
  app.get('/api/projects/:projectId/build', (request, reply) => {
    const { projectId } = request.params as { projectId: string }

    reply.hijack()
    const res = reply.raw

    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
    // hijack() bypasses @fastify/cors — mirror the events route (dev only).
    const origin = request.headers.origin
    if (config.isDev && origin) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Vary'] = 'Origin'
    }
    res.writeHead(200, headers)
    res.flushHeaders?.()

    const write = (m: BuildStreamMessage): void => {
      res.write(`data: ${JSON.stringify(m)}\n\n`)
    }

    const snapshot = builds.snapshot(projectId)
    if (snapshot) {
      write({ type: 'snapshot', snapshot })
    } else {
      // No live or retained build — infer a terminal state from existence so the
      // client resolves instead of hanging (build finished + pruned, or a restart).
      const exists = projects.exists(projectId)
      write({
        type: 'snapshot',
        snapshot: {
          projectId,
          phase: exists ? 'ready' : 'error',
          lines: [],
          ...(exists ? {} : { error: 'No build in progress.' }),
        },
      })
    }

    const unsubscribe = builds.subscribe(projectId, write)
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)

    const cleanup = (): void => {
      clearInterval(ping)
      unsubscribe()
    }
    request.raw.on('close', cleanup)
    res.on('error', cleanup)
  })

  // Cancel a running build — SIGTERMs the child, and #build cleans up the dir.
  app.post('/api/projects/:projectId/build/cancel', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    if (!builds.cancel(projectId)) return reply.code(409).send({ error: 'no build in progress' })
    return reply.code(202).send()
  })
}
