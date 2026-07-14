import type { GitStatusResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import { changedFiles, headSha, upstreamStatus } from '../git-changes.ts'
import type { ProjectStore } from '../projects.ts'

/**
 * Read-only Source control view (Phase 3): working tree vs HEAD. Reuses
 * `git-changes.ts`'s `headSha`/`changedFiles` — the same helpers the
 * post-turn changes accordion (Phase 2.7) already exercises — supplying
 * `base = HEAD` instead of a turn-start sha. Per-file diffs reuse the
 * existing `GET /api/projects/:id/changes?base=&path=` route; there is no
 * separate diff endpoint. Staging, commit, and push are Phase 6, not built
 * here (PHASE-3.md design call 4).
 */
export function registerGitStatus(app: FastifyInstance, projects: ProjectStore): void {
  app.get('/api/projects/:projectId/git/status', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const cwd = projects.pathOf(projectId)
    if (!cwd || !projects.exists(projectId)) return reply.code(404).send({ error: 'no such project' })

    const base = await headSha(cwd)
    const files = base ? await changedFiles(cwd, base) : []
    // Cheap (no network): reflects the last fetch, like `git status`. The
    // refresh endpoint is what fetches to bring these counts up to date.
    const upstream = await upstreamStatus(cwd)
    return reply.send({ base, files, ...(upstream ? { upstream } : {}) } satisfies GitStatusResponse)
  })
}
