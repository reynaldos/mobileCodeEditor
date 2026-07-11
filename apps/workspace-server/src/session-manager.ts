import { randomUUID } from 'node:crypto'
import type { Config } from './config.ts'
import type { EventLog } from './log.ts'
import type { ProjectStore } from './projects.ts'
import { AgentSession, type QueryFn } from './session.ts'

export type ApprovalOutcome = 'ok' | 'not_pending'

export interface PromptOptions {
  /** Start a new Claude conversation instead of continuing the last one. */
  fresh?: boolean
}

export class UnknownProjectError extends Error {
  // Assigned in the body, not as a constructor parameter property — Node's
  // type-stripping is strip-only and cannot synthesize those.
  readonly projectId: string
  constructor(projectId: string) {
    super(`no project "${projectId}"`)
    this.name = 'UnknownProjectError'
    this.projectId = projectId
  }
}

/**
 * One live agent session per project, keyed by `projectId`. The Map was always
 * the plan — going from one project to N is a lookup, not a refactor of
 * module-level globals. See DECISIONS #14.
 *
 * Each project resumes its own Claude conversation independently, because the
 * log keys everything by `project_id` + `session_id`.
 */
export class SessionManager {
  readonly #sessions = new Map<string, AgentSession>()
  readonly #log: EventLog
  readonly #config: Config
  readonly #projects: ProjectStore
  readonly #queryFn: QueryFn | undefined

  constructor(log: EventLog, config: Config, projects: ProjectStore, queryFn?: QueryFn) {
    this.#log = log
    this.#config = config
    this.#projects = projects
    this.#queryFn = queryFn
  }

  /**
   * The log outlives the process; live promises and generators do not. Expire
   * parked approvals (each was a promise nobody can resolve now), then close the
   * sessions that were mid-generator when we died — across all projects.
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
   * Feeds the project's live session, or starts one that continues its last
   * conversation. Resuming is the default; `fresh` is the explicit reset.
   *
   * @throws UnknownProjectError if the project doesn't exist.
   */
  async prompt(projectId: string, text: string, options: PromptOptions = {}): Promise<string> {
    const path = this.#projects.pathOf(projectId)
    if (!path || !this.#projects.exists(projectId)) throw new UnknownProjectError(projectId)

    if (options.fresh) await this.newConversation(projectId)

    const session = this.#liveSession(projectId) ?? this.#startSession(projectId, path)
    session.prompt(text)
    return session.id
  }

  /**
   * Ends the project's live session and draws a line in the log. The next prompt
   * for that project starts a conversation Claude has no memory of. The line is
   * an event, so it survives a restart for free. See DECISIONS #5.
   */
  async newConversation(projectId: string): Promise<void> {
    const live = this.#liveSession(projectId)
    const sessionId = live?.id
    if (live) await live.stop()
    this.#sessions.delete(projectId)

    this.#log.append({
      type: 'conversation_reset',
      sessionId: sessionId ?? 'system',
      projectId,
      ts: Date.now(),
    })
  }

  resolveApproval(approvalId: string, allow: boolean, reason?: string): ApprovalOutcome {
    for (const session of this.#sessions.values()) {
      if (session.resolveApproval(approvalId, allow, reason)) return 'ok'
    }
    return 'not_pending'
  }

  /** The conversation a new prompt to this project would continue, if any. */
  resumableConversationIdOf(projectId: string): string | undefined {
    return this.#log.latestClaudeSessionId(projectId)
  }

  /** How many projects have a live session — for /api/health. */
  get liveSessionCount(): number {
    let n = 0
    for (const projectId of this.#sessions.keys()) if (this.#liveSession(projectId)) n++
    return n
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.stop()))
    this.#sessions.clear()
  }

  // -------------------------------------------------------------------------

  #liveSession(projectId: string): AgentSession | undefined {
    const session = this.#sessions.get(projectId)
    if (!session) return undefined

    const dead =
      session.status === 'ended' || session.status === 'error' || session.status === 'interrupted'
    if (dead) {
      this.#sessions.delete(projectId)
      return undefined
    }
    return session
  }

  #startSession(projectId: string, projectPath: string): AgentSession {
    const resume = this.#log.latestClaudeSessionId(projectId)
    const session = new AgentSession({
      id: randomUUID(),
      log: this.#log,
      config: this.#config,
      projectId,
      projectPath,
      ...(resume ? { resume } : {}),
      ...(this.#queryFn ? { queryFn: this.#queryFn } : {}),
    })

    session.start()
    this.#sessions.set(projectId, session)
    return session
  }
}
