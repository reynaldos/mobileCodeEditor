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
import { AsyncQueue } from './async-queue.ts'
import { assertAgentCredentials, type Config } from './config.ts'
import type { EventLog } from './log.ts'

/**
 * The only tools we never prompt on. Everything else — Bash included — gets an
 * approval card, because the card IS the review surface. See DECISIONS #8.
 */
const AUTO_APPROVED = new Set(['Read', 'Grep', 'Glob'])

const SUMMARY_MAX = 200

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
  /** A Claude session id from a previous, interrupted run. */
  readonly resume?: string
}

export class AgentSession {
  readonly id: string

  readonly #log: EventLog
  readonly #config: Config
  readonly #resume: string | undefined

  readonly #queue = new AsyncQueue<SDKUserMessage>()
  readonly #pending = new Map<string, Pending>()
  readonly #abort = new AbortController()

  #query: Query | undefined
  #status: SessionStatus = 'starting'
  #claudeSessionId: string | undefined
  #lastCostUsd: number | undefined
  #done: Promise<void> | undefined

  constructor(opts: AgentSessionOptions) {
    this.id = opts.id
    this.#log = opts.log
    this.#config = opts.config
    this.#resume = opts.resume
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

    this.#query = query({
      // Streaming input: follow-up prompts feed the SAME conversation.
      prompt: this.#queue,
      options: {
        cwd: this.#config.projectPath,
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

    this.#append({ type: 'user_prompt', text })
    this.#status = 'thinking'
    this.#queue.push({
      type: 'user',
      message: { role: 'user', content: text },
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

  async stop(): Promise<void> {
    // Deny anything outstanding first: a promise nobody resolves hangs the
    // agent forever. The SDK is explicit that permission prompts have no
    // deadline.
    for (const [approvalId, pending] of this.#pending) {
      this.#pending.delete(approvalId)
      this.#append({ type: 'approval_decision', approvalId, allow: false, reason: 'Server shutting down.' })
      pending.resolve({ behavior: 'deny', message: 'Server shutting down.', interrupt: true })
    }

    this.#abort.abort()
    if (!this.#queue.closed) this.#queue.close()
    await this.#done?.catch(() => {})
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
      if (this.#abort.signal.aborted) this.#end('interrupted')
      else this.#end('error', err instanceof Error ? err.message : String(err))
    }
  }

  #onMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system': {
        if (message.subtype !== 'init') return
        this.#claudeSessionId = message.session_id
        this.#status = 'thinking'
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
      projectId: this.#config.projectId,
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
