import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  CanUseTool,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { EventBody, ImageRef, NewEvent, Question, SessionStatus } from '@mce/protocol'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { AsyncQueue } from './async-queue.ts'
import { assertAgentCredentials, type Config } from './config.ts'
import { changedFiles, headSha } from './git-changes.ts'
import type { EventLog } from './log.ts'
import type { UploadStore } from './uploads.ts'

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

interface PendingQuestion {
  readonly toolUseId: string
  /** The original AskUserQuestion input, echoed back (with `answers` merged in) as `updatedInput`. */
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
  /** Where uploaded images live — read at send time to build multimodal content. */
  readonly uploads: UploadStore
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
  readonly #uploads: UploadStore
  readonly #resume: string | undefined
  #recap: string | undefined
  readonly #queryFn: QueryFn

  readonly #queue = new AsyncQueue<SDKUserMessage>()
  readonly #pending = new Map<string, Pending>()
  readonly #pendingQuestions = new Map<string, PendingQuestion>()
  readonly #abort = new AbortController()

  #query: Query | undefined
  #status: SessionStatus = 'starting'
  #claudeSessionId: string | undefined
  #lastCostUsd: number | undefined
  #done: Promise<void> | undefined
  #interruptMessage: string | undefined
  /** HEAD when the current turn's prompt was sent — the base for its file diff. */
  #turnBase: Promise<string | undefined> | undefined

  constructor(opts: AgentSessionOptions) {
    this.id = opts.id
    this.projectId = opts.projectId
    this.threadId = opts.threadId
    this.#log = opts.log
    this.#config = opts.config
    this.#projectPath = opts.projectPath
    this.#uploads = opts.uploads
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
        // AskUserQuestion arrives here too, as an ordinary tool_use — confirmed
        // empirically (it was showing up as a JSON approval card before
        // #canUseTool special-cased it below). There's no separate dialog
        // channel for it in this SDK version.
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

  /**
   * Appends `user_prompt` and feeds the agent. Returns immediately.
   *
   * `imageIds` come from a prior POST /api/uploads/images. Resolved to bytes
   * BEFORE anything is appended — a bad id must never leave an orphaned
   * `user_prompt` event with nothing actually sent to Claude. The event only
   * ever stores lightweight refs (id/mediaType/size); the bytes themselves
   * never enter the log. See UploadStore and DECISIONS #5.
   */
  prompt(text: string, imageIds: string[] = []): void {
    if (!this.#query) throw new Error('session not started')
    if (this.#queue.closed) throw new Error('session is closing')

    const images = imageIds.map((id) => ({ id, ...this.#uploads.read(id) }))

    // Log the user's real text — that's what the UI shows. Claude receives the
    // recap folded in ahead of it, but only on the first prompt of a recapped
    // thread, so it has context without a native resume. See PHASE-2.5.
    const refs: ImageRef[] = images.map(({ id, mediaType, bytes }) => ({ id, mediaType, size: bytes.length }))
    this.#append({ type: 'user_prompt', text, ...(refs.length ? { images: refs } : {}) })
    const toClaude = this.#recap ? `${this.#recap}\n\n---\n\n${text}` : text
    this.#recap = undefined

    // Snapshot HEAD now so `turn_changes` at the end can diff exactly what this
    // turn touched, whether Claude commits or leaves it in the working tree.
    this.#turnBase = headSha(this.#projectPath)

    this.#status = 'thinking'

    // No publicly reachable URL for Anthropic's API to fetch from this
    // Tailscale-only host, so images always go as base64, read off disk now.
    const content =
      images.length === 0
        ? toClaude
        : [
            { type: 'text' as const, text: toClaude },
            ...images.map(({ mediaType, bytes }) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: mediaType, data: bytes.toString('base64') },
            })),
          ]

    this.#queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    })
  }

  /** True if a standing "Always approve" rule already covers this call. */
  #allowedByRule(toolName: string, input: Record<string, unknown>): boolean {
    return this.#log.allowRulesOf(this.projectId).some((rule) => matchesRule(rule, toolName, input))
  }

  /**
   * @param always persist an allow-rule so this tool/command stops prompting.
   * @returns false if this approval was already decided, expired, or never existed.
   */
  resolveApproval(approvalId: string, allow: boolean, reason?: string, always = false): boolean {
    const pending = this.#pending.get(approvalId)
    if (!pending) return false
    this.#pending.delete(approvalId)

    this.#append({ type: 'approval_decision', approvalId, allow, ...(reason ? { reason } : {}) })
    if (allow && always) this.#append({ type: 'rule_allowed', ...ruleFor(pending.tool, pending.input) })
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
    // Same for parked questions — an unresolved AskUserQuestion hangs the agent too.
    for (const [requestId, pending] of this.#pendingQuestions) {
      this.#pendingQuestions.delete(requestId)
      this.#append({ type: 'question_cancelled', requestId })
      pending.resolve({
        behavior: 'deny',
        message: 'Server shutting down.',
        interrupt: true,
        toolUseID: pending.toolUseId,
      })
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
    // Built-in read-only allowlist, plus the user's own standing rules from
    // "Always approve" (projected from the log, per project).
    if (AUTO_APPROVED.has(toolName) || this.#allowedByRule(toolName, input)) {
      return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
    }

    // AskUserQuestion arrives here like any other tool_use — there is no
    // separate dialog channel for it in this SDK version (confirmed: without
    // this branch it fell into the generic approval card below and rendered
    // raw JSON with just Approve/Reject). Render the real picker instead and
    // park until the phone answers, same bridge as an approval.
    if (toolName === 'AskUserQuestion') {
      const questions = extractQuestions(input)
      if (questions) return this.#parkQuestion(questions, input, options)
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

  /**
   * The question bridge: parallel to the approval bridge, on the same
   * `canUseTool` channel. Surfaces `question_request` and parks a
   * `PermissionResult` resolver until an HTTP answer arrives from the phone.
   */
  #parkQuestion(
    questions: Question[],
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const requestId = randomUUID()
    this.#append({
      type: 'question_request',
      requestId,
      toolUseId: options.toolUseID,
      questions,
    })
    this.#status = 'awaiting_approval'

    return new Promise<PermissionResult>((resolve) => {
      this.#pendingQuestions.set(requestId, { toolUseId: options.toolUseID, input, resolve })

      // If the turn is aborted while we're parked, resolve rather than leak.
      options.signal.addEventListener(
        'abort',
        () => {
          if (!this.#pendingQuestions.delete(requestId)) return
          this.#append({ type: 'question_cancelled', requestId })
          resolve({ behavior: 'deny', message: 'Aborted before you answered.', toolUseID: options.toolUseID })
        },
        { once: true },
      )
    })
  }

  /** @returns false if this question was already answered, cancelled, or never existed. */
  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    const pending = this.#pendingQuestions.get(requestId)
    if (!pending) return false
    this.#pendingQuestions.delete(requestId)

    this.#append({ type: 'question_answered', requestId, answers })
    if (this.#pendingQuestions.size === 0 && this.#pending.size === 0) this.#status = 'thinking'
    // Allow the tool call to complete, with the answers folded into its input —
    // AskUserQuestionOutput's own `answers` field is this exact shape (question
    // text -> answer, multi-select comma-joined), so the tool's result reflects
    // what the user picked.
    pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers }, toolUseID: pending.toolUseId })
    return true
  }

