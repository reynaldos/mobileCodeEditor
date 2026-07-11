import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import type { Config } from './config.ts'
import type { EventLog } from './log.ts'
import type { ProjectStore } from './projects.ts'
import type { Pusher } from './push.ts'
import type { PushStore } from './push-store.ts'
import { registerApprovals } from './routes/approvals.ts'
import { registerConversations } from './routes/conversations.ts'
import { registerDebug } from './routes/debug.ts'
import { registerEvents } from './routes/events.ts'
import { registerProjects } from './routes/projects.ts'
import { registerPrompt } from './routes/prompt.ts'
import { registerPush } from './routes/push.ts'
import type { SessionManager } from './session-manager.ts'

export interface Services {
  log: EventLog
  sessions: SessionManager
  projects: ProjectStore
  pushStore: PushStore
  pusher: Pusher
}

export async function buildServer(config: Config, services: Services): Promise<FastifyInstance> {
  const { log, sessions, projects, pushStore, pusher } = services
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
    projectId: config.projectId,
    projectPath: config.projectPath,
    lastSeq: log.lastSeq(),
    sessionId: sessions.currentSessionId ?? null,
    // The conversation your next prompt would continue. null means a clean start.
    resumes: sessions.resumableConversationId ?? null,
    agentReady: Boolean(config.claudeToken),
    pushReady: pusher.enabled,
  }))

  registerEvents(app, log, config)
  registerProjects(app, projects)
  registerPrompt(app, sessions)
  registerApprovals(app, sessions)
  registerConversations(app, sessions)
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
