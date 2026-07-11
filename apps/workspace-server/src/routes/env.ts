import type { EnvFileResponse, SaveEnvRequest } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { keysWithBlankValues, parseEnv, serializeEnv } from '../env-file.ts'
import type { ProjectStore } from '../projects.ts'

/**
 * The per-project `.env` editor (Phase 2.7). Reads/writes the project's own
 * `.env` directly — guarded by `pathOf`, only ever that one file. Values are
 * secrets, so nothing here touches the event log; the file write is the state.
 */
export function registerEnv(app: FastifyInstance, projects: ProjectStore): void {
  const dirFor = (id: string): string | undefined => (projects.exists(id) ? projects.pathOf(id) : undefined)

  app.get('/api/projects/:projectId/env', async (request, reply) => {
    const dir = dirFor((request.params as { projectId: string }).projectId)
    if (!dir) return reply.code(404).send({ error: 'no such project' })

    const envPath = join(dir, '.env')
    const entries = existsSync(envPath) ? parseEnv(await readFile(envPath, 'utf8')) : []
    return reply.send({ entries, hasExample: existsSync(join(dir, '.env.example')) } satisfies EnvFileResponse)
  })

  app.put('/api/projects/:projectId/env', async (request, reply) => {
    const dir = dirFor((request.params as { projectId: string }).projectId)
    if (!dir) return reply.code(404).send({ error: 'no such project' })

    const body = request.body as Partial<SaveEnvRequest> | undefined
    if (!Array.isArray(body?.entries)) return reply.code(400).send({ error: 'entries must be an array' })

    // 0600 — a secrets file the owner alone can read.
    await writeFile(join(dir, '.env'), serializeEnv(body.entries), { mode: 0o600 })
    return reply.code(204).send()
  })

  // Propose a scaffold from .env.example (keys, blank values). Doesn't write —
  // the editor shows it, you fill values, then Save.
  app.post('/api/projects/:projectId/env/init', async (request, reply) => {
    const dir = dirFor((request.params as { projectId: string }).projectId)
    if (!dir) return reply.code(404).send({ error: 'no such project' })

    const example = join(dir, '.env.example')
    const entries = existsSync(example) ? keysWithBlankValues(await readFile(example, 'utf8')) : []
    return reply.send({ entries, hasExample: existsSync(example) } satisfies EnvFileResponse)
  })
}
