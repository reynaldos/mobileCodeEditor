import type { NewConversationRequest } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../session-manager.ts'

/**
 * Ends one project's live session and draws a line in its log. The next prompt
 * for that project starts a conversation Claude has no memory of.
 *
 * Idempotent: resetting twice with nothing in between is harmless, it just
 * appends a second line.
 */
export function registerConversations(app: FastifyInstance, sessions: SessionManager): void {
  app.post('/api/conversations/new', async (request, reply) => {
    const projectId = (request.body as Partial<NewConversationRequest> | undefined)?.projectId?.trim()
    if (!projectId) return reply.code(400).send({ error: 'projectId is required' })

    await sessions.newConversation(projectId)
    return reply.code(204).send()
  })
}
