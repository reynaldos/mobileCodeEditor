import { randomUUID } from 'node:crypto'
import type { Config } from './config.ts'
import type { EventLog } from './log.ts'
import { AgentSession, type QueryFn } from './session.ts'

export type ApprovalOutcome = 'ok' | 'not_pending'

export interface PromptOptions {
  /** Start a new Claude conversation instead of continuing the last one. */
  fresh?: boolean
}

/**
 * Holds one session in the MVP and a Map anyway, because going to N sessions
 * should be a lookup rather than a refactor of module-level globals.
 * See DECISIONS #14.
 */
export class SessionManager {
  readonly #sessions = new Map<string, AgentSession>()
  readonly #log: EventLog
  readonly #config: Config
  readonly #queryFn: QueryFn | undefined

  #currentId: string | undefined

  constructor(log: EventLog, config: Config, queryFn?: QueryFn) {
    this.#log = log
    this.#config = config
    this.#queryFn = queryFn
  }

  /**
   * The log outlives the process; live promises and generators do not.
   *
   * Expire approvals first — each was a promise nobody can resolve now — then
   * close the sessions that were mid-generator when we died.
   *
   * Nothing here decides what to resume. That is read from the log at the
   * moment a session starts, so a clean shutdown and a crash behave the same.
   */
  recoverOnBoot(): void {
    for (const { approvalId, sessionId, projectId } of this.#log.pendingApprovals()) {
      this.#log.append({ type: 'approval_expired', approvalId, sessionId, projectId, ts: Date.now() })
    }

    for (const { sessionId, projectId } of this.#log.openSessions()) {
      this.#log.append({
        type: 'session_ended',
        reason: 'interrupted',
        message: 'Server restarted while the agent was running.',
        sessionId,
        projectId,
        ts: Date.now(),
      })
    }
  }

  /**
   * Feeds the live session, or starts one that continues the last conversation.
   *
   * Claude's memory lives in the agent process, not in our log. Restarting the
   * server therefore forgets everything unless we hand `resume` back — and the
   * server restarts constantly, both from `node --watch` and from deploys. So
   * resuming is the default and a fresh start is the explicit request.
   */
  async prompt(text: string, options: PromptOptions = {}): Promise<string> {
    if (options.fresh) await this.#endCurrent()

    const live = this.#liveSession()
    const session = live ?? this.#startSession(options.fresh ? undefined : this.#lastConversation())

    session.prompt(text)
    return session.id
  }

  resolveApproval(approvalId: string, allow: boolean, reason?: string): ApprovalOutcome {
    for (const session of this.#sessions.values()) {
      if (session.resolveApproval(approvalId, allow, reason)) return 'ok'
    }
    return 'not_pending'
  }

  get currentSessionId(): string | undefined {
    return this.#currentId
  }

  /** The conversation a new session would continue, or undefined if there is none. */
  get resumableConversationId(): string | undefined {
    return this.#lastConversation()
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.stop()))
    this.#sessions.clear()
  }

  // -------------------------------------------------------------------------

  /**
   * Read from the log, not from memory. A session that ended cleanly is just as
   * resumable as one the process died during — the distinction only ever
   * mattered because we used to recover it during boot.
   */
  #lastConversation(): string | undefined {
    return this.#log.latestClaudeSessionId()
  }

  #liveSession(): AgentSession | undefined {
    if (!this.#currentId) return undefined
    const session = this.#sessions.get(this.#currentId)
    if (!session) return undefined

    const dead = session.status === 'ended' || session.status === 'error' || session.status === 'interrupted'
    return dead ? undefined : session
  }

  async #endCurrent(): Promise<void> {
    const live = this.#liveSession()
    if (!live) return
    await live.stop()
  }

  #startSession(resume: string | undefined): AgentSession {
    const id = randomUUID()
    const session = new AgentSession({
      id,
      log: this.#log,
      config: this.#config,
      ...(resume ? { resume } : {}),
      ...(this.#queryFn ? { queryFn: this.#queryFn } : {}),
    })

    session.start()
    this.#sessions.set(id, session)
    this.#currentId = id
    return session
  }
}
