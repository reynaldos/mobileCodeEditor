import type { CreateProjectRequest, CreateProjectResponse, ProjectsResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import { CreateError, type ProjectStore } from '../projects.ts'

/**
 * Projects: list, and create (clone or init).
 *
 * Create returns 202 and does the slow git work in the background — the client
 * watches SSE for `project_created` / `project_create_failed`, because a clone
 * can take a while.
 */
export function registerProjects(app: FastifyInstance, projects: ProjectStore): void {
  app.get('/api/projects', async () => {
    return { projects: projects.list() } satisfies ProjectsResponse
  })

  app.post('/api/projects', async (request, reply) => {
    const body = (request.body ?? {}) as CreateProjectRequest
    const repoUrl = body.repoUrl?.trim()
    const name = body.name?.trim()

    if (!repoUrl && !name) {
      return reply.code(400).send({ error: 'provide a repo URL to clone, or a name to create' })
    }
    if (repoUrl && !looksLikeGitUrl(repoUrl)) {
      return reply.code(400).send({ error: 'that does not look like a git URL' })
    }

    try {
      const { projectId } = projects.create({
        ...(repoUrl ? { repoUrl } : {}),
        ...(name ? { name } : {}),
      })
      return reply.code(202).send({ projectId } satisfies CreateProjectResponse)
    } catch (err) {
      // Bad name / already exists — a client error, not a server one.
      if (err instanceof CreateError) return reply.code(409).send({ error: err.message })
      throw err
    }
  })
}

/** A loose gate — the real validation is whether `git clone` succeeds. */
function looksLikeGitUrl(url: string): boolean {
  return /^https?:\/\/.+/.test(url) || /^git@.+:.+/.test(url) || /^ssh:\/\/.+/.test(url)
}
