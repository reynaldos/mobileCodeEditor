import type { StorageResponse } from '@mce/protocol'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import type { BuildTracker } from './build-tracker.ts'
import type { Config } from './config.ts'
import type { Github } from './github.ts'
import type { EventLog } from './log.ts'
import type { Presence } from './presence.ts'
import type { PreviewManager } from './preview-manager.ts'
import type { PreviewTracker } from './preview-tracker.ts'
import type { ProjectStore } from './projects.ts'
import type { Pusher } from './push.ts'
import type { PushStore } from './push-store.ts'
import { registerApprovals } from './routes/approvals.ts'
import { registerBuild } from './routes/build.ts'
import { registerChanges } from './routes/changes.ts'
import { registerDebug } from './routes/debug.ts'
import { registerEnv } from './routes/env.ts'
import { registerEvents } from './routes/events.ts'
import { registerFs } from './routes/fs.ts'
import { registerGithub } from './routes/github.ts'
import { registerGitOps } from './routes/git-ops.ts'
import { registerGitRefresh } from './routes/git-refresh.ts'
import { registerGitStatus } from './routes/git-status.ts'
import { registerTerminal } from './routes/terminal.ts'
import { registerPresence } from './routes/presence.ts'
import { registerPreview } from './routes/preview.ts'
import { registerProjects } from './routes/projects.ts'
import { registerPrompt } from './routes/prompt.ts'
import { registerPush } from './routes/push.ts'
import { registerQuestions } from './routes/questions.ts'
import { registerThreads } from './routes/threads.ts'
import { registerUploads } from './routes/uploads.ts'
import type { SessionManager } from './session-manager.ts'
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_UPLOAD, type UploadStore } from './uploads.ts'

export interface Services {
  log: EventLog
  sessions: SessionManager
  projects: ProjectStore
  builds: BuildTracker
  github: Github | undefined
  pushStore: PushStore
  pusher: Pusher
  presence: Presence
  uploads: UploadStore
  previews: PreviewManager
  previewTracker: PreviewTracker
}

export async function buildServer(config: Config, services: Services): Promise<FastifyInstance> {
  const { log, sessions, projects, builds, github, pushStore, pusher, presence, uploads, previews, previewTracker } = services
  const app = Fastify({
    logger: config.isDev
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
      : true,
  })

  // Production serves the PWA from this same origin, so there is no CORS
  // configuration in this project — only in dev, where Vite is on :5173.
  if (config.isDev) {
    await app.register(cors, { origin: true })
  }

  // These limits apply only to multipart/form-data parsing (busboy reads the
  // raw stream directly, bypassing Fastify's JSON `bodyLimit`) — so raising
  // them here does not weaken the default 1MB cap on every other route's body.
  await app.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_UPLOAD } })

  app.get('/api/health', async () => ({
    ok: true,
    lastSeq: log.lastSeq(),
    projectCount: projects.list().length,
    liveSessions: sessions.liveSessionCount,
    agentReady: Boolean(config.claudeToken),
    pushReady: pusher.enabled,
    previewOriginPort: config.previewOriginPort,
  }))

  // Disk usage of the volume holding the projects — surfaced as a bar on the
  // picker so a full volume (which crash-loops the whole server on ENOSPC) is
  // visible before it bites. `statfs` reports the real filesystem, so it counts
  // everything on the volume (clones + their node_modules, the log, uploads),
  // not just what a per-project `du` would find. `bavail` is space usable by the
  // non-root server; used = total − that, so reserved blocks read as used (the
  // safe direction for a "don't run out" gauge).
  app.get('/api/storage', async () => {
    const s = await statfs(config.projectsRoot)
    const total = s.blocks * s.bsize
    const free = s.bavail * s.bsize
    return { total, used: total - free, free } satisfies StorageResponse
  })

  registerEvents(app, log, config, presence)
  registerPresence(app, presence)
  registerProjects(app, projects, sessions, builds, previews, previewTracker, log)
  registerBuild(app, builds, projects, config)
  registerPreview(app, previews, previewTracker, config)
  registerChanges(app, projects)
  registerFs(app, projects)
  registerGitStatus(app, projects)
  registerGitRefresh(app, projects)
  registerGitOps(app, projects)
  registerEnv(app, projects)
  registerThreads(app, log, projects, sessions)
  registerGithub(app, projects, github)
  registerPrompt(app, sessions)
  registerApprovals(app, sessions)
  registerQuestions(app, sessions)
  registerPush(app, config, pushStore, pusher)
  registerDebug(app, log, config)
  registerUploads(app, uploads)
  registerTerminal(app, projects)

  // Serving the PWA from this same origin is what deletes CORS, mixed content,
  // and cross-service tokens from the project. See ARCHITECTURE.md.
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist })

    // Single-page app: anything that isn't /api/* is the client's route.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
      return reply.sendFile('index.html')
    })
  } else {
    app.log.warn(
      { webDist: config.webDist },
      'no web build found — API only. Run `pnpm --filter web build`, or use `vite dev` on :5173.',
    )
  }

  return app
}
