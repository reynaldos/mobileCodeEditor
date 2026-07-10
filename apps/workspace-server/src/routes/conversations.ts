import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../session-manager.ts'

/**
 * Ends the live session and draws a line in the log. The next prompt starts a
 * conversation Claude has no memory of.
 *
 * Idempotent: resetting twice with nothing in between is harmless, it just
 * appends a second line.
 */
export function registerConversations(app: FastifyInstance, sessions: SessionManager): void {
  app.post('/api/conversations/new', async (_request, reply) => {
    await sessions.newConversation()
    return reply.code(204).send()
  })
}
