import type { GitStatusResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import { changedFiles, EMPTY_TREE_SHA, hasRemote, headSha, upstreamStatus } from '../git-changes.ts'
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

    // No HEAD yet (fresh `git init`, or a clone of a brand-new empty GitHub repo)
    // → diff against the empty tree so untracked/staged files still show up as
    // "added" instead of the Changes list silently reporting nothing.
    const head = await headSha(cwd)
    const base = head ?? EMPTY_TREE_SHA
    const files = await changedFiles(cwd, base)
    // Cheap (no network): reflects the last fetch, like `git status`. The
    // refresh endpoint is what fetches to bring these counts up to date.
    const upstream = await upstreamStatus(cwd)
    // `hasRemote` without `upstream` is what surfaces the Publish action — origin
    // exists but the branch isn't tracking it yet.
    const remote = await hasRemote(cwd)
    return reply.send({ base, files, ...(upstream ? { upstream } : {}), hasRemote: remote } satisfies GitStatusResponse)
  })
}
