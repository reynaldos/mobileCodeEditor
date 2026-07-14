import type {
  CreateProjectRequest,
  CreateProjectResponse,
  ProjectsResponse,
  RemoveProjectConflictResponse,
  RemoveProjectRequest,
} from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { EventLog } from '../log.ts'
import type { PreviewManager } from '../preview-manager.ts'
import type { PreviewTracker } from '../preview-tracker.ts'
import { CreateError, InstallError, RemoveError, type ProjectStore } from '../projects.ts'
import type { SessionManager } from '../session-manager.ts'
import type { BuildTracker } from '../build-tracker.ts'

/**
 * Projects: list, create (clone or init), and remove (offload).
 *
 * Create returns 202 and does the slow git work in the background — the client
 * watches SSE for `project_created` / `project_create_failed`, because a clone
 * can take a while.
 */
export function registerProjects(
  app: FastifyInstance,
  projects: ProjectStore,
  sessions: SessionManager,
  builds: BuildTracker,
  previews: PreviewManager,
  previewTracker: PreviewTracker,
  log: EventLog,
): void {
  app.get('/api/projects', async () => {
    return { projects: projects.list() } satisfies ProjectsResponse
  })

  // Re-run dependency install for a project that has none (a failed/absent install
  // on clone) — the fix for a preview that dies with `spawn .../.bin/next ENOENT`.
  // 202 + the build stream carries progress, same as create.
  app.post('/api/projects/:projectId/install', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    if (!projects.exists(projectId)) return reply.code(404).send({ error: 'no such project' })
    if (builds.isActive(projectId)) return reply.code(409).send({ error: 'a build is already in progress' })
    try {
      projects.install(projectId)
      return reply.code(202).send()
    } catch (err) {
      if (err instanceof InstallError) return reply.code(400).send({ error: err.message })
      throw err
    }
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

  // Remove ("offload") a project's local directory only — never the git
  // remote. Blocked by a live session / in-flight build / active preview
  // unless `force`, same shape as preview's start-with-force eviction: the
  // client shows a confirm dialog listing what's still using the project,
  // then retries with `force: true` to stop all of it first.
  app.delete('/api/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const { force } = (request.body ?? {}) as RemoveProjectRequest

    if (!projects.exists(projectId)) return reply.code(404).send({ error: 'no such project' })

    const blockers: string[] = []
    if (builds.isActive(projectId)) blockers.push('a build is in progress')
    if (sessions.hasLiveSession(projectId)) blockers.push('a conversation is still active')
    if (previewTracker.activeProjectId() === projectId) blockers.push('the preview is running')

    if (blockers.length > 0 && !force) {
      const body: RemoveProjectConflictResponse = { error: `Can't remove — ${blockers.join(', ')}.`, blockers }
      return reply.code(409).send(body)
    }

    if (builds.isActive(projectId)) builds.cancel(projectId)
    if (previewTracker.activeProjectId() === projectId) await previews.stop(projectId, 'closed')
    await sessions.closeProject(projectId)

    try {
      projects.remove(projectId)
    } catch (err) {
      if (err instanceof RemoveError) return reply.code(404).send({ error: err.message })
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
    log.append({ type: 'project_removed', sessionId: 'system', projectId, ts: Date.now() })
    return reply.code(204).send()
  })
}

/** A loose gate — the real validation is whether `git clone` succeeds. */
function looksLikeGitUrl(url: string): boolean {
  return /^https?:\/\/.+/.test(url) || /^git@.+:.+/.test(url) || /^ssh:\/\/.+/.test(url)
}
