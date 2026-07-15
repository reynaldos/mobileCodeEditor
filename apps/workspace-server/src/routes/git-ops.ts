import type {
  GitBranchesResponse,
  GitCheckoutRequest,
  GitCommitRequest,
  GitDiscardRequest,
  GitOpResponse,
  GitStashListResponse,
  GitStashRequest,
} from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import {
  checkoutBranch,
  commitPaths,
  discardPaths,
  isValidBranchName,
  listBranches,
  listStashes,
  stashAction,
} from '../git-changes.ts'
import type { ProjectStore } from '../projects.ts'

/**
 * Manual, local-only source control (Phase 6 slice): list/switch/create branches,
 * manage the stash, and commit a reviewed set of files. Nothing here reaches a
 * remote — push/pull stay the existing ff-only refresh — so no operation needs
 * credentials. Git errors come back as `{ ok:false, error }` (200) so the client
 * can render the message inline; only an unknown project is an HTTP error.
 */
export function registerGitOps(app: FastifyInstance, projects: ProjectStore): void {
  /** Resolve+guard the project dir, or send 404. Returns the cwd, or undefined if it replied. */
  function cwdOr404(projectId: string, reply: import('fastify').FastifyReply): string | undefined {
    const cwd = projects.pathOf(projectId)
    if (!cwd || !projects.exists(projectId)) {
      void reply.code(404).send({ error: 'no such project' })
      return undefined
    }
    return cwd
  }

  app.get('/api/projects/:projectId/git/branches', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const cwd = cwdOr404(projectId, reply)
    if (!cwd) return reply
    return reply.send((await listBranches(cwd)) satisfies GitBranchesResponse)
  })

  app.post('/api/projects/:projectId/git/checkout', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const cwd = cwdOr404(projectId, reply)
    if (!cwd) return reply

    const { branch, create } = (request.body ?? {}) as GitCheckoutRequest
    if (typeof branch !== 'string' || !branch.trim()) {
      return reply.send({ ok: false, error: 'A branch name is required.' } satisfies GitOpResponse)
    }
    // Creating a new branch must pass the name filter; switching to an existing
    // one is looked up by exact match so an odd historical name still works.
    if (create && !isValidBranchName(branch)) {
      return reply.send({ ok: false, error: 'That isn’t a valid branch name.' } satisfies GitOpResponse)
    }

    const result = await checkoutBranch(cwd, branch, create === true)
    return reply.send({ ok: result.ok, ...(result.ok ? {} : { error: cleanGitError(result.stderr) }) } satisfies GitOpResponse)
  })

  app.get('/api/projects/:projectId/git/stash', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const cwd = cwdOr404(projectId, reply)
    if (!cwd) return reply
    return reply.send({ stashes: await listStashes(cwd) } satisfies GitStashListResponse)
  })

  app.post('/api/projects/:projectId/git/stash', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const cwd = cwdOr404(projectId, reply)
    if (!cwd) return reply

    const { action, index, message } = (request.body ?? {}) as GitStashRequest
    if (action !== 'save' && action !== 'pop' && action !== 'apply' && action !== 'drop') {
      return reply.send({ ok: false, error: 'Unknown stash action.' } satisfies GitOpResponse)
    }
    const at = typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : 0
    const result = await stashAction(cwd, action, at, typeof message === 'string' ? message : undefined)
    return reply.send({ ok: result.ok, ...(result.ok ? {} : { error: cleanGitError(result.stderr) }) } satisfies GitOpResponse)
  })

  app.post('/api/projects/:projectId/git/commit', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const cwd = cwdOr404(projectId, reply)
    if (!cwd) return reply

    const { message, paths } = (request.body ?? {}) as GitCommitRequest
    if (typeof message !== 'string' || !message.trim()) {
      return reply.send({ ok: false, error: 'A commit message is required.' } satisfies GitOpResponse)
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      return reply.send({ ok: false, error: 'Select at least one file to commit.' } satisfies GitOpResponse)
    }
    if (!safePaths(paths)) return reply.send({ ok: false, error: 'Invalid file path.' } satisfies GitOpResponse)

    const result = await commitPaths(cwd, message, paths)
    return reply.send({ ok: result.ok, ...(result.ok ? {} : { error: cleanGitError(result.stderr) }) } satisfies GitOpResponse)
  })

  app.post('/api/projects/:projectId/git/discard', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const cwd = cwdOr404(projectId, reply)
    if (!cwd) return reply

    const { paths } = (request.body ?? {}) as GitDiscardRequest
    if (!Array.isArray(paths) || paths.length === 0) {
      return reply.send({ ok: false, error: 'Select at least one file to discard.' } satisfies GitOpResponse)
    }
    if (!safePaths(paths)) return reply.send({ ok: false, error: 'Invalid file path.' } satisfies GitOpResponse)

    const result = await discardPaths(cwd, paths)
    return reply.send({ ok: result.ok, ...(result.ok ? {} : { error: cleanGitError(result.stderr) }) } satisfies GitOpResponse)
  })
}

/** Paths feed `git` argv directly (no shell); every one must be a plain relative path inside the repo. */
function safePaths(paths: unknown[]): paths is string[] {
  return paths.every((p) => typeof p === 'string' && p.length > 0 && !p.includes('..') && !p.startsWith('/'))
}

/** Trim git's stderr to a single readable line for the client. */
function cleanGitError(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('hint:'))
  if (!line) return 'git command failed'
  // Missing identity is the common first-commit snag — point at the fix.
  if (/please tell me who you are|user\.email|user\.name/i.test(stderr)) {
    return 'Git needs an identity to commit. Set user.name and user.email for this repo.'
  }
  return line.replace(/^(error|fatal):\s*/i, '')
}
