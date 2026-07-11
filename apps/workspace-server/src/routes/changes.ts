import type { FileDiffResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import { fileDiff } from '../git-changes.ts'
import type { ProjectStore } from '../projects.ts'

/**
 * Per-file diff for the post-turn changes accordion (Phase 2.7). The file list +
 * counts ride the durable `turn_changes` event; the diff body is fetched here on
 * expand so it never enters the log.
 */
export function registerChanges(app: FastifyInstance, projects: ProjectStore): void {
  app.get('/api/projects/:projectId/changes', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const { base, path } = request.query as { base?: string; path?: string }

    const cwd = projects.pathOf(projectId)
    if (!cwd || !projects.exists(projectId)) return reply.code(404).send({ error: 'no such project' })
    if (!base || !path) return reply.code(400).send({ error: 'base and path are required' })
    // `base` is a sha and `path` a repo-relative file; both feed `git` argv (no
    // shell). Reject a path that tries to climb out of the repo.
    if (path.includes('..')) return reply.code(400).send({ error: 'invalid path' })

    const { before, after } = await fileDiff(cwd, base, path)
    return reply.send({ path, before, after } satisfies FileDiffResponse)
  })
}
