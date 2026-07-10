/**
 * The contract between apps/web and apps/workspace-server.
 *
 * TYPES ONLY. No runtime exports, deliberately: both halves import these with
 * `import type`, which erases at compile time. That keeps this package free of
 * any bundler or Node type-stripping concerns, and means adding a runtime
 * helper here is a decision, not an accident.
 *
 * See docs/PROTOCOL.md.
 */

/** Server-assigned envelope. `seq` is global and monotonic — it doubles as the SSE event id. */
export interface EventEnvelope {
  seq: number
  sessionId: string
  projectId: string
  /** epoch ms */
  ts: number
}

export type EventBody =
  /** The agent came up. `claudeSessionId` is what we pass to `resume` after a crash. */
  | { type: 'session_started'; claudeSessionId: string; model: string }
  | { type: 'user_prompt'; text: string }
  /** A complete assistant message. Never a token delta — see DECISIONS #7. */
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown }
  /** `summary` is one line, for a chip. Never a 40KB file read. */
  | { type: 'tool_result'; toolUseId: string; ok: boolean; summary: string }
  | {
      type: 'approval_request'
      approvalId: string
      toolUseId: string
      tool: string
      input: unknown
      /** Prompt text rendered by the SDK, e.g. "Claude wants to edit foo.ts". Prefer over reconstructing. */
      title?: string
      /** Short noun phrase, e.g. "Edit file". Good for button labels. */
      displayName?: string
      description?: string
    }
  | { type: 'approval_decision'; approvalId: string; allow: boolean; reason?: string }
  /** Appended on boot for any request whose deferred promise died with the process. */
  | { type: 'approval_expired'; approvalId: string }
  /** One assistant turn finished. The agent is alive and awaiting input. */
  | { type: 'turn_complete'; costUsd?: number; numTurns?: number }
  | {
      type: 'session_ended'
      reason: 'complete' | 'error' | 'interrupted'
      costUsd?: number
      message?: string
    }

export type Event = EventEnvelope & EventBody
export type EventType = EventBody['type']

/** An event before the log assigns it a `seq`. */
export type NewEvent = Omit<EventEnvelope, 'seq'> & EventBody

/** Narrow an Event to one variant: `Extract<Event, {type: 'tool_use'}>` */
export type EventOf<T extends EventType> = Extract<Event, { type: T }>

/**
 * Session lifecycle. See the state machine in docs/ARCHITECTURE.md.
 *
 * `interrupted` means the process died while the generator was live: the log is
 * intact and `claudeSessionId` can resume it.
 */
export type SessionStatus =
  | 'starting'
  | 'thinking'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'ended'
  | 'error'
  | 'interrupted'

// ---------------------------------------------------------------------------
// HTTP surface. Four routes; see docs/PROTOCOL.md.
// ---------------------------------------------------------------------------

/** POST /api/prompt */
export interface PromptRequest {
  text: string
}

/** 202 Accepted. Everything that happens next arrives over SSE. */
export interface PromptResponse {
  sessionId: string
}

/** POST /api/approvals/:approvalId — 204, or 409 if already decided or expired. */
export interface ApprovalRequest {
  allow: boolean
  reason?: string
}

/**
 * The tools we never prompt on. Everything else — Bash included — gets an
 * approval card, because the card *is* the review surface (DECISIONS #8).
 *
 * Yes, this prompts on `ls` for the first week. That's the point: you're
 * collecting the data that becomes your allowlist rather than guessing it.
 */
export type AutoApprovedTool = 'Read' | 'Grep' | 'Glob'
