import type { GitRefreshResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import { fastForwardToUpstream, headSha, isDirty, upstreamStatus } from '../git-changes.ts'
import type { ProjectStore } from '../projects.ts'

/**
 * Bring the current branch in sync with its remote — fetch, then fast-forward
 * only. A deliberately narrow, safe slice of source control (PHASE-3.md): it
 * refuses a dirty tree and a diverged branch rather than merging/rebasing or
 * clobbering uncommitted work. Stage/commit/push/stash and real conflict
 * handling are Phase 6; this exists so a branch that's simply behind can be
 * pulled forward without dropping to a terminal.
 *
 * Always 200 with a `GitRefreshResponse` for the expected outcomes (done /
 * dirty / diverged / no-upstream) so the client renders each specifically;
 * only an unknown project is an HTTP error.
 */
export function registerGitRefresh(app: FastifyInstance, projects: ProjectStore): void {
  app.post('/api/projects/:projectId/git/refresh', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const cwd = projects.pathOf(projectId)
    if (!cwd || !projects.exists(projectId)) return reply.code(404).send({ error: 'no such project' })

    const before = await upstreamStatus(cwd)
    if (!before) return reply.send({ ok: false, reason: 'no-upstream' } satisfies GitRefreshResponse)

    // Never fast-forward over uncommitted work — commit or stash first.
    if (await isDirty(cwd)) {
      return reply.send({ ok: false, reason: 'dirty', upstream: before } satisfies GitRefreshResponse)
    }

    const result = await fastForwardToUpstream(cwd)
    const upstream = await upstreamStatus(cwd) // recount after the fetch
    if (result !== 'ok') {
      return reply.send({ ok: false, reason: result, ...(upstream ? { upstream } : {}) } satisfies GitRefreshResponse)
    }
    const base = await headSha(cwd)
    return reply.send({ ok: true, base, ...(upstream ? { upstream } : {}) } satisfies GitRefreshResponse)
  })
}
