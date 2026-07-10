import type { Event, EventType, NewEvent } from '@mce/protocol'
import type { Db } from './db.ts'
import type { Redactor } from './redact.ts'

interface Row {
  seq: number
  session_id: string
  project_id: string
  ts: number
  type: string
  payload: string
}

type Listener = (event: Event) => void

/**
 * Append-only. One writer. The only durable state on this server.
 *
 * Everything you will ever want as a table — a sessions list, a projects list,
 * "what changed Tuesday" — is a projection of this. You never migrate data, you
 * write a new query. See DECISIONS #5.
 */
export class EventLog {
  readonly #db: Db
  readonly #redact: Redactor
  readonly #listeners = new Set<Listener>()

  constructor(db: Db, redact: Redactor) {
    this.#db = db
    this.#redact = redact
  }

  append(event: NewEvent): Event {
    const { sessionId, projectId, ts, type, ...body } = this.#redact(event)

    const info = this.#db
      .prepare(
        `INSERT INTO events (session_id, project_id, ts, type, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, projectId, ts, type, JSON.stringify(body))

    const stored = { ...event, seq: Number(info.lastInsertRowid) } as Event

    // Synchronous fan-out. A listener that throws must not corrupt the log or
    // stop other listeners — the row is already committed.
    for (const listener of this.#listeners) {
      try {
        listener(stored)
      } catch {
        /* a dead SSE connection is not the log's problem */
      }
    }
    return stored
  }

  /**
   * Last-Event-ID is the last event the client SAW. Replay is strictly `> seq`.
   *
   * Getting this wrong duplicates one message on every reconnect, which
   * presents as a rendering bug for a week. See docs/PHASE-0.md.
   */
  replaySince(seq: number): Event[] {
    const rows = this.#db
      .prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq ASC`)
      .all(seq) as Row[]
    return rows.map(toEvent)
  }

  lastSeq(): number {
    const row = this.#db.prepare(`SELECT MAX(seq) AS seq FROM events`).get() as { seq: number | null }
    return row.seq ?? 0
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get subscriberCount(): number {
    return this.#listeners.size
  }

  /**
   * Approvals whose deferred promise died with the process. Called once on boot;
   * each gets an `approval_expired` appended. There is nothing left to resolve.
   */
  pendingApprovals(): Array<{ approvalId: string; sessionId: string; projectId: string }> {
    return this.#db
      .prepare(
        `SELECT json_extract(payload, '$.approvalId') AS approvalId,
                session_id  AS sessionId,
                project_id  AS projectId
           FROM events
          WHERE type = 'approval_request'
            AND json_extract(payload, '$.approvalId') NOT IN (
                  SELECT json_extract(payload, '$.approvalId')
                    FROM events
                   WHERE type IN ('approval_decision', 'approval_expired')
                )`,
      )
      .all() as Array<{ approvalId: string; sessionId: string; projectId: string }>
  }

  /** Sessions that started and never ended: the process died mid-generator. */
  openSessions(): Array<{ sessionId: string; projectId: string }> {
    return this.#db
      .prepare(
        `SELECT DISTINCT session_id AS sessionId, project_id AS projectId
           FROM events
          WHERE type = 'session_started'
            AND session_id NOT IN (SELECT session_id FROM events WHERE type = 'session_ended')`,
      )
      .all() as Array<{ sessionId: string; projectId: string }>
  }

  /**
   * The most recent conversation Claude knows about, whatever became of it.
   *
   * Handing this back as `resume` is what lets you restart the server and keep
   * talking. Recovered from the log rather than a table — the log is the only
   * durable state, so this survives a crash exactly as well as a clean exit.
   */
  latestClaudeSessionId(): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT json_extract(payload, '$.claudeSessionId') AS id
           FROM events
          WHERE type = 'session_started'
            -- A reset draws a line. Nothing before it is resumable.
            AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE type = 'conversation_reset'), 0)
          ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { id: string | null } | undefined
    return row?.id ?? undefined
  }

  /** The Claude session id for `resume`, recovered from the log rather than a table. */
  claudeSessionIdOf(sessionId: string): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT json_extract(payload, '$.claudeSessionId') AS id
           FROM events
          WHERE type = 'session_started' AND session_id = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId) as { id: string | null } | undefined
    return row?.id ?? undefined
  }

  countOfType(type: EventType): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = ?`).get(type) as {
      n: number
    }
    return row.n
  }
}

function toEvent(row: Row): Event {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    projectId: row.project_id,
    ts: row.ts,
    type: row.type,
    ...(JSON.parse(row.payload) as object),
  } as Event
}
