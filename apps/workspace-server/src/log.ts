import type { Event, EventType, NewEvent } from '@mce/protocol'
import type { Db } from './db.ts'
import type { Redactor } from './redact.ts'

interface Row {
  seq: number
  session_id: string
  project_id: string
  thread_id: string | null
  ts: number
  type: string
  payload: string
}

type Listener = (event: Event) => void

interface SubscribeOptions {
  /**
   * Does this subscriber count as a human watching? An SSE connection does; the
   * Notifier, which subscribes only to *send* notifications, does not — and if it
   * counted itself, "nobody is watching" would never be true and turn_complete
   * would never notify. Defaults to true, so the SSE route needs no change.
   */
  watcher?: boolean
}

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
  #watchers = 0

  constructor(db: Db, redact: Redactor) {
    this.#db = db
    this.#redact = redact
  }

  append(event: NewEvent): Event {
    const { sessionId, projectId, threadId, ts, type, ...body } = this.#redact(event)

    const info = this.#db
      .prepare(
        `INSERT INTO events (session_id, project_id, thread_id, ts, type, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, projectId, threadId ?? null, ts, type, JSON.stringify(body))

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

  subscribe(listener: Listener, opts: SubscribeOptions = {}): () => void {
    this.#listeners.add(listener)
    const isWatcher = opts.watcher ?? true
    if (isWatcher) this.#watchers++

    let unsubscribed = false
    return () => {
      if (unsubscribed) return // guard double-unsubscribe against a double decrement
      unsubscribed = true
      this.#listeners.delete(listener)
      if (isWatcher) this.#watchers--
    }
  }

  /** Total listeners, watchers or not. For diagnostics. */
  get subscriberCount(): number {
    return this.#listeners.size
  }

  /** Live SSE connections — humans who could see the screen right now. */
  get watcherCount(): number {
    return this.#watchers
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

  /** Questions parked when the process died — cancelled on boot, like approvals. */
  pendingQuestions(): Array<{ requestId: string; sessionId: string; projectId: string }> {
    return this.#db
      .prepare(
        `SELECT json_extract(payload, '$.requestId') AS requestId,
                session_id AS sessionId,
                project_id AS projectId
           FROM events
          WHERE type = 'question_request'
            AND json_extract(payload, '$.requestId') NOT IN (
                  SELECT json_extract(payload, '$.requestId')
                    FROM events
                   WHERE type IN ('question_answered', 'question_cancelled'))`,
      )
      .all() as Array<{ requestId: string; sessionId: string; projectId: string }>
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
  latestClaudeSessionId(projectId: string): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT json_extract(payload, '$.claudeSessionId') AS id
           FROM events
          WHERE type = 'session_started' AND project_id = @projectId
            -- A reset draws a line, per project. Nothing before it is resumable.
            AND seq > COALESCE(
                  (SELECT MAX(seq) FROM events
                    WHERE type = 'conversation_reset' AND project_id = @projectId), 0)
          ORDER BY seq DESC LIMIT 1`,
      )
      .get({ projectId }) as { id: string | null } | undefined
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

  /**
   * Threads in a project, newest activity first, derived from the log. Legacy
   * events (thread_id NULL) collapse into one bucket flagged `legacy`.
   *
   * A thread only "exists" once it has a conversation event, so a freshly-minted
   * thread with no prompt yet won't appear until its first message — which is what
   * the client wants (empty threads aren't worth listing).
   *
   * A `thread_deleted` event hides the thread; its rows stay in the log (append-
   * only) but drop out of the list. `thread_renamed`/`thread_deleted` are metadata,
   * not conversation, so they don't count toward activity or the message count.
   */
  threadsOf(projectId: string): Array<{
    id: string | null
    title: string
    lastActivity: number
    messageCount: number
  }> {
    const rows = this.#db
      .prepare(
        `SELECT thread_id AS id,
                MAX(CASE WHEN type NOT IN ('thread_renamed', 'thread_deleted') THEN ts END) AS lastActivity,
                SUM(CASE WHEN type NOT IN ('thread_renamed', 'thread_deleted') THEN 1 ELSE 0 END) AS messageCount,
                MAX(CASE WHEN type = 'thread_deleted' THEN 1 ELSE 0 END) AS deleted
           FROM events
          WHERE project_id = ?
            AND type NOT IN ('project_created', 'project_create_failed')
          GROUP BY thread_id
         HAVING deleted = 0 AND messageCount > 0
          ORDER BY lastActivity DESC`,
      )
      .all(projectId) as Array<{ id: string | null; lastActivity: number; messageCount: number }>

    // A custom title wins; otherwise a concise line from the first prompt —
    // computed per group, cleaner than a correlated subquery with NULL thread_ids.
    return rows.map((r) => ({
      id: r.id,
      title: this.#customTitleOf(projectId, r.id) ?? titleize(this.#firstPromptOf(projectId, r.id)),
      lastActivity: r.lastActivity,
      messageCount: r.messageCount,
    }))
  }

  /** A thread's display title — same derivation `threadsOf` uses, for a single thread. */
  threadTitleOf(projectId: string, threadId: string | null): string {
    return this.#customTitleOf(projectId, threadId) ?? titleize(this.#firstPromptOf(projectId, threadId))
  }

  /** The latest custom title for a thread, if it's been renamed. Legacy has none. */
  #customTitleOf(projectId: string, threadId: string | null): string | undefined {
    if (threadId === null) return undefined
    const row = this.#db
      .prepare(
        `SELECT json_extract(payload, '$.title') AS title
           FROM events
          WHERE project_id = ? AND thread_id = ? AND type = 'thread_renamed'
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(projectId, threadId) as { title: string | null } | undefined
    return row?.title ?? undefined
  }

  #firstPromptOf(projectId: string, threadId: string | null): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT json_extract(payload, '$.text') AS text
           FROM events
          WHERE project_id = ? AND type = 'user_prompt'
            AND thread_id IS ${threadId === null ? 'NULL' : '?'}
          ORDER BY seq ASC LIMIT 1`,
      )
      .get(...(threadId === null ? [projectId] : [projectId, threadId])) as { text: string | null } | undefined
    return row?.text ?? undefined
  }

  /** The Claude session id for native `resume` of a specific thread. */
  latestClaudeSessionIdOfThread(threadId: string): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT json_extract(payload, '$.claudeSessionId') AS id
           FROM events
          WHERE type = 'session_started' AND thread_id = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(threadId) as { id: string | null } | undefined
    return row?.id ?? undefined
  }

  /** A thread's prompts and replies, oldest first — the material for a recap. */
  threadMessages(
    projectId: string,
    threadId: string | null,
  ): Array<{ role: 'user' | 'assistant'; text: string }> {
    const rows = this.#db
      .prepare(
        `SELECT type, json_extract(payload, '$.text') AS text
           FROM events
          WHERE project_id = ?
            AND thread_id IS ${threadId === null ? 'NULL' : '?'}
            AND type IN ('user_prompt', 'assistant_text')
          ORDER BY seq ASC`,
      )
      .all(...(threadId === null ? [projectId] : [projectId, threadId])) as Array<{
      type: string
      text: string | null
    }>
    return rows
      .filter((r) => r.text)
      .map((r) => ({ role: r.type === 'user_prompt' ? ('user' as const) : ('assistant' as const), text: r.text! }))
  }

  /**
   * Builds that started and never reached a terminal event — the process died
   * mid-setup. Recovered on boot into a `project_create_failed`, like sessions.
   */
  interruptedBuilds(): string[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT project_id AS id
           FROM events
          WHERE type = 'project_create_started'
            AND project_id NOT IN (
                  SELECT project_id FROM events
                   WHERE type IN ('project_created', 'project_create_failed'))`,
      )
      .all() as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /**
   * Standing allow-rules for a project, from `rule_allowed` events (Phase 2.7).
   * The auto-approve set the session consults before parking a permission prompt.
   */
  allowRulesOf(projectId: string): Array<{ tool: string; match?: string }> {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT json_extract(payload, '$.tool')  AS tool,
                         json_extract(payload, '$.match') AS match
           FROM events
          WHERE type = 'rule_allowed' AND project_id = ?`,
      )
      .all(projectId) as Array<{ tool: string | null; match: string | null }>
    return rows
      .filter((r): r is { tool: string; match: string | null } => typeof r.tool === 'string')
      .map((r) => ({ tool: r.tool, ...(r.match ? { match: r.match } : {}) }))
  }

  /**
   * The project whose preview dev server is active right now, if any (Phase 5).
   * Recovered from the log via the single-slot invariant — only ever one
   * preview running system-wide (one fixed-port dev server) — so whichever
   * project's `preview_started`/`preview_stopped` happened most recently,
   * across every project, tells you what's true right now.
   */
  activePreview(): { projectId: string } | undefined {
    const row = this.#db
      .prepare(
        `SELECT project_id AS projectId, type
           FROM events
          WHERE type IN ('preview_started', 'preview_stopped')
          ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { projectId: string; type: string } | undefined
    return row?.type === 'preview_started' ? { projectId: row.projectId } : undefined
  }

  /** Project-creation events, for the picker's "created how / when". */
  projectCreations(): Array<{ name: string; repoUrl?: string; ts: number }> {
    return this.#db
      .prepare(
        `SELECT project_id AS name,
                json_extract(payload, '$.repoUrl') AS repoUrl,
                ts
           FROM events WHERE type = 'project_created' ORDER BY seq ASC`,
      )
      .all() as Array<{ name: string; repoUrl?: string; ts: number }>
  }

  /**
   * Every image id ever attached to a `user_prompt`, across all projects and
   * threads. Fed to UploadStore.sweepOrphans on boot so an upload that was
   * actually sent survives forever, even after the compose box that staged it
   * is long gone.
   */
  referencedImageIds(): Set<string> {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT json_extract(je.value, '$.id') AS imageId
           FROM events AS e, json_each(json_extract(e.payload, '$.images')) AS je
          WHERE e.type = 'user_prompt'`,
      )
      .all() as Array<{ imageId: string | null }>
    return new Set(rows.map((r) => r.imageId).filter((id): id is string => typeof id === 'string'))
  }

  countOfType(type: EventType): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = ?`).get(type) as {
      n: number
    }
    return row.n
  }
}

/**
 * A short, title-like line from a thread's first prompt: one line, filler
 * openers stripped, sentence-cased, capped. Not an LLM summary — a cheap,
 * deterministic label good enough to tell threads apart.
 */
function titleize(firstPrompt: string | undefined): string {
  if (!firstPrompt) return 'New thread'
  let t = firstPrompt.replace(/\s+/g, ' ').trim()
  // Drop polite/filler openers so the subject leads.
  t = t.replace(/^(hey |hi |ok |okay |so |please |can you |could you |i want to |i'd like to |let's |lets |help me )/i, '')
  t = t.replace(/[\s.,;:!?-]+$/, '')
  if (!t) return 'New thread'
  const title = t.length > 60 ? `${t.slice(0, 59)}…` : t
  return title.charAt(0).toUpperCase() + title.slice(1)
}

function toEvent(row: Row): Event {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    projectId: row.project_id,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ts: row.ts,
    type: row.type,
    ...(JSON.parse(row.payload) as object),
  } as Event
}
