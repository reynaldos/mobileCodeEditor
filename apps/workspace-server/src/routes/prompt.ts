import type { PromptRequest, PromptResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../session-manager.ts'

/**
 * Returns 202 immediately. Everything that happens next arrives over SSE —
 * the response body is not where the answer lives.
 */
export function registerPrompt(app: FastifyInstance, sessions: SessionManager): void {
  app.post('/api/prompt', async (request, reply) => {
    const body = request.body as Partial<PromptRequest> | undefined
    const text = body?.text?.trim()

    if (!text) return reply.code(400).send({ error: 'text is required' })

    try {
      // Continues the last conversation unless explicitly told not to.
      const sessionId = await sessions.prompt(text, { fresh: body?.fresh === true })
      return reply.code(202).send({ sessionId } satisfies PromptResponse)
    } catch (err) {
      // Almost always a missing CLAUDE_CODE_OAUTH_TOKEN. Say so plainly.
      request.log.error({ err }, 'failed to start or feed session')
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
