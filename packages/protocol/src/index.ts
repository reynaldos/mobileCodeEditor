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
  /**
   * The conversation this event belongs to (Phase 2.5). Absent on non-conversation
   * events (project_created) and on legacy events from before threads existed.
   */
  threadId?: string
  /** epoch ms */
  ts: number
}

/**
 * How the agent authenticated. `oauth` is a `claude setup-token` token riding a
 * Pro/Max subscription — usage draws on plan limits and is NOT billed per token.
 * Anything else is a metered API key.
 */
export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth'

export type EventBody =
  /** The agent came up. `claudeSessionId` is what we pass to `resume` after a crash. */
  | { type: 'session_started'; claudeSessionId: string; model: string; apiKeySource?: ApiKeySource }
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
  /**
   * A deliberate line under the conversation. Claude will not resume anything
   * before this point.
   *
   * Recorded rather than remembered: `latestClaudeSessionId()` ignores any
   * session that started before the most recent reset, so "what do we resume"
   * stays a query over the log instead of state on the server.
   */
  | { type: 'conversation_reset' }
  | {
      type: 'session_ended'
      reason: 'complete' | 'error' | 'interrupted'
      costUsd?: number
      message?: string
    }
  /**
   * A project was cloned or created (Phase 2). The `projectId` on the envelope is
   * the new project. Recorded in the log — the picker derives "created how / when"
   * from it — while the filesystem stays the source of truth for *existence*.
   */
  | { type: 'project_created'; name: string; repoUrl?: string }
  /** Clone/init failed; the partial directory is cleaned up. */
  | { type: 'project_create_failed'; name: string; error: string }
  /** A thread was given a custom title (Phase 2.5). threadId on the envelope. */
  | { type: 'thread_renamed'; title: string }
  /** A thread was hidden from the list. The events stay in the log (append-only). */
  | { type: 'thread_deleted' }

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
  /** Which project this prompt targets. Each project keeps its own conversation. */
  projectId: string
  /** Which thread within the project (Phase 2.5). Its own conversation, resumed on demand. */
  threadId?: string
  /** Legacy reset flag; superseded by threads. Kept until the routes move to threads. */
  fresh?: boolean
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

/** POST /api/conversations/new — reset one project's conversation. */
export interface NewConversationRequest {
  projectId: string
}

// ---------------------------------------------------------------------------
// Projects (Phase 2). A project is a directory under /projects; the filesystem
// is the source of truth for existence, the log for how it was created.
// ---------------------------------------------------------------------------

/** A project as the client sees it. `id` is the directory name; no server path leaks out. */
export interface Project {
  id: string
  name: string
  /** git remote origin, if the project is a clone. */
  repoUrl?: string
  /** Current branch, best-effort. */
  branch?: string
  /** From the `project_created` event, if we have one. */
  createdAt?: number
}

// --- Threads (Phase 2.5): per-project conversation history -----------------

/**
 * The id of the legacy bucket — conversations from before threads existed
 * (thread_id NULL). Read-only: you view it, but continue by starting a new thread.
 * The one runtime value in this file, deliberately: a sentinel both halves share.
 */
export const LEGACY_THREAD_ID = 'legacy-thread'

/** A conversation within a project, derived from the log. */
export interface Thread {
  id: string
  projectId: string
  /** First user prompt, truncated — the human-readable title. */
  title: string
  /** ms of the most recent event in the thread. */
  lastActivity: number
  messageCount: number
  /** The legacy bucket: events from before threads existed (thread_id NULL). */
  legacy?: boolean
}

/** GET /api/projects/:projectId/threads */
export interface ThreadsResponse {
  threads: Thread[]
}

/** POST /api/projects/:projectId/threads — start a fresh thread. */
export interface NewThreadResponse {
  threadId: string
}

/** PATCH /api/projects/:projectId/threads/:threadId — set a custom title. */
export interface RenameThreadRequest {
  title: string
}

/** GET /api/projects */
export interface ProjectsResponse {
  projects: Project[]
}

export type Visibility = 'public' | 'private'

/**
 * POST /api/projects — create a project, three ways:
 *  - `repoUrl`                → clone an existing repo
 *  - `name` + `visibility`    → create a new GitHub repo, then clone it
 *  - `name` alone             → a local `git init` (fallback, no remote)
 *
 * Returns 202; watch SSE for `project_created` / `project_create_failed`.
 */
export interface CreateProjectRequest {
  repoUrl?: string
  name?: string
  visibility?: Visibility
}

export interface CreateProjectResponse {
  projectId: string
}

// --- GitHub integration, for the picker's clone/create forms ---------------

/** A repo the user can clone, from `gh`. Owned repos are prioritized. */
export interface GithubRepo {
  nameWithOwner: string
  owner: string
  description?: string
  private: boolean
  url: string
  cloneUrl: string
  /** True when the authenticated user owns it — the picker sorts these first. */
  isOwn: boolean
}

/** GET /api/github/repos?q= — clone suggestions, debounced on the client. */
export interface GithubReposResponse {
  repos: GithubRepo[]
}

/** GET /api/github/check-name?name= — is this name free to create? */
export interface NameCheckResponse {
  name: string
  /** The GitHub account the repo would be created under. */
  owner: string
  available: boolean
  /** Why not, when unavailable: 'exists-local' | 'exists-remote' | 'invalid'. */
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
