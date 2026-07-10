import type { ApprovalRequest } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../session-manager.ts'

/**
 * Resolves the promise `canUseTool` is parked on. The other half of the
 * approval bridge; see session.ts.
 */
export function registerApprovals(app: FastifyInstance, sessions: SessionManager): void {
  app.post('/api/approvals/:approvalId', async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string }
    const body = request.body as Partial<ApprovalRequest> | undefined

    if (typeof body?.allow !== 'boolean') {
      return reply.code(400).send({ error: 'allow must be a boolean' })
    }

    const outcome = sessions.resolveApproval(approvalId, body.allow, body.reason)
    if (outcome === 'not_pending') {
      // Already decided, expired on a restart, or never existed. Idempotent by
      // way of being loudly wrong rather than silently accepted.
      return reply.code(409).send({ error: 'approval is not pending' })
    }

    return reply.code(204).send()
  })
}
