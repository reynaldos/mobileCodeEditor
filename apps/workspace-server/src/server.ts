import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import type { BuildTracker } from './build-tracker.ts'
import type { Config } from './config.ts'
import type { Github } from './github.ts'
import type { EventLog } from './log.ts'
import type { ProjectStore } from './projects.ts'
import type { Pusher } from './push.ts'
import type { PushStore } from './push-store.ts'
import { registerApprovals } from './routes/approvals.ts'
import { registerBuild } from './routes/build.ts'
import { registerChanges } from './routes/changes.ts'
import { registerDebug } from './routes/debug.ts'
import { registerEvents } from './routes/events.ts'
import { registerGithub } from './routes/github.ts'
import { registerProjects } from './routes/projects.ts'
import { registerPrompt } from './routes/prompt.ts'
import { registerPush } from './routes/push.ts'
import { registerQuestions } from './routes/questions.ts'
import { registerThreads } from './routes/threads.ts'
import type { SessionManager } from './session-manager.ts'

export interface Services {
  log: EventLog
  sessions: SessionManager
  projects: ProjectStore
  builds: BuildTracker
  github: Github | undefined
  pushStore: PushStore
  pusher: Pusher
}

export async function buildServer(config: Config, services: Services): Promise<FastifyInstance> {
  const { log, sessions, projects, builds, github, pushStore, pusher } = services
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

  app.get('/api/health', async () => ({
    ok: true,
    lastSeq: log.lastSeq(),
    projectCount: projects.list().length,
    liveSessions: sessions.liveSessionCount,
    agentReady: Boolean(config.claudeToken),
    pushReady: pusher.enabled,
  }))

  registerEvents(app, log, config)
  registerProjects(app, projects)
  registerBuild(app, builds, projects, config)
  registerChanges(app, projects)
  registerThreads(app, log, projects, sessions)
  registerGithub(app, projects, github)
  registerPrompt(app, sessions)
  registerApprovals(app, sessions)
  registerQuestions(app, sessions)
  registerPush(app, config, pushStore, pusher)
  registerDebug(app, log, config)

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
