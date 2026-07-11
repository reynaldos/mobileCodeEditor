import type { PresenceRequest } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { Presence } from '../presence.ts'

/** The page reporting its own Page Visibility state. See presence.ts for why. */
export function registerPresence(app: FastifyInstance, presence: Presence): void {
  app.post('/api/presence', async (request, reply) => {
    const body = request.body as Partial<PresenceRequest> | undefined
    if (typeof body?.clientId !== 'string' || !body.clientId || typeof body.visible !== 'boolean') {
      return reply.code(400).send({ error: 'clientId and visible are required' })
    }

    presence.set(body.clientId, body.visible)
    return reply.code(204).send()
  })
}
