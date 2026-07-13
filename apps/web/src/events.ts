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

/** One checklist entry from a TodoWrite call. */
export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** A task from the Task* tool family (TaskCreate/TaskUpdate/TaskList), folded
 *  into the same card as todos. */
interface TaskRow {
  id: string
  subject: string
  status: Todo['status']
}

/** One tool call, patched in place from `running` to `ok`/`error` when its
 *  result lands. Named (not inline) so a `subagent` can hold a list of them. */
export interface ToolItem {
  kind: 'tool'
  key: string
  toolUseId: string
  name: string
  input: unknown
  status: 'running' | 'ok' | 'error'
  summary?: string
  /** The fuller result body — only present for tools we capture it for (Bash, Task*). */
  output?: string
  /** epoch ms the tool_use arrived; tool groups use this to time themselves. */
  ts: number
  /** epoch ms the matching tool_result arrived. */
  endTs?: number
}

export type Item =
  | { kind: 'user'; key: string; text: string; images?: ImageRef[] }
  | { kind: 'assistant'; key: string; text: string }
  | ToolItem
  | {
      // A `Task` sub-agent, rendered as its own row. Its internal tool calls
      // (which the SDK streams to us as a heartbeat) fold into `tools` instead of
      // flooding the main thread. `report` is the sub-agent's final result body.
      kind: 'subagent'
      key: string
      toolUseId: string
      description: string
      subagentType?: string
      tools: ToolItem[]
      status: 'running' | 'ok' | 'error'
      ts: number
      endTs?: number
      report?: string
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
  // TodoWrite renders as a single live checklist card, updated in place — not a
  // tool row — so it never floods the thread or fragments a "Worked" group.
  | { kind: 'todo'; key: string; todos: Todo[] }

export type AgentState = 'idle' | 'thinking' | 'awaiting_approval' | 'awaiting_input' | 'ended'

/** The three-way badge a thread list shows per row — coarser than `AgentState`
 *  (which distinguishes idle/awaiting_input/ended for the conversation header)
 *  because a list of many threads only needs "still working" vs "needs a
 *  decision" vs "nothing going on." */
export type ThreadStatus = 'active' | 'needs-action' | 'inactive'

export function threadStatus(agent: AgentState | undefined): ThreadStatus {
  if (agent === 'thinking') return 'active'
  if (agent === 'awaiting_approval') return 'needs-action'
  return 'inactive'
}

/** One project's conversation view. */
export interface ProjectState {
  items: Item[]
  toolIndex: Record<string, number>
  approvalIndex: Record<string, number>
  questionIndex: Record<string, number>
  /** Index of the current turn's live todo/task card, or null before its first update. */
  todoAt: number | null
  /** Task* projection (id -> subject/status), folded from TaskCreate/Update/List. */
  tasks: TaskRow[]
  /** toolUseIds of TaskCreate/TaskList calls whose results we still need to read. */
  taskTools: Record<string, 'TaskCreate' | 'TaskList'>
  /** `Task` (sub-agent) toolUseId -> index of its `subagent` item, so a
   *  sub-agent's streamed tool calls fold into its row instead of the main thread. */
  subagentIndex: Record<string, number>
  agent: AgentState
  sessionId: string | null
}

export const emptyProjectState: ProjectState = {
  items: [],
  toolIndex: {},
  approvalIndex: {},
  questionIndex: {},
  todoAt: null,
  tasks: [],
  taskTools: {},
  subagentIndex: {},
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
   * Project ids removed ("offloaded") elsewhere — another tab/device, or this
   * one. Same "just says refetch" signal as `created`: the picker's list stays
   * authoritative from GET /api/projects, this only triggers the refetch.
   */
  removed: string[]
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
  removed: [],
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
  if (event.type === 'project_removed') {
    return { ...base, removed: [...state.removed, event.projectId] }
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
        // A new user turn starts a fresh todo/task card and drops any half-read
        // Task* result ids from the previous turn.
        todoAt: null,
        tasks: [],
        taskTools: {},
        items: [...state.items, { kind: 'user', key, text: event.text, ...(event.images ? { images: event.images } : {}) }],
      }

    case 'assistant_text':
      return { ...state, items: [...state.items, { kind: 'assistant', key, text: event.text }] }

    case 'tool_use': {
      // Sub-agent activity first (Task tool). A call carrying a known
      // `parentToolUseId` ran INSIDE a sub-agent — fold it into that row. Checked
      // before TodoWrite/Task* so a sub-agent's own TodoWrite stays in its row
      // rather than hijacking the main thread's task card.
      if (event.parentToolUseId !== undefined && state.subagentIndex[event.parentToolUseId] !== undefined) {
        return foldSubagentChild(state, event.parentToolUseId, event.toolUseId, event.name, event.input, event.ts, key)
      }
      if (event.name === 'Task') {
        return startSubagent(state, event.input, event.toolUseId, event.ts, key)
      }
      // The task list is a single live card, not tool rows — so repeated updates
      // don't flood the thread or split the surrounding "Worked" group (grouping
      // only folds consecutive `tool` items). Two tools feed it: the older
      // TodoWrite (whole list in its input) and the newer Task* family.
      if (event.name === 'TodoWrite') {
        const todos = parseTodos(event.input)
        return todos.length === 0 ? state : withTodoCard(state, todos, key)
      }
      if (TASK_TOOLS.has(event.name)) {
        return reduceTaskUse(state, event.name, event.input, event.toolUseId, key)
      }
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
    }

    case 'tool_result': {
      // A `Task`'s own result closes its sub-agent row (its output is the report).
      if (state.subagentIndex[event.toolUseId] !== undefined) {
        return finishSubagent(state, event.toolUseId, event.ok, event.output, event.ts)
      }
      // A tool that ran inside a sub-agent → patch it within that row.
      if (event.parentToolUseId !== undefined && state.subagentIndex[event.parentToolUseId] !== undefined) {
        return foldSubagentResult(state, event.parentToolUseId, event.toolUseId, event.ok, event.summary, event.output, event.ts)
      }

      // TaskCreate/TaskList carry their data in the result body (`output`), not
      // the input — fold it into the task card instead of patching a tool row.
      const taskTool = state.taskTools[event.toolUseId]
      if (taskTool) return reduceTaskResult(state, taskTool, event.output, key)

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
          ...(event.output ? { output: event.output } : {}),
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

/** The todos array from a TodoWrite tool input, defensively parsed. */
function parseTodos(input: unknown): Todo[] {
  if (!input || typeof input !== 'object') return []
  const raw = (input as { todos?: unknown }).todos
  if (!Array.isArray(raw)) return []
  const out: Todo[] = []
  for (const t of raw) {
    if (t && typeof t === 'object' && typeof (t as { content?: unknown }).content === 'string') {
      const { content, status } = t as { content: string; status?: Todo['status'] }
      out.push({ content, status: status ?? 'pending' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The task-list card. One live card per turn, minted/updated via `todoAt`, fed
// by either TodoWrite (whole list in its input) or the newer Task* family. The
// Task* family is stateful: TaskCreate/TaskList carry their data in the RESULT
// (with server-assigned ids), TaskUpdate carries status in its INPUT — so we
// fold a small projection (`tasks`) and re-render the card as each lands.
// ---------------------------------------------------------------------------

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList'])

/** Mint or update the single live todo/task card (kept per turn via `todoAt`). */
function withTodoCard(state: ProjectState, todos: Todo[], key: string): ProjectState {
  const existing = state.todoAt === null ? undefined : state.items[state.todoAt]
  if (existing?.kind === 'todo') {
    return { ...state, items: replace(state.items, state.todoAt!, { ...existing, todos }) }
  }
  return { ...state, items: [...state.items, { kind: 'todo', key, todos }], todoAt: state.items.length }
}

/** Re-render the card from the current task projection (no-op while empty). */
function syncTaskCard(state: ProjectState, key: string): ProjectState {
  if (state.tasks.length === 0) return state
  return withTodoCard(state, state.tasks.map((t) => ({ content: t.subject, status: t.status })), key)
}

/** A TaskUpdate applies from its input right away; TaskCreate/TaskList carry
 *  their data in the result, so we just note the id to read when it lands. */
function reduceTaskUse(state: ProjectState, name: string, input: unknown, toolUseId: string, key: string): ProjectState {
  if (name !== 'TaskUpdate') {
    return { ...state, taskTools: { ...state.taskTools, [toolUseId]: name as 'TaskCreate' | 'TaskList' } }
  }
  const upd = parseTaskUpdate(input)
  if (!upd.taskId) return state
  const tasks =
    upd.status === 'deleted'
      ? state.tasks.filter((t) => t.id !== upd.taskId)
      : state.tasks.map((t) =>
          t.id === upd.taskId
            ? { ...t, ...(upd.subject ? { subject: upd.subject } : {}), ...(isStatus(upd.status) ? { status: upd.status } : {}) }
            : t,
        )
  return syncTaskCard({ ...state, tasks }, key)
}

/** Fold a TaskCreate ({task:{id,subject}}) or TaskList ({tasks:[...]}) result. */
function reduceTaskResult(state: ProjectState, tool: 'TaskCreate' | 'TaskList', output: string | undefined, key: string): ProjectState {
  const data = output ? tolerantJson(output) : undefined
  if (!data || typeof data !== 'object') return state

  if (tool === 'TaskCreate') {
    const task = (data as { task?: { id?: unknown; subject?: unknown } }).task
    if (!task || typeof task.id !== 'string' || typeof task.subject !== 'string') return state
    return syncTaskCard({ ...state, tasks: upsertTask(state.tasks, { id: task.id, subject: task.subject, status: 'pending' }) }, key)
  }

  const list = (data as { tasks?: unknown }).tasks // TaskList — the authoritative snapshot
  if (!Array.isArray(list)) return state
  const tasks: TaskRow[] = []
  for (const t of list) {
    const r = t as { id?: unknown; subject?: unknown; status?: unknown }
    if (t && typeof t === 'object' && typeof r.id === 'string' && typeof r.subject === 'string') {
      tasks.push({ id: r.id, subject: r.subject, status: isStatus(r.status) ? r.status : 'pending' })
    }
  }
  return syncTaskCard({ ...state, tasks }, key)
}

function upsertTask(tasks: TaskRow[], task: TaskRow): TaskRow[] {
  return tasks.some((t) => t.id === task.id) ? tasks.map((t) => (t.id === task.id ? { ...t, ...task } : t)) : [...tasks, task]
}

function isStatus(s: unknown): s is Todo['status'] {
  return s === 'pending' || s === 'in_progress' || s === 'completed'
}

function parseTaskUpdate(input: unknown): { taskId?: string; status?: string; subject?: string } {
  if (!input || typeof input !== 'object') return {}
  const o = input as Record<string, unknown>
  return {
    taskId: typeof o.taskId === 'string' ? o.taskId : undefined,
    status: typeof o.status === 'string' ? o.status : undefined,
    subject: typeof o.subject === 'string' ? o.subject : undefined,
  }
}

/** Parse a result body as JSON — directly, or the first {...} block if it's
 *  wrapped in text. Returns undefined rather than throwing on anything unexpected. */
function tolerantJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        /* fall through */
      }
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Sub-agents (the `Task` tool). A launch mints a `subagent` row; the tool calls
// the SDK streams from inside it (tagged with the launch's toolUseId as their
// `parentToolUseId`) fold into that row's `tools` list, live, instead of
// flooding the main thread. The `Task` result closes the row. Nested sub-agents
// (a Task launched inside a Task) fall back to a plain child row — one level of
// nesting is rendered; deeper internals aren't folded, which is rare in practice.
// ---------------------------------------------------------------------------

/** Pull the launch metadata out of a `Task` tool input. */
function parseTaskLaunch(input: unknown): { description: string; subagentType?: string } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const description = typeof o.description === 'string' && o.description ? o.description : 'sub-agent'
  const subagentType = typeof o.subagent_type === 'string' ? o.subagent_type : undefined
  return { description, ...(subagentType ? { subagentType } : {}) }
}

/** Mint a `subagent` row for a `Task` launch, indexed by its toolUseId. */
function startSubagent(state: ProjectState, input: unknown, toolUseId: string, ts: number, key: string): ProjectState {
  const { description, subagentType } = parseTaskLaunch(input)
  return {
    ...state,
    items: [
      ...state.items,
      { kind: 'subagent', key, toolUseId, description, ...(subagentType ? { subagentType } : {}), tools: [], status: 'running', ts },
    ],
    subagentIndex: { ...state.subagentIndex, [toolUseId]: state.items.length },
  }
}

/** Append a running child tool to a sub-agent's row. */
function foldSubagentChild(
  state: ProjectState,
  parentId: string,
  toolUseId: string,
  name: string,
  input: unknown,
  ts: number,
  key: string,
): ProjectState {
  const index = state.subagentIndex[parentId]
  const sub = index === undefined ? undefined : state.items[index]
  if (sub?.kind !== 'subagent') return state
  const child: ToolItem = { kind: 'tool', key, toolUseId, name, input, status: 'running', ts }
  return { ...state, items: replace(state.items, index!, { ...sub, tools: [...sub.tools, child] }) }
}

/** Patch a sub-agent's child tool when its result lands (matched by toolUseId). */
function foldSubagentResult(
  state: ProjectState,
  parentId: string,
  toolUseId: string,
  ok: boolean,
  summary: string,
  output: string | undefined,
  ts: number,
): ProjectState {
  const index = state.subagentIndex[parentId]
  const sub = index === undefined ? undefined : state.items[index]
  if (sub?.kind !== 'subagent') return state
  const ci = sub.tools.findIndex((t) => t.toolUseId === toolUseId)
  if (ci === -1) return state
  const tools = sub.tools.slice()
  tools[ci] = { ...sub.tools[ci]!, status: ok ? 'ok' : 'error', summary, endTs: ts, ...(output ? { output } : {}) }
  return { ...state, items: replace(state.items, index!, { ...sub, tools }) }
}

/** Close a sub-agent's row on its `Task` result; the output is its report. */
function finishSubagent(state: ProjectState, toolUseId: string, ok: boolean, output: string | undefined, ts: number): ProjectState {
  const index = state.subagentIndex[toolUseId]
  const sub = index === undefined ? undefined : state.items[index]
  if (sub?.kind !== 'subagent') return state
  return {
    ...state,
    items: replace(state.items, index!, { ...sub, status: ok ? 'ok' : 'error', endTs: ts, ...(output ? { report: output } : {}) }),
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
