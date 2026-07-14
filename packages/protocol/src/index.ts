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
  | { type: 'user_prompt'; text: string; images?: ImageRef[] }
  /** A complete assistant message. Never a token delta — see DECISIONS #7. */
  | { type: 'assistant_text'; text: string }
  /**
   * `parentToolUseId` is set when this call came from *inside* a sub-agent (the
   * `Task` tool): it's the toolUseId of the launching `Task` call. Absent for the
   * main agent's own calls. The reducer uses it to fold sub-agent activity into a
   * distinct "Sub-agent" row instead of flattening it into the main thread.
   */
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string }
  /**
   * `summary` is one line, for a chip. `output` is the fuller result body (capped
   * + redacted), captured only for tools that render it — Bash (IN/OUT card), the
   * Task* family (the task-list card), and Task (the sub-agent's final report).
   * Everything else keeps just the summary. `parentToolUseId`: see tool_use.
   */
  | { type: 'tool_result'; toolUseId: string; ok: boolean; summary: string; output?: string; parentToolUseId?: string }
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
  /**
   * A standing allow-rule the user created via "Always approve" (Phase 2.7).
   * Projected per project into the auto-approve set: `tool` alone allows that
   * tool; `match` (a Bash command prefix) narrows it to matching commands.
   */
  | { type: 'rule_allowed'; tool: string; match?: string }
  /** One assistant turn finished. The agent is alive and awaiting input. */
  | { type: 'turn_complete'; costUsd?: number; numTurns?: number }
  /**
   * Files a turn changed, vs the HEAD snapshot taken when the prompt was sent
   * (Phase 2.7). Names + counts only — bounded, safe for the log; diff bodies are
   * fetched per file on expand. `base` is the sha to diff against.
   */
  | { type: 'turn_changes'; base: string; files: ChangedFile[] }
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
   * A project's setup began (Phase 2.6): clone/init, then dependency install. A
   * small, durable marker — the live output streams elsewhere (see BuildStream).
   * Its purpose is persistence: a client that reloads or returns later sees a
   * `started` with no terminal event and knows the build is still running.
   */
  | { type: 'project_create_started'; name: string; repoUrl?: string }
  /**
   * A project was cloned or created (Phase 2). The `projectId` on the envelope is
   * the new project. Recorded in the log — the picker derives "created how / when"
   * from it — while the filesystem stays the source of truth for *existence*.
   */
  | { type: 'project_created'; name: string; repoUrl?: string }
  /** Clone/init failed (or was cancelled); the partial directory is cleaned up. */
  | { type: 'project_create_failed'; name: string; error: string }
  /** A thread was given a custom title (Phase 2.5). threadId on the envelope. */
  | { type: 'thread_renamed'; title: string }
  /** A thread was hidden from the list. The events stay in the log (append-only). */
  | { type: 'thread_deleted' }
  /**
   * The agent asked a multiple-choice question (Phase 2.7 — the SDK's
   * AskUserQuestion, delivered like any other tool_use via canUseTool). Blocks
   * the turn until answered.
   */
  | { type: 'question_request'; requestId: string; toolUseId?: string; questions: Question[] }
  /** The user answered; `answers` is keyed by question text (multi joined by ", "). */
  | { type: 'question_answered'; requestId: string; answers: Record<string, string> }
  /** The question was abandoned (turn aborted, or the server shut down). */
  | { type: 'question_cancelled'; requestId: string }
  /**
   * A project's dev server was started for the in-app preview (Phase 5). A
   * small, durable marker — the live output streams elsewhere (see
   * PreviewStreamMessage), same split as project_create_started/BuildStream.
   * Only ever one active `preview_started` (with no terminal event) across the
   * whole log at a time — a single fixed-port dev server, system-wide.
   */
  | { type: 'preview_started' }
  /**
   * The preview's dev server stopped. `closed` is the user closing the drawer
   * (or evicting it to start another project's preview); `idle-timeout` is the
   * automatic stop after every device stopped looking (see Presence);
   * `crashed` is the child process dying on its own; `restarted` is a server
   * boot finding one left open by the last process (see recoverOnBoot).
   */
  | { type: 'preview_stopped'; reason: 'closed' | 'idle-timeout' | 'crashed' | 'restarted' }
  /**
   * A project's local directory was removed (Phase 6 "offload") — the
   * filesystem is gone; this is just the audit trail. Never implies the git
   * remote was touched — re-cloning by `repoUrl` brings it back. The
   * `projectId` on the envelope is the removed project.
   */
  | { type: 'project_removed' }

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
  /** Ids from a prior POST /api/uploads/images, attached to this prompt. */
  imageIds?: string[]
}

/** 202 Accepted. Everything that happens next arrives over SSE. */
export interface PromptResponse {
  sessionId: string
}

