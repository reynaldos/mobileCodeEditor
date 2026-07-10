import type { Event } from '@mce/protocol'

/**
 * A reducer over the event union. Events in, a renderable conversation out.
 *
 * The client is a view over a log with a cursor, not a WebSocket peer. That is
 * why backgrounding the phone is a no-op rather than an error case.
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
  | { kind: 'ended'; key: string; reason: string; message?: string }

export type AgentState = 'idle' | 'thinking' | 'awaiting_approval' | 'awaiting_input' | 'ended'

export interface State {
  items: Item[]
  /** item index by correlation id, so results can find their tool call */
  toolIndex: Record<string, number>
  approvalIndex: Record<string, number>
  lastSeq: number
  agent: AgentState
  sessionId: string | null
}

/**
 * No cost in this state, deliberately.
 *
 * Usage runs on a Claude subscription, so `total_cost_usd` is what the tokens
 * would have cost at API rates — a meter reading, not an invoice. Showing it in
 * a header makes it read as money spent.
 *
 * The log still records `costUsd` on turn_complete and session_ended, and
 * `apiKeySource` on session_started. Usage analytics is a query over the log,
 * which is exactly the property the log exists for. See ROADMAP "Usage".
 */
export const initialState: State = {
  items: [],
  toolIndex: {},
  approvalIndex: {},
  lastSeq: 0,
  agent: 'idle',
  sessionId: null,
}

/** Replaces one item without mutating the array. */
function replace(items: Item[], index: number, next: Item): Item[] {
  const copy = items.slice()
  copy[index] = next
  return copy
}

export function reduce(state: State, event: Event): State {
  // Replay is strictly `seq >` on the server, but a reconnect race or a double
  // mount in React StrictMode can still hand us an event twice. Ignore it.
  if (event.seq <= state.lastSeq) return state
  const base = { ...state, lastSeq: event.seq }
  const key = String(event.seq)

  switch (event.type) {
    case 'session_started':
      return { ...base, agent: 'thinking', sessionId: event.sessionId }

    case 'user_prompt':
      return { ...base, agent: 'thinking', items: [...state.items, { kind: 'user', key, text: event.text }] }

    case 'assistant_text':
      return { ...base, items: [...state.items, { kind: 'assistant', key, text: event.text }] }

    case 'tool_use':
      return {
        ...base,
        items: [
          ...state.items,
          {
            kind: 'tool',
            key,
            toolUseId: event.toolUseId,
            name: event.name,
            input: event.input,
            status: 'running',
          },
        ],
        toolIndex: { ...state.toolIndex, [event.toolUseId]: state.items.length },
      }

    case 'tool_result': {
      const index = state.toolIndex[event.toolUseId]
      const item = index === undefined ? undefined : state.items[index]
      if (item?.kind !== 'tool') return base

      return {
        ...base,
        items: replace(state.items, index!, {
          ...item,
          status: event.ok ? 'ok' : 'error',
          summary: event.summary,
        }),
      }
    }

    case 'approval_request':
      return {
        ...base,
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
      if (item?.kind !== 'approval') return base

      const status =
        event.type === 'approval_expired' ? 'expired' : event.allow ? 'allowed' : 'denied'
      const reason = event.type === 'approval_decision' ? event.reason : undefined

      const items = replace(state.items, index!, { ...item, status, ...(reason ? { reason } : {}) })
      const stillWaiting = items.some((i) => i.kind === 'approval' && i.status === 'pending')

      return { ...base, items, agent: stillWaiting ? 'awaiting_approval' : 'thinking' }
    }

    case 'turn_complete':
      return { ...base, agent: 'awaiting_input', items: [...state.items, { kind: 'turn', key }] }

    case 'session_ended':
      return {
        ...base,
        agent: 'ended',
        items: [
          ...state.items,
          { kind: 'ended', key, reason: event.reason, message: event.message },
        ],
      }

    default:
      return base
  }
}
