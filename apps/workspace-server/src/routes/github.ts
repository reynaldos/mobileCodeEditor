import type { GithubReposResponse, NameCheckResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { Github } from '../github.ts'
import { sanitizeProjectName, type ProjectStore } from '../projects.ts'

/**
 * GitHub-backed helpers for the picker: clone suggestions and create-name checks.
 * Both degrade to 503 when gh isn't configured — the client falls back to a plain
 * URL paste / local create.
 */
export function registerGithub(
  app: FastifyInstance,
  projects: ProjectStore,
  github: Github | undefined,
): void {
  app.get('/api/github/repos', async (request, reply) => {
    if (!github) return reply.code(503).send({ error: 'github is not configured' })
    const q = (request.query as { q?: string }).q ?? ''
    try {
      const repos = await github.listRepos(q)
      return reply.send({ repos } satisfies GithubReposResponse)
    } catch (err) {
      request.log.warn({ err }, 'gh listRepos failed')
      return reply.code(503).send({ error: 'could not reach GitHub' })
    }
  })

  app.get('/api/github/check-name', async (request, reply) => {
    if (!github) return reply.code(503).send({ error: 'github is not configured' })
    const raw = (request.query as { name?: string }).name ?? ''
    const name = sanitizeProjectName(raw)

    let owner = ''
    try {
      owner = await github.login()
    } catch {
      return reply.code(503).send({ error: 'could not reach GitHub' })
    }

    if (!name) {
      return reply.send({ name, owner, available: false, reason: 'invalid' } satisfies NameCheckResponse)
    }
    if (projects.exists(name)) {
      return reply.send({ name, owner, available: false, reason: 'exists-local' } satisfies NameCheckResponse)
    }

    try {
      const remote = await github.repoExists(name)
      return reply.send({
        name,
        owner,
        available: !remote,
        ...(remote ? { reason: 'exists-remote' as const } : {}),
      } satisfies NameCheckResponse)
    } catch (err) {
      request.log.warn({ err }, 'gh repoExists failed')
      return reply.code(503).send({ error: 'could not reach GitHub' })
    }
  })
}
