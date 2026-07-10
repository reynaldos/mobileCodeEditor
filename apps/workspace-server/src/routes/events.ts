import type { Event } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import type { EventLog } from '../log.ts'

/** Intermediaries idle out long-lived connections. A comment frame is not an event. */
const PING_MS = 20_000

/**
 * The only way the client learns anything.
 *
 * `EventSource` reconnects on its own and resends `Last-Event-ID`. We replay
 * from it and attach to the live fan-out. That is the entire reconnect story,
 * and it's why locking your phone mid-run is not an error case.
 */
export function registerEvents(app: FastifyInstance, log: EventLog, config: Config): void {
  app.get('/api/events', (request, reply) => {
    // The header is what EventSource sends. The query param is for `curl`.
    const query = request.query as { lastEventId?: string }
    const lastSeq = parseSeq(request.headers['last-event-id']) ?? parseSeq(query.lastEventId) ?? 0

    reply.hijack()
    const res = reply.raw

    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx and friends will buffer an event stream into uselessness.
      'X-Accel-Buffering': 'no',
    }

    // hijack() takes this response out of Fastify's lifecycle, so @fastify/cors'
    // onSend hook never runs and never stamps the header. Cross-origin
    // EventSource is then blocked by the browser with nothing in the server log
    // to show for it — the client just says "reconnecting" forever.
    //
    // Production is same-origin (the server serves the PWA), so this is dev-only,
    // exactly like the cors plugin registration in server.ts.
    const origin = request.headers.origin
    if (config.isDev && origin) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Vary'] = 'Origin'
    }

    res.writeHead(200, headers)
    res.flushHeaders?.()

    // Subscribe BEFORE replaying, and gate on seq. Otherwise an event appended
    // between the replay query and the subscribe call is lost forever — the
    // client would sit waiting for something that already happened.
    let lastSent = lastSeq
    const send = (event: Event): void => {
      if (event.seq <= lastSent) return
      lastSent = event.seq
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
    }

    const unsubscribe = log.subscribe(send)
    for (const event of log.replaySince(lastSeq)) send(event)

    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)

    const cleanup = (): void => {
      clearInterval(ping)
      unsubscribe()
    }
    request.raw.on('close', cleanup)
    res.on('error', cleanup)
  })
}

/** `Last-Event-ID` is the last event the client SAW. Replay is strictly `> seq`. */
function parseSeq(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === '') return undefined

  const seq = Number(raw)
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined
  return seq
}
