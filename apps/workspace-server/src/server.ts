import type { StorageResponse } from '@mce/protocol'
import cors from '@fastify/cors'
import httpProxy from '@fastify/http-proxy'
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
import { registerGitRefresh } from './routes/git-refresh.ts'
import { registerGitStatus } from './routes/git-status.ts'
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

/**
 * Injected into the previewed app's HTML so the drawer's URL box can follow
 * in-app navigation. The iframe is a *different origin* than the app in dev
 * (Vite on :5173 vs this proxy on :3000), so the parent can't read the iframe's
 * `location` — the frame has to volunteer it. This posts `location.href` up to
 * the parent on first load and on every history change (`pushState`, back/forward,
 * hash). Guarded so it's a silent no-op if it somehow runs un-framed or a CSP
 * blocks it. Same-origin (production) works too; there the read would also work,
 * but one path is simpler than two.
 */
const PREVIEW_NAV_REPORTER =
  `<script>(function(){try{if(window.top===window.self)return;` +
  `var s=function(){try{window.parent.postMessage({__mcePreviewUrl:location.href},'*')}catch(e){}};` +
  `s();var w=function(f){return function(){var r=f.apply(this,arguments);s();return r}};` +
  `history.pushState=w(history.pushState);history.replaceState=w(history.replaceState);` +
  `addEventListener('popstate',s);addEventListener('hashchange',s)}catch(e){}})();</script>`