  hasPendingQuestion(requestId: string): boolean {
    return this.#pendingQuestions.has(requestId)
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
        void this.#emitTurnChanges(this.#turnBase)
        return
      }

      default:
        // The SDKMessage union has ~38 variants. We render five.
        return
    }
  }

  /**
   * After a turn, diff the working tree against the HEAD snapshot from when the
   * prompt was sent and append a `turn_changes` (names + counts only). Off the hot
   * path and best-effort — a git hiccup must never fail a turn.
   */
  async #emitTurnChanges(basePromise?: Promise<string | undefined>): Promise<void> {
    const base = await basePromise?.catch(() => undefined)
    if (!base) return
    const files = await changedFiles(this.#projectPath, base).catch(() => [])
    if (files.length === 0) return
    this.#append({ type: 'turn_changes', base, files })
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

/**
 * Programs whose first argument is a subcommand — allow-rules key on the first
 * TWO tokens (`git status`) so "Always approve" doesn't also wave through
 * `git push`. Everything else keys on the program alone.
 */
const SUBCOMMANDED = new Set([
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'docker', 'cargo', 'go', 'kubectl', 'fly', 'pip', 'make', 'brew',
])

function commandOf(input: Record<string, unknown>): string | undefined {
  return typeof input.command === 'string' ? input.command : undefined
}

/**
 * Pull the questions array out of an `AskUserQuestion` tool_use input.
 * Defensive: validated structurally rather than trusted blindly, so a future
 * SDK shape change degrades to a generic approval card instead of throwing.
 */
function extractQuestions(input: Record<string, unknown>): Question[] | undefined {
  const raw = input.questions
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const questions: Question[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') return undefined
    const { question, header, options, multiSelect } = q as Record<string, unknown>
    if (typeof question !== 'string' || !Array.isArray(options)) return undefined
    questions.push({
      question,
      header: typeof header === 'string' ? header : '',
      multiSelect: multiSelect === true,
      options: options.map((o) => {
        const opt = (o ?? {}) as Record<string, unknown>
        return {
          label: typeof opt.label === 'string' ? opt.label : String(opt.label ?? ''),
          description: typeof opt.description === 'string' ? opt.description : '',
          ...(typeof opt.preview === 'string' ? { preview: opt.preview } : {}),
        }
      }),
    })
  }
  return questions
}

/** The allow-rule key for a Bash command: `program` or `program subcommand`. */
function commandPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/)
  const first = tokens[0] ?? ''
  if (SUBCOMMANDED.has(first) && tokens[1] && !tokens[1].startsWith('-')) return `${first} ${tokens[1]}`
  return first
}

/** Derive the rule to persist from a granted call. */
function ruleFor(tool: string, input: Record<string, unknown>): { tool: string; match?: string } {
  if (tool === 'Bash') {
    const command = commandOf(input)
    const match = command ? commandPrefix(command) : undefined
    return match ? { tool, match } : { tool }
  }
  return { tool }
}

/** Does a stored rule cover this call? A rule without `match` allows the whole tool. */
function matchesRule(rule: { tool: string; match?: string }, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false
  if (!rule.match) return true
  const command = commandOf(input)
  return command !== undefined && commandPrefix(command) === rule.match
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
