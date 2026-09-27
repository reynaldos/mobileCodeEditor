import httpProxy from '@fastify/http-proxy'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.ts'
import type { PreviewTracker } from './preview-tracker.ts'

/**
 * Injected into the previewed app's HTML so the drawer's URL box can follow
 * in-app navigation. The iframe is always a *different origin* than the main
 * app — this listener is the preview's own dedicated origin — so the parent
 * can't read the iframe's `location` directly; the frame has to volunteer it.
 * This posts `location.href` up to the parent on first load and on every
 * history change (`pushState`, back/forward, hash). Guarded so it's a silent
 * no-op if it somehow runs un-framed or a CSP blocks it.
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

/**
 * The preview's dedicated origin (see DECISIONS — dropping `/preview/:projectId/`
 * for a second `tailscale serve` mapping instead): a separate, minimal Fastify
 * instance whose only job is proxying every request, root-mounted, to whatever
 * is currently on `config.previewPort`. Because there's exactly one preview
 * slot system-wide (PreviewManager), this whole origin *is* that slot — no
 * per-project routing to do, unlike the old path-prefixed proxy.
 */
export function buildPreviewOriginServer(config: Config, previewTracker: PreviewTracker): FastifyInstance {
  const app = Fastify({ logger: config.isDev ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } } : true })

  // Every request through this listener is preview traffic — unconditionally
  // drop accept-encoding so a gzipping dev server (Next) replies in plain
  // text, which the HTML injector below needs to be able to read.
  app.addHook('onRequest', async (request) => {
    delete request.headers['accept-encoding']
  })

  app.register(httpProxy, {
    upstream: `http://127.0.0.1:${config.previewPort}`,
    prefix: '/',
    websocket: true,
    preHandler: (_request, reply, done) => {
      if (!previewTracker.activeProjectId()) {
        void reply.code(503).send({ error: 'no preview is currently running' })
        return
      }
      done()
    },
    // Splice the URL reporter into the HTML document only. Everything else —
    // JS, CSS, the HMR socket — streams straight through untouched. Skip
    // already-compressed bodies (a guard; the onRequest hook above means dev
    // servers reply uncompressed, so this shouldn't trigger).
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

  return app
}
