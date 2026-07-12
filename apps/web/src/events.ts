import { LEGACY_THREAD_ID, type ChangedFile, type Event, type ImageRef, type Question } from '@mce/protocol'

/**
 * A reducer over the event union. Events in, renderable per-thread views out.
 *
 * The client is a view over a log with a cursor, not a WebSocket peer — that is
 * why backgrounding the phone is a no-op. Phase 2.5: the log is one global stream
 * keyed by `thread_id`, so the reducer keeps a view *per thread* and the UI
 * renders the active one. Switching is instant (no refetch), and the SSE route
 * stays untouched. Legacy events (no threadId) collect under `LEGACY_THREAD_ID`.
 */

export type Item =
  | { kind: 'user'; key: string; text: string; images?: ImageRef[] }
  | { kind: 'assistant'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      toolUseId: string
      name: string
      input: unknown
      status: 'running' | 'ok' | 'error'
      summary?: string
      /** epoch ms the tool_use arrived; tool groups use this to time themselves. */
      ts: number
      /** epoch ms the matching tool_result arrived. */
      endTs?: number
    }
  | {
      kind: 'approval'
      key: string
      approvalId: string
      tool: string
      input: unknown
      title?: string
      displayName?: string
      description?: string
      status: 'pending' | 'allowed' | 'denied' | 'expired'
      reason?: string
    }
  | { kind: 'turn'; key: string; ts: number }
  | { kind: 'changes'; key: string; base: string; files: ChangedFile[] }
  | {
      kind: 'question'
      key: string
      requestId: string
      questions: Question[]
      status: 'pending' | 'answered' | 'cancelled'
      answers?: Record<string, string>
    }
  | { kind: 'ended'; key: string; reason: string; message?: string }

export type AgentState = 'idle' | 'thinking' | 'awaiting_approval' | 'awaiting_input' | 'ended'

/** One project's conversation view. */
export interface ProjectState {
  items: Item[]
  toolIndex: Record<string, number>
  approvalIndex: Record<string, number>
  questionIndex: Record<string, number>
  agent: AgentState
  sessionId: string | null
}

export const emptyProjectState: ProjectState = {
  items: [],
  toolIndex: {},
  approvalIndex: {},
  questionIndex: {},
  agent: 'idle',
  sessionId: null,
}

export interface State {
  lastSeq: number
  /** Per-thread conversation views, keyed by threadId (legacy → LEGACY_THREAD_ID). */
  byThread: Record<string, ProjectState>
  /**
   * Signals for the picker: names of projects created / failed. The authoritative
   * list is GET /api/projects (it reads disk); these just say "refetch" / "show
   * this error", so a slow clone lands in the UI when it finishes.
   */
  created: string[]
  failed: Record<string, string>
  /** Project ids whose setup is in progress — drives the blocking build modal. */
  building: string[]
  /**
   * The project id with an active preview dev server, or null. Durable
   * (`preview_started`/`preview_stopped`), so a reload or a second tab sees the
   * peeked bar for whichever project is actually still running — not just the
   * tab that tapped the button. At most one, by construction (PHASE-5.md).
   */
  preview: string | null
}

export const initialState: State = {
  lastSeq: 0,
  byThread: {},
  created: [],
  failed: {},
  building: [],
  preview: null,
}

/** The view for a thread, or an empty one if it has no events yet. */
export function viewOf(state: State, threadId: string | null): ProjectState {
  if (!threadId) return emptyProjectState
  return state.byThread[threadId] ?? emptyProjectState
}

