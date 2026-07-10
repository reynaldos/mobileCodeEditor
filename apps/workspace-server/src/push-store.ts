import type { Db } from './db.ts'

/**
 * A push subscription as the browser's `PushSubscription.toJSON()` produces it.
 * The endpoint is unique per device+browser; the keys are per-device secrets.
 */
export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

interface Row {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * The registered devices. A plain table, not the event log — see db.ts migration #2.
 *
 * These rows hold per-device secrets (`p256dh`, `auth`). They never enter the
 * event log, so the redactor never needs to know about them.
 */
export class PushStore {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  /** Idempotent: re-subscribing the same device refreshes its keys. */
  add(sub: PushSubscription, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, last_ok_at)
         VALUES (@endpoint, @p256dh, @auth, @now, @now)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = @p256dh, auth = @auth`,
      )
      .run({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, now })
  }

  remove(endpoint: string): void {
    this.#db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint)
  }

  all(): PushSubscription[] {
    const rows = this.#db.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions`).all() as Row[]
    return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }))
  }

  markDelivered(endpoint: string, now: number): void {
    this.#db.prepare(`UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?`).run(now, endpoint)
  }

  count(): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).get() as { n: number }
    return row.n
  }

  /** Last successful delivery, or null if never delivered. For diagnostics and tests. */
  lastOkAt(endpoint: string): number | null {
    const row = this.#db
      .prepare(`SELECT last_ok_at AS t FROM push_subscriptions WHERE endpoint = ?`)
      .get(endpoint) as { t: number | null } | undefined
    return row?.t ?? null
  }
}
