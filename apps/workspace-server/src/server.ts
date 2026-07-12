import cors from '@fastify/cors'
import httpProxy from '@fastify/http-proxy'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
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
import { registerGithub } from './routes/github.ts'
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

  // Preview (Phase 5): the iframe's traffic (HTML/JS/HMR websocket), reverse-
  // proxied same-origin rather than a second Tailscale port mapping — see
  // PHASE-5.md design call 1. `rewritePrefix` mirrors `prefix` exactly so this
  // is a transparent 1:1 forward: the dev server itself (spawned with
  // `--base=/preview/:projectId/`) already emits every asset/HMR path
  // pre-prefixed, confirmed by the spike, so nothing here needs rewriting.
  // `preHandler` is the guard — only the project actually holding the single
  // preview slot may be proxied to; never trust a client-supplied port/host.
  await app.register(httpProxy, {
    upstream: `http://127.0.0.1:${config.previewPort}`,
    prefix: '/preview/:projectId',
    rewritePrefix: '/preview/:projectId',
    websocket: true,
    preHandler: (request, reply, done) => {
      const { projectId } = request.params as { projectId: string }
      if (previewTracker.activeProjectId() !== projectId) {
        void reply.code(404).send({ error: 'no active preview for this project' })
        return
      }
      done()
    },
  })

  app.get('/api/health', async () => ({
    ok: true,
    lastSeq: log.lastSeq(),
    projectCount: projects.list().length,
    liveSessions: sessions.liveSessionCount,
    agentReady: Boolean(config.claudeToken),
    pushReady: pusher.enabled,
  }))

  registerEvents(app, log, config, presence)
  registerPresence(app, presence)
  registerProjects(app, projects)
  registerBuild(app, builds, projects, config)
  registerPreview(app, previews, previewTracker, config)
  registerChanges(app, projects)
  registerEnv(app, projects)
  registerThreads(app, log, projects, sessions)
  registerGithub(app, projects, github)
  registerPrompt(app, sessions)
  registerApprovals(app, sessions)
  registerQuestions(app, sessions)
  registerPush(app, config, pushStore, pusher)
  registerDebug(app, log, config)
  registerUploads(app, uploads)

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
