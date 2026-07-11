import { LEGACY_THREAD_ID, type ChangedFile, type Event, type Question } from '@mce/protocol'

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
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      toolUseId: string
      name: string
      input: unknown
      status: 'running' | 'ok' | 'error'
      summary?: string
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
  | { kind: 'turn'; key: string }
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
}

export const initialState: State = {
  lastSeq: 0,
  byThread: {},
  created: [],
  failed: {},
  building: [],
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
      return { ...state, agent: 'thinking', items: [...state.items, { kind: 'user', key, text: event.text }] }

    case 'assistant_text':
      return { ...state, items: [...state.items, { kind: 'assistant', key, text: event.text }] }

    case 'tool_use':
      return {
        ...state,
        items: [
          ...state.items,
          { kind: 'tool', key, toolUseId: event.toolUseId, name: event.name, input: event.input, status: 'running' },
        ],
        toolIndex: { ...state.toolIndex, [event.toolUseId]: state.items.length },
      }

    case 'tool_result': {
      const index = state.toolIndex[event.toolUseId]
      const item = index === undefined ? undefined : state.items[index]
      if (item?.kind !== 'tool') return state
      return {
        ...state,
        items: replace(state.items, index!, { ...item, status: event.ok ? 'ok' : 'error', summary: event.summary }),
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
      return { ...state, agent: 'awaiting_input', items: [...state.items, { kind: 'turn', key }] }

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
