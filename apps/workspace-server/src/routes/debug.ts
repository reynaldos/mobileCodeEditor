import type { EventBody } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import type { EventLog } from '../log.ts'

/**
 * The highest-leverage twenty lines in the project.
 *
 * Appends an arbitrary event, which lets you build and verify SSE, replay, and
 * reconnect BEFORE the agent exists — no tokens burned, no waiting on Claude to
 * think. Dev only.
 *
 *   curl -X POST localhost:3000/api/_debug/event \
 *     -H 'content-type: application/json' \
 *     -d '{"type":"assistant_text","text":"hello from the void"}'
 */
export function registerDebug(app: FastifyInstance, log: EventLog, config: Config): void {
  if (!config.isDev) return

  app.post('/api/_debug/event', async (request, reply) => {
    const body = request.body as (EventBody & { sessionId?: string }) | undefined
    if (!body?.type) return reply.code(400).send({ error: 'type is required' })

    const event = log.append({
      sessionId: body.sessionId ?? 'debug',
      projectId: config.projectId,
      ts: Date.now(),
      ...body,
    })
    return reply.code(201).send(event)
  })

  app.get('/api/_debug/log', async () => ({
    lastSeq: log.lastSeq(),
    subscribers: log.subscriberCount,
    pendingApprovals: log.pendingApprovals(),
    openSessions: log.openSessions(),
  }))
}