/** POST /api/approvals/:approvalId — 204, or 409 if already decided or expired. */
export interface ApprovalRequest {
  allow: boolean
  reason?: string
  /** "Always approve": persist an allow-rule so this tool/command stops prompting. */
  always?: boolean
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
  /** Whether `detectDevCommand` found a runnable dev command (Phase 5/6: Vite or Next.js, at the root or one level into a monorepo). Gates the preview button. */
  previewSupported: boolean
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

/**
 * GET /api/storage — disk usage of the volume the projects live on. All bytes.
 * `used + free === total`. Reserved (root-only) blocks count toward `used`, so
 * this reads a touch fuller than a raw `du`, which is the safe bias for a gauge
 * whose whole point is warning before ENOSPC takes the server down.
 */
export interface StorageResponse {
  total: number
  used: number
  free: number
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

/**
 * DELETE /api/projects/:projectId — remove the project's local directory only.
 * The git remote (if any) is never touched; re-cloning by `repoUrl` brings it
 * back. `force: true` also stops a live session/build/preview for the project
 * first, rather than 409ing on them — same shape as preview's `force` evict.
 */
export interface RemoveProjectRequest {
  force?: boolean
}

/** 409 from a remove without force — something's still using the project. The client offers a confirm dialog listing `blockers`, then retries with `force: true`. */
export interface RemoveProjectConflictResponse {
  error: string
  blockers: string[]
}

// --- Build progress (Phase 2.6): live setup output over its own SSE ----------

/**
 * Where a project's setup is. `cloning`/`installing` are in-flight; `ready`,
 * `error`, and `cancelled` are terminal. This rides a dedicated, non-durable
 * stream (GET /api/projects/:id/build) — the raw git/npm output is high-volume
 * and must never bloat the durable event log.
 */
export type BuildPhase = 'cloning' | 'installing' | 'ready' | 'error' | 'cancelled'

/** The full state of an in-progress (or recently finished) build. */
export interface BuildSnapshot {
  projectId: string
  phase: BuildPhase
  /** Terminal output so far, oldest first (ring-buffered on the server). */
  lines: string[]
  /** Set when `phase === 'error'` (or `'cancelled'`). */
  error?: string
  /** Non-fatal note, e.g. the clone succeeded but dependency install failed. */
  warning?: string
}

/** Messages on GET /api/projects/:id/build. A `snapshot` arrives first. */
export type BuildStreamMessage =
  | { type: 'snapshot'; snapshot: BuildSnapshot }
  | { type: 'line'; line: string }
  | { type: 'phase'; phase: BuildPhase; error?: string; warning?: string }

// --- Preview (Phase 5): a project's dev server, iframed in a drawer ---------

/**
 * Where the preview's dev server is. `starting` covers spawn-through-port-poll;
 * `running` is serving (the client swaps its spinner for the iframe here);
 * `error`/`stopped` are terminal. Rides its own non-durable stream (GET
 * /api/projects/:id/preview/stream), same shape as BuildStreamMessage — the
 * dev server's stdout/stderr is high-volume and must never bloat the log.
 */
export type PreviewPhase = 'starting' | 'running' | 'error' | 'stopped'

/** The full state of the active (or just-stopped) preview. */
export interface PreviewSnapshot {
  projectId: string
  phase: PreviewPhase
  /** Dev-server output so far, oldest first (ring-buffered on the server). */
  lines: string[]
  /** Set when `phase === 'error'`. */
  error?: string
}

/** Messages on GET /api/projects/:id/preview/stream. A `snapshot` arrives first. */
export type PreviewStreamMessage =
  | { type: 'snapshot'; snapshot: PreviewSnapshot }
  | { type: 'line'; line: string }
  | { type: 'phase'; phase: PreviewPhase; error?: string }

/** POST /api/projects/:id/preview/start. `force` evicts a different project's active preview. */
export interface StartPreviewRequest {
  force?: boolean
}

/** 409 from start — another project's preview is active; the client offers the confirm dialog. */
export interface PreviewConflictResponse {
  error: string
  activeProjectId: string
}

// --- Turn changes (Phase 2.7): what a turn touched -------------------------

/** One file changed during a turn — names + counts; the diff is fetched per file. */
export interface ChangedFile {
  path: string
  additions: number
  deletions: number
  status: 'added' | 'modified' | 'deleted' | 'renamed'
}

/** GET /api/projects/:id/changes?base=&path= — before/after for one file's diff. */
export interface FileDiffResponse {
  path: string
  before: string
  after: string
}

// --- Questions (Phase 2.7): the agent's AskUserQuestion, rendered inline ------

/** One choice for a question. `preview` is optional richer content (unused for now). */
export interface QuestionOption {
  label: string
  description: string
  preview?: string
}

/** A single multiple-choice question — mirrors the SDK's AskUserQuestion schema. */
export interface Question {
  question: string
  /** Short chip label, e.g. "Auth method". */
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

/** POST /api/questions/:requestId — answers keyed by question text. */
export interface AnswerQuestionRequest {
  answers: Record<string, string>
}

// --- Project .env editor (Phase 2.7) ---------------------------------------

/** One KEY=value line from a project's .env. */
export interface EnvEntry {
  key: string
  value: string
}

/** GET /api/projects/:id/env — the project's .env, plus whether a .env.example exists. */
export interface EnvFileResponse {
  entries: EnvEntry[]
  hasExample: boolean
}

/** PUT /api/projects/:id/env — replace the file with these entries. */
export interface SaveEnvRequest {
  entries: EnvEntry[]
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

// --- Presence, so a push never buzzes a screen someone is already looking at --

/**
 * POST /api/presence — the page reporting its own `document.visibilityState`.
 * `clientId` is a random id minted once per tab (localStorage) and reused for
 * the lifetime of that tab, so the server can tell "this tab went hidden" from
 * "some other tab is still visible" instead of tracking one global flag.
 */
export interface PresenceRequest {
  clientId: string
  visible: boolean
}

// --- Images: attached to a prompt, forwarded to Claude as multimodal content --

/** Formats Claude's API accepts as image content blocks. */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

/**
 * A stored image, referenced by id. The id is opaque to the client but is in
 * fact the server's filename (uuid + extension) — never inline bytes here;
 * that's what keeps the event log light. See workspace-server's UploadStore.
 */
export interface ImageRef {
  id: string
  mediaType: ImageMediaType
  /** Bytes on disk, for client display ("2.1 MB"). */
  size: number
}

/** POST /api/uploads/images — multipart/form-data, field "images", 1..N files. */
export interface UploadImagesResponse {
  images: ImageRef[]
}
