import {
  LEGACY_THREAD_ID,
  type NewThreadResponse,
  type RenameThreadRequest,
  type Thread,
  type ThreadsResponse,
} from '@mce/protocol'
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

  // Rename a thread — a `thread_renamed` event; the latest one wins as its title.
  app.patch('/api/projects/:projectId/threads/:threadId', async (request, reply) => {
    const { projectId, threadId } = request.params as { projectId: string; threadId: string }
    if (!projects.exists(projectId)) return reply.code(404).send({ error: 'no such project' })
    if (threadId === LEGACY_THREAD_ID) return reply.code(400).send({ error: 'the legacy thread is read-only' })

    const { title } = (request.body ?? {}) as Partial<RenameThreadRequest>
    const clean = (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!clean) return reply.code(400).send({ error: 'title required' })

    log.append({ type: 'thread_renamed', title: clean, sessionId: 'system', projectId, threadId, ts: Date.now() })
    return reply.code(204).send()
  })

  // Delete a thread — stop any live session, then hide it with a `thread_deleted`
  // event. The conversation stays in the log; it just drops out of the list.
  app.delete('/api/projects/:projectId/threads/:threadId', async (request, reply) => {
    const { projectId, threadId } = request.params as { projectId: string; threadId: string }
    if (!projects.exists(projectId)) return reply.code(404).send({ error: 'no such project' })
    if (threadId === LEGACY_THREAD_ID) return reply.code(400).send({ error: 'the legacy thread is read-only' })

    await sessions.closeThread(projectId, threadId)
    log.append({ type: 'thread_deleted', sessionId: 'system', projectId, threadId, ts: Date.now() })
    return reply.code(204).send()
  })
}