export function reduce(state: State, event: Event): State {
  // Replay is strictly `seq >` on the server, but a reconnect race or a double
  // mount in React StrictMode can still hand us an event twice. Ignore it.
  if (event.seq <= state.lastSeq) return state
  const base = { ...state, lastSeq: event.seq }

  // Project lifecycle events aren't conversation — they drive the picker and the
  // build modal. `building` is the set with a `started` but no terminal event.
  if (event.type === 'project_create_started') {
    return { ...base, building: without(state.building, event.name).concat(event.name) }
  }
  if (event.type === 'project_created') {
    return { ...base, building: without(state.building, event.name), created: [...state.created, event.name] }
  }
  if (event.type === 'project_create_failed') {
    return {
      ...base,
      building: without(state.building, event.name),
      failed: { ...state.failed, [event.name]: event.error },
    }
  }

  // Preview lifecycle (Phase 5) — also not conversation. Single-slot: a
  // `preview_stopped` only clears `preview` if it's for the project that's
  // currently recorded (a belated stop for an already-superseded preview is a
  // no-op, mirroring PreviewManager's own stale-handler guard server-side).
  if (event.type === 'preview_started') {
    return { ...base, preview: event.projectId }
  }
  if (event.type === 'preview_stopped') {
    return { ...base, preview: state.preview === event.projectId ? null : state.preview }
  }

  // Every other event belongs to a thread. Legacy events (no threadId) collect
  // under the sentinel bucket so the "Earlier conversation" thread can show them.
  const threadId = event.threadId ?? LEGACY_THREAD_ID
  const view = state.byThread[threadId] ?? emptyProjectState
  const next = reduceProject(view, event)
  if (next === view) return base
  return { ...base, byThread: { ...state.byThread, [threadId]: next } }
}

/** A copy of the list with `name` removed. */
function without(list: string[], name: string): string[] {
  return list.filter((n) => n !== name)
}

/** Replaces one item without mutating the array. */
function replace(items: Item[], index: number, next: Item): Item[] {
  const copy = items.slice()
  copy[index] = next
  return copy
}

/** The per-project projection. Same logic as the pre-Phase-2 single reducer. */
function reduceProject(state: ProjectState, event: Event): ProjectState {
  const key = String(event.seq)

  switch (event.type) {
    case 'session_started':
      return { ...state, agent: 'thinking', sessionId: event.sessionId }

    case 'user_prompt':
      return {
        ...state,
        agent: 'thinking',
        items: [...state.items, { kind: 'user', key, text: event.text, ...(event.images ? { images: event.images } : {}) }],
      }

    case 'assistant_text':
      return { ...state, items: [...state.items, { kind: 'assistant', key, text: event.text }] }

    case 'tool_use':
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: 'tool',
            key,
            toolUseId: event.toolUseId,
            name: event.name,
            input: event.input,
            status: 'running',
            ts: event.ts,
          },
        ],
        toolIndex: { ...state.toolIndex, [event.toolUseId]: state.items.length },
      }

    case 'tool_result': {
      const index = state.toolIndex[event.toolUseId]
      const item = index === undefined ? undefined : state.items[index]
      if (item?.kind !== 'tool') return state
      return {
        ...state,
        items: replace(state.items, index!, {
          ...item,
          status: event.ok ? 'ok' : 'error',
          summary: event.summary,
          endTs: event.ts,
        }),
      }
    }

    case 'approval_request':
      return {
        ...state,
        agent: 'awaiting_approval',
        items: [
          ...state.items,
          {
            kind: 'approval',
            key,
            approvalId: event.approvalId,
            tool: event.tool,
            input: event.input,
            title: event.title,
            displayName: event.displayName,
            description: event.description,
            status: 'pending',
          },
        ],
        approvalIndex: { ...state.approvalIndex, [event.approvalId]: state.items.length },
      }

    case 'approval_decision':
    case 'approval_expired': {
      const index = state.approvalIndex[event.approvalId]
      const item = index === undefined ? undefined : state.items[index]
      if (item?.kind !== 'approval') return state

      const status = event.type === 'approval_expired' ? 'expired' : event.allow ? 'allowed' : 'denied'
      const reason = event.type === 'approval_decision' ? event.reason : undefined

      const items = replace(state.items, index!, { ...item, status, ...(reason ? { reason } : {}) })
      const stillWaiting = items.some((i) => i.kind === 'approval' && i.status === 'pending')
      return { ...state, items, agent: stillWaiting ? 'awaiting_approval' : 'thinking' }
    }

    case 'question_request':
      return {
        ...state,
        agent: 'awaiting_approval',
        items: [
          ...state.items,
          { kind: 'question', key, requestId: event.requestId, questions: event.questions, status: 'pending' },
        ],
        questionIndex: { ...state.questionIndex, [event.requestId]: state.items.length },
      }

    case 'question_answered':
    case 'question_cancelled': {
      const index = state.questionIndex[event.requestId]
      const item = index === undefined ? undefined : state.items[index]
      if (item?.kind !== 'question') return state
      const answered = event.type === 'question_answered'
      const items = replace(state.items, index!, {
        ...item,
        status: answered ? 'answered' : 'cancelled',
        ...(answered ? { answers: event.answers } : {}),
      })
      const stillWaiting = items.some((i) => i.kind === 'question' && i.status === 'pending')
      return { ...state, items, agent: stillWaiting ? 'awaiting_approval' : 'thinking' }
    }

    case 'turn_complete':
      return { ...state, agent: 'awaiting_input', items: [...state.items, { kind: 'turn', key, ts: event.ts }] }

    case 'turn_changes':
      return {
        ...state,
        items: [...state.items, { kind: 'changes', key, base: event.base, files: event.files }],
      }

    /**
     * Clear this project's view. Claude has forgotten the conversation, so
     * showing it would be showing something that no longer exists. The log keeps
     * every event; replaying from seq 0 reaches the reset and lands back empty,
     * which is what makes reload-after-reset show a fresh view.
     */
    case 'conversation_reset':
      return { ...emptyProjectState }

    case 'session_ended':
      return {
        ...state,
        agent: 'ended',
        items: [...state.items, { kind: 'ended', key, reason: event.reason, message: event.message }],
      }

    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Tool-call grouping: a view concern only. A burst of Bash/Read/Edit calls
