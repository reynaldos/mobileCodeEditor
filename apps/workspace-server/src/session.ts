import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  CanUseTool,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { EventBody, NewEvent, SessionStatus } from '@mce/protocol'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { AsyncQueue } from './async-queue.ts'
import { assertAgentCredentials, type Config } from './config.ts'
import type { EventLog } from './log.ts'

/**
 * Tools we never prompt on.
 *
 * This is a second filter, not the first. Claude Code's own permission engine
 * decides what reaches `canUseTool` at all: under `permissionMode: 'default'` it
 * classifies read-only operations as safe and never asks. Verified empirically —
 * `pwd`, `ls`, and `grep -r` ran unprompted, while `touch probe.txt` raised a
 * card and did not create the file.
 *
 * So Bash is not blanket-prompted, and that turns out to be the behavior you
 * want: a card for every `ls` would bury the cards that matter.
 */
const AUTO_APPROVED = new Set(['Read', 'Grep', 'Glob'])

const SUMMARY_MAX = 200

/** How long an idle session gets to return on its own before we abort it. */
const SHUTDOWN_GRACE_MS = 2_000

/** Swappable so tests can drive the message loop without the real SDK. */
export type QueryFn = typeof query

interface Pending {
  readonly toolUseId: string
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly resolve: (result: PermissionResult) => void
}

export interface AgentSessionOptions {
  readonly id: string
  readonly log: EventLog
  readonly config: Config
  /** Which project this session works in. Every event it appends is tagged with it. */
  readonly projectId: string
  /** Which thread within the project. Every event is tagged with it too. */
  readonly threadId: string
  /** The project's directory — the agent's `cwd`. */
  readonly projectPath: string
  /** A Claude session id to natively resume — when its transcript still exists. */
  readonly resume?: string
  /**
   * A recap of the thread so far, folded into the FIRST prompt so Claude has
   * context without a native resume. See PHASE-2.5 option C. Mutually exclusive
   * with `resume` in practice — you use one or the other.
   */
  readonly recap?: string
  /** Injected in tests. Defaults to the real SDK. */
  readonly queryFn?: QueryFn
}

export class AgentSession {
  readonly id: string
  readonly projectId: string
  readonly threadId: string

  readonly #log: EventLog
  readonly #config: Config
  readonly #projectPath: string
  readonly #resume: string | undefined
  #recap: string | undefined
  readonly #queryFn: QueryFn

  readonly #queue = new AsyncQueue<SDKUserMessage>()
  readonly #pending = new Map<string, Pending>()
  readonly #abort = new AbortController()

  #query: Query | undefined
  #status: SessionStatus = 'starting'
  #claudeSessionId: string | undefined
  #lastCostUsd: number | undefined
  #done: Promise<void> | undefined
  #interruptMessage: string | undefined

  constructor(opts: AgentSessionOptions) {
    this.id = opts.id
    this.projectId = opts.projectId
    this.threadId = opts.threadId
    this.#log = opts.log
    this.#config = opts.config
    this.#projectPath = opts.projectPath
    this.#resume = opts.resume
    this.#recap = opts.recap
    this.#queryFn = opts.queryFn ?? query
  }

  get status(): SessionStatus {
    return this.#status
  }

  get claudeSessionId(): string | undefined {
    return this.#claudeSessionId
  }

