import { LEGACY_THREAD_ID, type NewThreadResponse, type Thread, type ThreadsResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { EventLog } from '../log.ts'
import type { ProjectStore } from '../projects.ts'
import { UnknownProjectError, type SessionManager } from '../session-manager.ts'

/**
 * Per-project threads (Phase 2.5): list them, or mint a new one. The legacy
 * bucket (thread_id NULL) surfaces as a read-only thread with a sentinel id.
 */
export function registerThreads(
  app: FastifyInstance,
  log: EventLog,
  projects: ProjectStore,
  sessions: SessionManager,
): void {
  app.get('/api/projects/:projectId/threads', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    if (!projects.exists(projectId)) return reply.code(404).send({ error: 'no such project' })

    const threads: Thread[] = log.threadsOf(projectId).map((t) => ({
      id: t.id ?? LEGACY_THREAD_ID,
      projectId,
      title: t.title,
      lastActivity: t.lastActivity,
      messageCount: t.messageCount,
      ...(t.id === null ? { legacy: true } : {}),
    }))
    return reply.send({ threads } satisfies ThreadsResponse)
  })

  app.post('/api/projects/:projectId/threads', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    try {
      const threadId = sessions.newThread(projectId)
      return reply.code(201).send({ threadId } satisfies NewThreadResponse)
    } catch (err) {
      if (err instanceof UnknownProjectError) return reply.code(404).send({ error: err.message })
      throw err
    }
  })
}
