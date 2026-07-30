import { Bot, Check, Copy, MoreHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { imageUrl } from '../api.ts'
import { formatDuration, groupTools, type AgentState, type Item, type Todo, type ToolGroup } from '../events.ts'
import { relativePath, targetOf } from '../paths.ts'
import { ApprovalCard } from './ApprovalCard.tsx'
import { ChangesView } from './ChangesView.tsx'
import { Markdown } from './Markdown.tsx'
import { QuestionCard } from './QuestionCard.tsx'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from './ui/drawer.tsx'

interface Props {
  items: Item[]
  projectId?: string
  agent?: AgentState
  /** Open a changed file in the Explorer (the thread changes-card "View file" kebab). */
  onViewFile?: (path: string) => void
}

const DOT: Record<'running' | 'ok' | 'error', string> = {
  running: 'bg-accent animate-pulse-dot',
  ok: 'bg-add',
  error: 'bg-del',
}

const SEPARATOR = 'flex justify-center gap-2 py-1 text-[11px] uppercase tracking-[0.08em] text-muted'

/** How close to the bottom (px) still counts as "following" the stream. */
const BOTTOM_THRESHOLD = 120

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const EXPLORE_TOOLS = new Set(['Read', 'Glob', 'Grep'])

/** "Edited 2 files, explored 3 files, 5 other tools" — skips any zero part. */
function summarizeGroup(tools: ToolGroup['tools']): string {
  const edited = new Set<string>()
  const explored = new Set<string>()
  let other = 0
  for (const t of tools) {
    const target = targetOf(t.input)
    if (EDIT_TOOLS.has(t.name)) edited.add(target ?? t.key)
    else if (EXPLORE_TOOLS.has(t.name)) explored.add(target ?? t.key)
    else other++
  }
  const parts: string[] = []
  if (edited.size) parts.push(`Edited ${edited.size} file${edited.size === 1 ? '' : 's'}`)
  if (explored.size) parts.push(`explored ${explored.size} file${explored.size === 1 ? '' : 's'}`)
  if (other) parts.push(`${other} other tool${other === 1 ? '' : 's'}`)
  return parts.join(', ')
}

const sumFiles = (files: { additions: number; deletions: number }[], key: 'additions' | 'deletions'): number =>
  files.reduce((n, f) => n + f[key], 0)

export function MessageList({ items, projectId, agent, onViewFile }: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  // Whether the reader is parked at (or near) the bottom. Updated on every scroll
  // and consulted before auto-scrolling, so streaming output only follows the
  // bottom when they're already there — never yanking them off older content.
  const atBottom = useRef(true)
  const rows = useMemo(() => groupTools(items, agent === 'thinking'), [items, agent])

  const pendingKey = items.find(
    (i) => (i.kind === 'approval' || i.kind === 'question') && i.status === 'pending',
  )?.key

  function onScroll(): void {
    const el = scroller.current
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD
  }

  useEffect(() => {
    // A pending approval/question blocks the agent, so it must never sit below the
    // fold: always jump to it (instantly — a smooth scroll started mid-message
    // lands short and leaves the card unreachable). Otherwise only follow new
    // output when the reader is already at the bottom.
    if (pendingKey) {
      bottom.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    } else if (atBottom.current) {
      bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [items.length, pendingKey])

  // The initial-fetch beat: right after a prompt is sent, while we wait on the
  // agent's first output. Show a single pulsing bubble so that latency doesn't
  // read as a hang. As soon as anything streams — a reply or a tool call — the
  // last row is no longer the user's own message, the bubble drops, and the
  // normal "Thinking…" tool UI takes over. So it never lingers past the first
  // response.
  const last = rows[rows.length - 1]
  const waiting = agent === 'thinking' && last?.kind === 'user'

  return (
    // `messages` carries the flex-shrink guard in styles.css. Do not rename it.
    <div ref={scroller} onScroll={onScroll} className="messages flex flex-1 flex-col gap-2.5 overflow-y-auto p-3.5">
      {items.length === 0 && (
        <p className="m-auto max-w-[30ch] text-center text-muted">
          Nothing yet. Tell Claude what to do — it&rsquo;s working in your repo, and every
          edit comes back here for you to approve.
        </p>
      )}

      {rows.map((row) =>
        row.kind === 'toolGroup' ? (
          <ToolGroupRow key={row.key} group={row} projectId={projectId} />
        ) : (
          <Row key={row.key} item={row} projectId={projectId} onViewFile={onViewFile} />
        ),
      )}
      {waiting && <TypingBubble />}
      <div ref={bottom} />
    </div>
  )
}

/** The initial-fetch indicator: a white bubble the size of the "Thinking…" dot,
 *  plus dots cycling . -> .. -> ..., so latency before the first output reads as
 *  alive rather than hung. */
function TypingBubble(): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5 self-start px-0.5 py-1 text-xs">
      <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-fg" />
      <span className="animate-dots text-muted" />
    </span>
  )
}

/**
 * A run of consecutive tool calls, collapsed to one row. "Thinking…" while
 * it's still the tail of an in-flight turn; "Worked Xm Ys" once the agent has
 * moved past it. Tap to open a drawer with the full list of what ran.
 */
function ToolGroupRow({ group, projectId }: { group: ToolGroup; projectId?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hasError = group.tools.some((t) => t.status === 'error')
  const summary = summarizeGroup(group.tools)
  const diff = group.changes?.length
    ? { add: sumFiles(group.changes, 'additions'), del: sumFiles(group.changes, 'deletions') }
    : undefined
  const label = group.running ? 'Thinking…' : `Worked ${formatDuration(group.durationMs ?? 0)}`
  // The tail item of a still-running group is whatever's happening right now —
  // including a sub-agent's own tool calls, which the SDK streams in as a
  // heartbeat. Surfacing it as a live line keeps a long turn (or a multi-minute
  // sub-agent) reading as active progress instead of a hang.
  const current = group.running ? group.tools[group.tools.length - 1] : undefined
  const currentTarget = current ? targetOf(current.input) : undefined

  return (
    <>
      <button
        type="button"
        disabled={group.running}
        onClick={() => setOpen(true)}
        className="flex max-w-[85%] flex-col items-start gap-0.5 self-start rounded-lg px-0.5 py-1 text-left text-xs disabled:cursor-default"
      >
        <span className="flex items-center gap-1.5">
          <span
            className={`size-1.5 shrink-0 rounded-full ${group.running ? 'bg-accent animate-pulse-dot' : hasError ? 'bg-del' : 'bg-add'}`}
          />
          <span className={group.running ? 'text-muted' : 'text-fg underline decoration-line underline-offset-2'}>
            {label}
          </span>
        </span>
        {current && (
          <span className="flex min-w-0 max-w-full items-center gap-1.5 pl-3 font-mono text-[11px] text-muted">
            <span className="shrink-0 not-italic">{current.name}</span>
            <span className="truncate">{currentTarget ? relativePath(currentTarget, projectId) : (current.summary ?? '')}</span>
            {group.tools.length > 1 && <span className="shrink-0 opacity-60">· {group.tools.length}</span>}
          </span>
        )}
        {!group.running && summary && (
          <span className="pl-3 font-mono text-[11px] text-muted">
            {summary}
            {diff && (
              <>
                {' '}
                <span className="text-add">+{diff.add}</span> <span className="text-del">-{diff.del}</span>
              </>
            )}
          </span>
        )}
      </button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{label}</DrawerTitle>
            {summary && <DrawerDescription>{summary}</DrawerDescription>}
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] [&>*]:shrink-0">
            {group.tools.map((t) => (
              <Row key={t.key} item={t} projectId={projectId} />
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}

const TODO_PREVIEW = 5

/** The live checklist from TodoWrite: header count, per-item status, strikethrough
 *  on done, and a "N more" toggle so a long list doesn't dominate the thread. */
function TodoRow({ todos }: { todos: Todo[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const done = todos.filter((t) => t.status === 'completed').length
  const shown = expanded ? todos : todos.slice(0, TODO_PREVIEW)
  const hidden = todos.length - shown.length

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium">
        <span>To-dos</span>
        <span className="text-muted">
          {done}/{todos.length}
        </span>
      </div>
      <ul>
        {shown.map((t, i) => (
          <li key={i} className="flex items-start gap-2 border-t border-line px-3 py-2 text-[13px]">
            <span
              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
                t.status === 'completed'
                  ? 'border-add bg-add/20 text-add'
                  : t.status === 'in_progress'
                    ? 'border-accent text-accent'
                    : 'border-line text-muted'
              }`}
            >
              {t.status === 'completed' && <Check className="size-3" />}
            </span>
            <span className={t.status === 'completed' ? 'text-muted line-through' : 'text-fg'}>{t.content}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center gap-1.5 border-t border-line px-3 py-2 text-[12px] text-muted hover:bg-panel-2"
        >
          <MoreHorizontal className="size-4" />
          {hidden} more
        </button>
      )}
    </div>
  )
}

type ToolItem = Extract<Item, { kind: 'tool' }>
type SubagentItem = Extract<Item, { kind: 'subagent' }>

/**
 * A `Task` sub-agent as its own row. While running it shows a live heartbeat —
 * the current child tool + a running count — so a multi-minute sub-agent reads
 * as active work, not a hang. When done it collapses to a summary + duration and
 * opens a drawer with everything it ran plus its final report.
 */
function SubagentRow({ sub, projectId }: { sub: SubagentItem; projectId?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const running = sub.status === 'running'
  const hasError = sub.status === 'error' || sub.tools.some((t) => t.status === 'error')
  const summary = summarizeGroup(sub.tools)
  const current = running ? sub.tools[sub.tools.length - 1] : undefined
  const currentTarget = current ? targetOf(current.input) : undefined
  const title = sub.subagentType ? `Sub-agent · ${sub.subagentType}` : 'Sub-agent'
  const dot = running ? 'bg-accent animate-pulse-dot' : hasError ? 'bg-del' : 'bg-add'
  const durationMs = sub.endTs !== undefined ? Math.max(0, sub.endTs - sub.ts) : undefined

  return (
    <>
      <button
        type="button"
        disabled={running}
        onClick={() => setOpen(true)}
        className="flex max-w-[85%] flex-col items-start gap-0.5 self-start rounded-xl border border-line bg-panel px-2.5 py-2 text-left text-xs disabled:cursor-default"
      >
        <span className="flex min-w-0 max-w-full items-center gap-1.5">
          <Bot className="size-3.5 shrink-0 text-muted" />
          <span className={running ? 'text-fg' : 'text-fg underline decoration-line underline-offset-2'}>{title}</span>
          <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
          {durationMs !== undefined && <span className="shrink-0 text-muted">{formatDuration(durationMs)}</span>}
        </span>
        {sub.description && <span className="pl-5 text-muted [overflow-wrap:anywhere]">{sub.description}</span>}
        {running ? (
          current ? (
            <span className="flex min-w-0 max-w-full items-center gap-1.5 pl-5 font-mono text-[11px] text-muted">
              <span className="shrink-0">{current.name}</span>
              <span className="truncate">{currentTarget ? relativePath(currentTarget, projectId) : (current.summary ?? '')}</span>
              {sub.tools.length > 1 && <span className="shrink-0 opacity-60">· {sub.tools.length}</span>}
            </span>
          ) : (
            <span className="pl-5 font-mono text-[11px] text-muted">starting…</span>
          )
        ) : (
          summary && <span className="pl-5 font-mono text-[11px] text-muted">{summary}</span>
        )}
      </button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            {sub.description && <DrawerDescription>{sub.description}</DrawerDescription>}
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] [&>*]:shrink-0">
            {sub.tools.map((t) => (
              <Row key={t.key} item={t} projectId={projectId} />
            ))}
            {sub.report && (
              <div className="mt-2 border-t border-line pt-3 [overflow-wrap:anywhere]">
                <Markdown text={sub.report} />
              </div>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}

/** A Bash call as an IN (command) / OUT (result) card — shown inside the
 *  "Worked" drawer. Approval-gated commands surface as the approval card instead. */
function BashCard({ item }: { item: ToolItem }): React.JSX.Element {
  const input = (item.input ?? {}) as { command?: unknown; description?: unknown }
  const command = typeof input.command === 'string' ? input.command : ''
  const description = typeof input.description === 'string' ? input.description : undefined
  const done = item.status !== 'running'

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={`size-1.5 shrink-0 rounded-full ${DOT[item.status]}`} />
        <span className="shrink-0 font-medium text-fg">Bash</span>
        {description && <span className="truncate text-muted">{description}</span>}
      </div>
      <CodeLine label="IN" text={command} copyable />
      {done && <CodeLine label="OUT" text={item.output || item.summary || '(no output)'} tone={item.status === 'error' ? 'error' : 'muted'} />}
    </div>
  )
}

/** One labeled, horizontally-scrollable code region of a BashCard. */
function CodeLine({
  label,
  text,
  copyable,
  tone = 'fg',
}: {
  label: string
  text: string
  copyable?: boolean
  tone?: 'fg' | 'muted' | 'error'
}): React.JSX.Element {
  const color = tone === 'error' ? 'text-del' : tone === 'muted' ? 'text-muted' : 'text-fg'
  return (
    <div className="flex items-start gap-2 border-t border-line px-3 py-2">
      <span className="mt-px w-7 shrink-0 select-none text-[10px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <pre className={`max-h-60 min-w-0 flex-1 overflow-auto whitespace-pre font-mono text-[11px] leading-[1.5] ${color}`}>{text}</pre>
      {copyable && <CopyButton text={text} />}
    </div>
  )
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-line"
      title="Copy"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check className="size-3.5 text-add" /> : <Copy className="size-3.5" />}
    </button>
  )
}

function Row({
  item,
  projectId,
  onViewFile,
}: {
  item: Item
  projectId?: string
  onViewFile?: (path: string) => void
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        // [overflow-wrap:anywhere] so an unbroken 200-char path cannot widen the
        // bubble past the viewport. `break-words` is not enough for a string with
        // no break opportunities at all.
        <div className="max-w-[85%] self-end whitespace-pre-wrap rounded-[14px] rounded-br-[4px] bg-accent px-3 py-2.5 text-[#06101f] [overflow-wrap:anywhere]">
          {item.images && item.images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {item.images.map((img) => (
                <img key={img.id} src={imageUrl(img.id)} alt="" className="size-24 rounded-lg object-cover" />
              ))}
            </div>
          )}
          {item.text}
        </div>
      )

    case 'assistant':
      return (
        <div className="px-0.5 py-1 [overflow-wrap:anywhere]">
          <Markdown text={item.text} />
        </div>
      )

    case 'todo':
      return <TodoRow todos={item.todos} />

    case 'subagent':
      return <SubagentRow sub={item} projectId={projectId} />

    case 'approval':
      return <ApprovalCard item={item} projectId={projectId} />

    case 'question':
      return <QuestionCard item={item} />

    // Bash gets a full IN/OUT card (inside the "Worked" drawer); other tools
    // stay one line, skimmable with a thumb. Not expandable JSON.
    case 'tool': {
      if (item.name === 'Bash') return <BashCard item={item} />
      const target = targetOf(item.input)
      return (
        <div className="flex min-w-0 items-center gap-2 px-0.5 py-1 text-xs text-muted">
          <span className={`size-1.5 shrink-0 rounded-full ${DOT[item.status]}`} />
          <span className="shrink-0 text-fg">{item.name}</span>
          <span className="truncate text-left font-mono">
            {target ? relativePath(target, projectId) : (item.summary ?? '')}
          </span>
        </div>
      )
    }

    case 'turn':
      // A subtle divider marks the turn boundary — no "DONE" label.
      return <div className="my-0.5 h-px w-16 self-center rounded-full bg-line" />

    case 'changes':
      return <ChangesView base={item.base} files={item.files} projectId={projectId} onViewFile={onViewFile} />

    case 'ended':
      // A clean finish is silent; only surface error/interrupted — those matter.
      if (item.reason === 'complete') return null
      return (
        <div className={`${SEPARATOR} text-warn`}>
          session {item.reason}
          {item.message && <span className="normal-case tracking-normal">{item.message}</span>}
        </div>
      )

    default:
      return null
  }
}
