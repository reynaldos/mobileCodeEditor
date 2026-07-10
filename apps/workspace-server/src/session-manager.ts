import { randomUUID } from 'node:crypto'
import type { Config } from './config.ts'
import type { EventLog } from './log.ts'
import { AgentSession } from './session.ts'

export type ApprovalOutcome = 'ok' | 'not_pending'

/**
 * Holds one session in the MVP and a Map anyway, because going to N sessions
 * should be a lookup rather than a refactor of module-level globals.
 * See DECISIONS #14.
 */
export class SessionManager {
  readonly #sessions = new Map<string, AgentSession>()
  readonly #log: EventLog
  readonly #config: Config

  #currentId: string | undefined
  /** Claude's own session id from a run the process died during. */
  #resumeFrom: string | undefined

  constructor(log: EventLog, config: Config) {
    this.#log = log
    this.#config = config
  }

  /**
   * The log outlives the process; live promises and generators do not.
   *
   * Expire approvals first — each was a promise nobody can resolve now — then
   * close the sessions that were mid-generator when we died.
   */
  recoverOnBoot(): void {
    for (const { approvalId, sessionId, projectId } of this.#log.pendingApprovals()) {
      this.#log.append({ type: 'approval_expired', approvalId, sessionId, projectId, ts: Date.now() })
    }

    for (const { sessionId, projectId } of this.#log.openSessions()) {
      // Remember where Claude was, so the next prompt continues the conversation
      // rather than starting a stranger. Last one wins; there is only ever one.
      this.#resumeFrom = this.#log.claudeSessionIdOf(sessionId) ?? this.#resumeFrom
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

  /** Starts a session if none is live, otherwise feeds the existing one. */
  prompt(text: string): string {
    const session = this.#liveSession() ?? this.#startSession()
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

  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.stop()))
    this.#sessions.clear()
  }

  // -------------------------------------------------------------------------

  #liveSession(): AgentSession | undefined {
    if (!this.#currentId) return undefined
    const session = this.#sessions.get(this.#currentId)
    if (!session) return undefined

    const dead = session.status === 'ended' || session.status === 'error' || session.status === 'interrupted'
    return dead ? undefined : session
  }

  #startSession(): AgentSession {
    const id = randomUUID()
    const session = new AgentSession({
      id,
      log: this.#log,
      config: this.#config,
      ...(this.#resumeFrom ? { resume: this.#resumeFrom } : {}),
    })

    // Consumed once. A second restart shouldn't chain onto a stale conversation.
    this.#resumeFrom = undefined

    session.start()
    this.#sessions.set(id, session)
    this.#currentId = id
    return session
  }
}