/** Splice the reporter into an HTML document — before </head>, else after <body>, else prepend. */
function injectNavReporter(html: string): string {
  if (html.includes('</head>')) return html.replace('</head>', PREVIEW_NAV_REPORTER + '</head>')
  const bodyOpen = html.match(/<body[^>]*>/i)
  if (bodyOpen) return html.replace(bodyOpen[0], bodyOpen[0] + PREVIEW_NAV_REPORTER)
  return PREVIEW_NAV_REPORTER + html
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

  // Keep the previewed app's navigation *inside* its iframe. An absolute-path
  // link there — `<a href="/about">`, or a logo/Home linking to `/` — resolves at
  // this server's origin, NOT under the `/preview/:projectId/` prefix. Left alone
  // it falls through to the SPA shell at the bottom of this file, loading the whole
  // workspace app inside the preview iframe, which re-opens the preview and stacks
  // a second one on itself (the nested-preview bug). So: when a preview is active
  // and the request came from within it (Referer under `/preview/`), send it back
  // into that preview. The existing proxy below then serves the right page with the
  // correct base/HMR. This is the path-prefix tax DECISIONS #16 flagged; a dedicated
  // preview origin is the durable fix, this keeps it usable meanwhile. The Referer
  // gate means top-level app requests (no `/preview/` referer) are untouched.
  app.addHook('onRequest', async (request, reply) => {
    const activeId = previewTracker.activeProjectId()
    if (!activeId) return
    const { url } = request
    if (url.startsWith('/preview/')) {
      // We splice a URL reporter into the previewed app's HTML, but only when it's
      // uncompressed. Next's dev server gzips for any client that sends
      // Accept-Encoding (every real browser), which would make the body opaque to
      // the injector. Drop the header so the upstream replies in plain text.
      delete request.headers['accept-encoding']
      return
    }
    if (url.startsWith('/api/') || url.startsWith('/_next') || url.startsWith('/static') || url.startsWith('/ws')) {
      return
    }
    if ((request.headers.referer ?? '').includes('/preview/')) {
      return reply.redirect(`/preview/${encodeURIComponent(activeId)}${url}`)
    }
  })

  // Preview (Phase 5): the iframe's traffic (HTML/JS/HMR websocket), reverse-
  // proxied same-origin rather than a second Tailscale port mapping — see
  // PHASE-5.md design call 1. `rewritePrefix` mirrors `prefix` exactly so this
  // is a transparent 1:1 forward for Vite: the dev server itself (spawned
  // with `--base=/preview/:projectId/`) already emits every asset/HMR path
  // pre-prefixed, confirmed by the spike, so nothing here needs rewriting.
  // `preHandler` is the guard — only the project actually holding the single
  // preview slot may be proxied to; never trust a client-supplied port/host.
  //
  // Next.js and Create React App (Phase 6) have no `--base`-equivalent flag,
  // so both are spawned at root instead (preview-manager.ts) and expect
  // requests at `/`, not `/preview/:projectId/`. `preRewrite` strips the
  // prefix for them before the normal param-substitution rewrite runs — for
  // Vite it's a no-op passthrough (see @fastify/http-proxy's
  // `fromParameters`: a `preRewrite` result that no longer starts with the
  // matched prefix skips the transparent rewrite). Next's `/_next/*` assets
  // and CRA's `/static/*` + `/ws` are absolute paths outside this prefix
  // entirely — the registrations below catch those.
  const ROOT_SPAWNED_FRAMEWORKS = new Set(['next', 'cra'])
  // Fixed `/preview` prefix, NOT `/preview/:projectId`. With a `:param` prefix,
  // @fastify/http-proxy's rewrite rebuilds the first N path segments from the
  // param — and after `preRewrite` strips the prefix for a root-spawned app, a
  // nested public asset like `/logo/ball.png` (3 segments) gets its whole path
  // replaced back with `/preview/<id>`, so CRA/Next receive garbage and answer
  // with index.html. (Single-segment paths and the document happened to survive,
  // which is why only nested images broke.) A plain prefix takes the simple
  // startsWith branch instead, leaving the stripped path intact. See the proxy's
  // `fromParameters`. The projectId now comes off the URL, not `request.params`.
  const previewProjectId = (url: string): string => decodeURIComponent(url.split('?')[0]!.split('/')[2] ?? '')
  await app.register(httpProxy, {
    upstream: `http://127.0.0.1:${config.previewPort}`,
    prefix: '/preview',
    rewritePrefix: '/preview',
    websocket: true,
    preHandler: (request, reply, done) => {
      if (previewTracker.activeProjectId() !== previewProjectId(request.url)) {
        void reply.code(404).send({ error: 'no active preview for this project' })
        return
      }
      done()
    },
    preRewrite: (url) =>
      ROOT_SPAWNED_FRAMEWORKS.has(previewTracker.activeFramework() ?? '') ? url.replace(/^\/preview\/[^/]+/, '') || '/' : url,
    // Splice the URL reporter into the HTML document only. Everything else — JS,
    // CSS, the HMR socket — streams straight through untouched. Skip already-
    // compressed bodies (dev servers send plain HTML, so this is just a guard we
    // don't have to gunzip). Buffering is safe here: an HTML document is small.
    replyOptions: {
      onResponse: (_request, reply, res) => {
        const type = String(reply.getHeader('content-type') ?? '')
        const compressed = reply.getHeader('content-encoding') !== undefined
        if (!type.includes('text/html') || compressed) {
          reply.send(res.stream)
          return
        }
        const chunks: Buffer[] = []
        res.stream.on('data', (c: Buffer) => chunks.push(c))
        res.stream.on('end', () => {
          const html = injectNavReporter(Buffer.concat(chunks).toString('utf8'))
          reply.removeHeader('content-length') // length changed
          reply.send(html)
        })
        res.stream.on('error', () => reply.send(res.stream))
      },
    },
  })

  // Next.js always emits its own JS/CSS/HMR assets at this fixed, root-
  // absolute path, regardless of any prefix (Phase 6) — there's no per-project
  // disambiguation to do here because only one preview ever runs system-wide
  // (PHASE-5.md design call 2), so "a Next preview is active at all" is the
  // whole guard.
  await app.register(httpProxy, {
    upstream: `http://127.0.0.1:${config.previewPort}`,
    prefix: '/_next',
    rewritePrefix: '/_next',
    websocket: true,
    preHandler: (_request, reply, done) => {
      if (previewTracker.activeFramework() !== 'next') {
        void reply.code(404).send({ error: 'no active Next.js preview' })
        return
      }
      done()
    },
  })

  // Create React App (react-scripts 5, confirmed against the version pinned
  // by the one CRA project on this server) emits its JS/CSS bundle at this
  // fixed, root-absolute path — same shape as Next's /_next above — and runs
  // its HMR websocket at /ws (webpack-dev-server v4's default `webSocketURL`
  // path; older CRA/webpack-dev-server-v3 projects using sockjs at
  // /sockjs-node instead are not covered here).
  await app.register(httpProxy, {
    upstream: `http://127.0.0.1:${config.previewPort}`,
    prefix: '/static',
    rewritePrefix: '/static',
    websocket: true,
    preHandler: (_request, reply, done) => {
      if (previewTracker.activeFramework() !== 'cra') {
        void reply.code(404).send({ error: 'no active Create React App preview' })
        return
      }
      done()
    },
  })
  await app.register(httpProxy, {
    upstream: `http://127.0.0.1:${config.previewPort}`,
    prefix: '/ws',
    rewritePrefix: '/ws',
    websocket: true,
    preHandler: (_request, reply, done) => {
      if (previewTracker.activeFramework() !== 'cra') {
        void reply.code(404).send({ error: 'no active Create React App preview' })
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
