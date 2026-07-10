import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import type { Pusher } from '../push.ts'
import type { PushStore, PushSubscription } from '../push-store.ts'

/**
 * Device registration for web push. See PHASE-1.md.
 *
 * The public VAPID key is served here rather than baked into the client build,
 * so rotating keys is a server restart, not a rebuild-and-redeploy.
 */
export function registerPush(
  app: FastifyInstance,
  config: Config,
  store: PushStore,
  pusher: Pusher,
): void {
  // The client needs this to build a subscription. Public by design.
  app.get('/api/push/key', async (_request, reply) => {
    if (!config.vapid) return reply.code(503).send({ error: 'push is not configured' })
    return reply.send({ key: config.vapid.publicKey })
  })

  app.post('/api/push/subscribe', async (request, reply) => {
    if (!config.vapid) return reply.code(503).send({ error: 'push is not configured' })

    const sub = request.body as Partial<PushSubscription> | undefined
    if (!isValid(sub)) return reply.code(400).send({ error: 'invalid subscription' })

    store.add(sub, Date.now())
    return reply.code(201).send({ ok: true })
  })

  // Body carries the endpoint. DELETE with a body is unusual but every push
  // client sends one, and the endpoint is the primary key.
  app.post('/api/push/unsubscribe', async (request, reply) => {
    const body = request.body as { endpoint?: string } | undefined
    if (!body?.endpoint) return reply.code(400).send({ error: 'endpoint is required' })

    store.remove(body.endpoint)
    return reply.code(204).send()
  })

  // Dev only. Same idea as the event injector: prove the transport reaches your
  // phone before wiring any trigger to it.
  if (config.isDev) {
    app.post('/api/_debug/push', async (request, reply) => {
      const body = (request.body ?? {}) as { title?: string; body?: string; url?: string }
      const delivered = await pusher.notify(
        {
          title: body.title ?? 'Test',
          body: body.body ?? 'If you can read this, push works.',
          url: body.url ?? '/',
          tag: 'debug',
        },
        Date.now(),
      )
      return reply.send({ enabled: pusher.enabled, devices: store.count(), delivered })
    })
  }
}

function isValid(sub: Partial<PushSubscription> | undefined): sub is PushSubscription {
  return (
    typeof sub?.endpoint === 'string' &&
    sub.endpoint.length > 0 &&
    typeof sub.keys?.p256dh === 'string' &&
    typeof sub.keys?.auth === 'string'
  )
}
