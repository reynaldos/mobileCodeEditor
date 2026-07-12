import { Check } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { imageUrl } from '../api.ts'
import { formatDuration, groupTools, type AgentState, type Item, type ToolGroup } from '../events.ts'
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
}

const DOT: Record<'running' | 'ok' | 'error', string> = {
  running: 'bg-accent animate-pulse-dot',
  ok: 'bg-add',
  error: 'bg-del',
}

const SEPARATOR = 'flex justify-center gap-2 py-1 text-[11px] uppercase tracking-[0.08em] text-muted'

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

export function MessageList({ items, projectId, agent }: Props): React.JSX.Element {
  const bottom = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => groupTools(items, agent === 'thinking'), [items, agent])

  const pendingKey = items.find(
    (i) => (i.kind === 'approval' || i.kind === 'question') && i.status === 'pending',
  )?.key

  useEffect(() => {
    // A pending approval blocks the agent, so it must never sit below the fold.
    // Jump instantly rather than animating — a smooth scroll started during a
    // long assistant message lands short, and the card ends up unreachable.
    bottom.current?.scrollIntoView({ behavior: pendingKey ? 'auto' : 'smooth', block: 'end' })
  }, [items.length, pendingKey])

  return (
    // `messages` carries the flex-shrink guard in styles.css. Do not rename it.
    <div className="messages flex flex-1 flex-col gap-2.5 overflow-y-auto p-3.5">
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
          <Row key={row.key} item={row} projectId={projectId} />
        ),
      )}
      <div ref={bottom} />
    </div>
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
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
            {group.tools.map((t) => (
              <Row key={t.key} item={t} projectId={projectId} />
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}

interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

function parseTodos(input: unknown): Todo[] {
  if (!input || typeof input !== 'object') return []
  const todos = (input as Record<string, unknown>).todos
  return Array.isArray(todos) ? (todos as Todo[]) : []
}

/** TodoWrite calls render as a checklist card, not a one-line chip. */
function TodoRow({ todos }: { todos: Todo[] }): React.JSX.Element {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between px-3 py-2 text-[13px] font-medium">
        <span>To-dos</span>
        <span className="text-muted">
          {done}/{todos.length}
        </span>
      </div>
      <ul>
        {todos.map((t, i) => (
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
    </div>
  )
}

function Row({ item, projectId }: { item: Item; projectId?: string }): React.JSX.Element | null {
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
        <div className="rounded-[14px] rounded-bl-[4px] border border-line bg-panel px-3 py-2.5 [overflow-wrap:anywhere]">
          <Markdown text={item.text} />
        </div>
      )

    case 'approval':
      return <ApprovalCard item={item} projectId={projectId} />

    case 'question':
      return <QuestionCard item={item} />

    // One line, skimmable with a thumb. Not expandable JSON.
    case 'tool': {
      if (item.name === 'TodoWrite') {
        const todos = parseTodos(item.input)
        if (todos.length > 0) return <TodoRow todos={todos} />
      }
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
      return <div className={SEPARATOR}>done</div>

    case 'changes':
      return <ChangesView base={item.base} files={item.files} projectId={projectId} />

    case 'ended':
      return (
        <div className={`${SEPARATOR} ${item.reason === 'complete' ? '' : 'text-warn'}`}>
          session {item.reason}
          {item.message && <span className="normal-case tracking-normal">{item.message}</span>}
        </div>
      )

    default:
      return null
  }
}
