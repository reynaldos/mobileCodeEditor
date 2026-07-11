import { LEGACY_THREAD_ID, type PromptRequest, type PromptResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import { SessionManager, UnknownProjectError } from '../session-manager.ts'

/**
 * Returns 202 immediately. Everything that happens next arrives over SSE —
 * the response body is not where the answer lives.
 */
export function registerPrompt(app: FastifyInstance, sessions: SessionManager): void {
  app.post('/api/prompt', async (request, reply) => {
    const body = request.body as Partial<PromptRequest> | undefined
    const text = body?.text?.trim()
    const projectId = body?.projectId?.trim()
    const threadId = body?.threadId?.trim()

    if (!text) return reply.code(400).send({ error: 'text is required' })
    if (!projectId) return reply.code(400).send({ error: 'projectId is required' })
    if (!threadId) return reply.code(400).send({ error: 'threadId is required' })
    if (threadId === LEGACY_THREAD_ID) {
      return reply.code(400).send({ error: 'the earlier conversation is read-only — start a new thread' })
    }

    try {
      const sessionId = await sessions.prompt(projectId, threadId, text)
      return reply.code(202).send({ sessionId } satisfies PromptResponse)
    } catch (err) {
      if (err instanceof UnknownProjectError) {
        return reply.code(404).send({ error: err.message })
      }
      // Almost always a missing CLAUDE_CODE_OAUTH_TOKEN. Say so plainly.
      request.log.error({ err }, 'failed to start or feed session')
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