// during one turn otherwise floods the thread with one row per call; this
// collapses each consecutive run of `tool` items into a single row that reads
// "Thinking…" while it's still the tail of a `thinking` conversation, then
// "Worked Xm Ys" once the agent has moved on. `items` itself stays untouched —
// callers that need the flat log (tests, the toolIndex patching above) are
// unaffected.
// ---------------------------------------------------------------------------

type ToolItem = Extract<Item, { kind: 'tool' }>

export interface ToolGroup {
  kind: 'toolGroup'
  key: string
  tools: ToolItem[]
  /** Still the tail of an in-progress turn — no end time yet, nothing to expand. */
  running: boolean
  durationMs?: number
  /** Diff totals, if a `turn_changes` event landed right after this group. */
  changes?: ChangedFile[]
}

export type DisplayItem = Item | ToolGroup

export function groupTools(items: Item[], agentThinking: boolean): DisplayItem[] {
  const out: DisplayItem[] = []
  let i = 0
  while (i < items.length) {
    const item = items[i]
    if (item === undefined) break
    if (item.kind !== 'tool') {
      out.push(item)
      i++
      continue
    }

    const start = i
    while (i < items.length && items[i]?.kind === 'tool') i++
    const tools = items.slice(start, i) as ToolItem[]
    const first = tools[0]
    const last = tools[tools.length - 1]
    if (!first || !last) break // unreachable: the while loop above ran at least once
    const running = i === items.length && agentThinking

    // Peek (without consuming) past the group for a `turn` boundary and the
    // `turn_changes` diff summary that typically follows it, so the group can
    // report a real end time and file-diff totals without a protocol change.
    let peek = i
    let endTs = last.endTs ?? last.ts
    const maybeTurn = items[peek]
    if (maybeTurn?.kind === 'turn') {
      endTs = maybeTurn.ts
      peek++
    }
    const maybeChanges = items[peek]
    const changes = maybeChanges?.kind === 'changes' ? maybeChanges.files : undefined

    out.push({
      kind: 'toolGroup',
      key: `group-${first.key}`,
      tools,
      running,
      durationMs: running ? undefined : Math.max(0, endTs - first.ts),
      changes,
    })
  }
  return out
}

/** "9m 31s" / "42s" — never "0s", a group always took at least a second. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}
