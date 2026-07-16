import type { FsFileResponse, FsSearchResponse, FsTreeResponse, FsWriteRequest } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import { listDir, readTextFile, searchFiles, writeTextFile } from '../fs-browser.ts'
import type { ProjectStore } from '../projects.ts'

/** Editor Save cap — matches the reader's `MAX_FILE_BYTES`, with headroom for JSON framing. */
const WRITE_BODY_LIMIT = 4 * 1024 * 1024

/**
 * File browser + read-only viewer RPC (Phase 3). Plain request/response, no
 * event-log traffic — see PROTOCOL.md "Later additions". `path` query params
 * are always repo-relative; `fs-browser.ts`'s `resolveSafe` is the one place
 * that ever turns one into an absolute filesystem path.
 */
export function registerFs(app: FastifyInstance, projects: ProjectStore): void {
  const rootFor = (id: string): string | undefined => (projects.exists(id) ? projects.pathOf(id) : undefined)

  app.get('/api/projects/:projectId/fs/tree', async (request, reply) => {
    const root = rootFor((request.params as { projectId: string }).projectId)
    if (!root) return reply.code(404).send({ error: 'no such project' })

    const path = ((request.query as { path?: string }).path ?? '').trim()
    const listing = listDir(root, path)
    if (!listing) return reply.code(404).send({ error: 'no such directory' })
    return reply.send({ path, ...listing } satisfies FsTreeResponse)
  })

  app.get('/api/projects/:projectId/fs/file', async (request, reply) => {
    const root = rootFor((request.params as { projectId: string }).projectId)
    if (!root) return reply.code(404).send({ error: 'no such project' })

    const path = (request.query as { path?: string }).path
    if (!path) return reply.code(400).send({ error: 'path is required' })

    const content = readTextFile(root, path)
    if (content === undefined) return reply.code(404).send({ error: 'no such file, too large, or not text' })
    return reply.send({ path, content } satisfies FsFileResponse)
  })

  // The editor's Save. A direct user write — not the agent's approval-gated path.
  app.put('/api/projects/:projectId/fs/file', { bodyLimit: WRITE_BODY_LIMIT }, async (request, reply) => {
    const root = rootFor((request.params as { projectId: string }).projectId)
    if (!root) return reply.code(404).send({ error: 'no such project' })

    const { path, content } = (request.body ?? {}) as FsWriteRequest
    if (typeof path !== 'string' || !path) return reply.code(400).send({ error: 'path is required' })
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content is required' })

    const result = writeTextFile(root, path, content)
    if (result === 'invalid') return reply.code(400).send({ error: 'invalid path, a directory, or too large' })
    if (result === 'error') return reply.code(500).send({ error: 'could not write the file' })
    return reply.code(204).send()
  })

  app.get('/api/projects/:projectId/fs/search', async (request, reply) => {
    const root = rootFor((request.params as { projectId: string }).projectId)
    if (!root) return reply.code(404).send({ error: 'no such project' })

    const query = (request.query as { q?: string }).q ?? ''
    const { matches, truncated } = await searchFiles(root, query)
    return reply.send({ query, matches, truncated } satisfies FsSearchResponse)
  })
}
