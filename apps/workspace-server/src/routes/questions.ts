import type { AnswerQuestionRequest } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../session-manager.ts'

/**
 * Answers a parked `AskUserQuestion` (Phase 2.7). The other half of the question
 * bridge in session.ts — resolves the `onUserDialog` promise the SDK is awaiting.
 */
export function registerQuestions(app: FastifyInstance, sessions: SessionManager): void {
  app.post('/api/questions/:requestId', async (request, reply) => {
    const { requestId } = request.params as { requestId: string }
    const body = request.body as Partial<AnswerQuestionRequest> | undefined

    if (!body?.answers || typeof body.answers !== 'object') {
      return reply.code(400).send({ error: 'answers must be an object' })
    }

    const outcome = sessions.answerQuestion(requestId, body.answers as Record<string, string>)
    if (outcome === 'not_pending') {
      return reply.code(409).send({ error: 'question is not pending' })
    }
    return reply.code(204).send()
  })
}