  /** Spawns the agent. Does not await it — everything surfaces via the log. */
  start(): void {
    if (this.#query) throw new Error('session already started')
    assertAgentCredentials(this.#config)

    this.#query = this.#queryFn({
      // Streaming input: follow-up prompts feed the SAME conversation.
      prompt: this.#queue,
      options: {
        cwd: this.#projectPath,
        canUseTool: this.#canUseTool,
        // 'default' is what makes canUseTool get consulted at all.
        permissionMode: 'default',
        // Load no user/project settings. A container should behave identically
        // everywhere, and stray pre-approvals would silently bypass our cards.
        settingSources: [],
        // No token deltas in the log. See DECISIONS #7.
        includePartialMessages: false,
        abortController: this.#abort,
        ...(this.#resume ? { resume: this.#resume } : {}),
        ...(this.#config.model ? { model: this.#config.model } : {}),
      },
    })

    this.#done = this.#consume()
  }

  /** Appends `user_prompt` and feeds the agent. Returns immediately. */
  prompt(text: string): void {
    if (!this.#query) throw new Error('session not started')
    if (this.#queue.closed) throw new Error('session is closing')

    // Log the user's real text — that's what the UI shows. Claude receives the
    // recap folded in ahead of it, but only on the first prompt of a recapped
    // thread, so it has context without a native resume. See PHASE-2.5.
    this.#append({ type: 'user_prompt', text })
    const toClaude = this.#recap ? `${this.#recap}\n\n---\n\n${text}` : text
    this.#recap = undefined

    this.#status = 'thinking'
    this.#queue.push({
      type: 'user',
      message: { role: 'user', content: toClaude },
      parent_tool_use_id: null,
    })
  }

  /** @returns false if this approval was already decided, expired, or never existed. */
  resolveApproval(approvalId: string, allow: boolean, reason?: string): boolean {
    const pending = this.#pending.get(approvalId)
    if (!pending) return false
    this.#pending.delete(approvalId)

    this.#append({ type: 'approval_decision', approvalId, allow, ...(reason ? { reason } : {}) })
    if (this.#pending.size === 0) this.#status = 'thinking'

    pending.resolve(
      allow
        ? { behavior: 'allow', updatedInput: pending.input, toolUseID: pending.toolUseId }
        : { behavior: 'deny', message: reason ?? 'Denied from phone.', toolUseID: pending.toolUseId },
    )
    return true
  }

  hasPendingApproval(approvalId: string): boolean {
    return this.#pending.has(approvalId)
  }

  /**
   * Shutting down an IDLE session is not an interruption.
   *
   * `interrupted` should mean work was lost. A session sitting in
   * `awaiting_input` has nothing in flight, so closing its input stream lets the
   * generator return on its own and the session ends as `complete`. Aborting
   * unconditionally mislabels a clean stop — you finish a turn, `node --watch`
   * restarts, and the transcript claims the agent was interrupted.
   */
  async stop(): Promise<void> {
    // Deny anything outstanding first: a promise nobody resolves hangs the
    // agent forever. The SDK is explicit that permission prompts have no
    // deadline. Note this makes an awaiting_approval session non-idle.
    for (const [approvalId, pending] of this.#pending) {
      this.#pending.delete(approvalId)
      this.#append({ type: 'approval_decision', approvalId, allow: false, reason: 'Server shutting down.' })
      pending.resolve({ behavior: 'deny', message: 'Server shutting down.', interrupt: true })
    }

    if (!this.#query || !this.#done) return
    const idle = this.#status === 'awaiting_input' || this.#status === 'ended'

    if (!this.#queue.closed) this.#queue.close()

    if (idle) {
      const exited = await Promise.race([
        this.#done.then(
          () => true,
          () => true,
        ),
        sleep(SHUTDOWN_GRACE_MS, false),
      ])
      if (exited) return
      this.#interruptMessage = 'Server stopped; the agent did not exit cleanly.'
    } else {
      this.#interruptMessage = 'Server stopped while the agent was working.'
    }

    this.#abort.abort()
    await this.#done.catch(() => {})
  }

  // -------------------------------------------------------------------------

  /**
   * The approval bridge: a promise the SDK awaits, resolved by an inbound HTTP
   * request that arrives later from a phone.
   *
   * NEVER return null. The SDK treats null as "the consumer already answered
   * out-of-band" and will not write a control response — the tool then stays
   * blocked indefinitely, with no error and no timeout.
   */
  readonly #canUseTool: CanUseTool = async (toolName, input, options) => {
    if (AUTO_APPROVED.has(toolName)) {
      return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
    }

    const approvalId = randomUUID()

    this.#append({
      type: 'approval_request',
      approvalId,
      toolUseId: options.toolUseID,
      tool: toolName,
      input,
      // The SDK renders these for us. Prefer them over reconstructing
      // "Claude wants to edit foo.ts" from toolName + input.
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
    })
    this.#status = 'awaiting_approval'

    return new Promise<PermissionResult>((resolve) => {
      this.#pending.set(approvalId, { toolUseId: options.toolUseID, tool: toolName, input, resolve })

      // If the turn is aborted while we're parked, resolve rather than leak.
      options.signal.addEventListener(
        'abort',
        () => {
          if (!this.#pending.delete(approvalId)) return
          this.#append({ type: 'approval_expired', approvalId })
          resolve({ behavior: 'deny', message: 'Aborted before you answered.' })
        },
        { once: true },
      )
    })
  }

  async #consume(): Promise<void> {
    try {
      for await (const message of this.#query as Query) this.#onMessage(message)
      this.#end('complete')
    } catch (err) {
      if (this.#abort.signal.aborted) this.#end('interrupted', this.#interruptMessage)
      else this.#end('error', err instanceof Error ? err.message : String(err))
    }
  }

  #onMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system': {
        if (message.subtype !== 'init') return
        this.#status = 'thinking'

        // The SDK re-emits system/init — observed once per turn in streaming-input
        // mode. Only the first one starts a session. A *changed* id means the
        // conversation forked or compacted, which is worth recording.
        if (this.#claudeSessionId === message.session_id) return
        this.#claudeSessionId = message.session_id

        this.#append({
          type: 'session_started',
          claudeSessionId: message.session_id,
          model: message.model,
          // 'oauth' means a setup-token riding the subscription. The client uses
          // this to stop presenting `total_cost_usd` as a bill.
          apiKeySource: message.apiKeySource,
        })
        return
      }

      case 'assistant': {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            this.#append({ type: 'assistant_text', text: block.text })
          } else if (block.type === 'tool_use') {
            this.#append({
              type: 'tool_use',
              toolUseId: block.id,
              name: block.name,
              input: block.input,
            })
          }
        }
        return
      }

      case 'user': {
        const content = message.message.content
        if (typeof content === 'string') return
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          this.#append({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            ok: block.is_error !== true,
            summary: summarize(block.content),
          })
        }
        return
      }

      case 'result': {
        this.#lastCostUsd = message.total_cost_usd
        this.#status = 'awaiting_input'
        this.#append({
          type: 'turn_complete',
          costUsd: message.total_cost_usd,
          numTurns: message.num_turns,
        })
        return
      }

      default:
        // The SDKMessage union has ~38 variants. We render five.
        return
    }
  }

  #end(reason: 'complete' | 'error' | 'interrupted', message?: string): void {
    if (this.#status === 'ended' || this.#status === 'error' || this.#status === 'interrupted') return
    this.#status = reason === 'complete' ? 'ended' : reason
    this.#append({
      type: 'session_ended',
      reason,
      ...(this.#lastCostUsd !== undefined ? { costUsd: this.#lastCostUsd } : {}),
      ...(message ? { message } : {}),
    })
  }

  // `EventBody`, not `Omit<NewEvent, ...>` — Omit does not distribute over a
  // discriminated union and would collapse every variant to just `{ type }`.
  #append(body: EventBody): void {
    this.#log.append({
      sessionId: this.id,
      projectId: this.projectId,
      threadId: this.threadId,
      ts: Date.now(),
      ...body,
    } as NewEvent)
  }
}

/** One line. The log is for skimming with a thumb, not for storing file reads. */
function summarize(content: unknown): string {
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block ? String(block.text) : '',
      )
      .join(' ')
  } else {
    text = ''
  }

  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return '(no output)'
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 1)}…` : oneLine
}
