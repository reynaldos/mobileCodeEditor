import type { Thread } from '@mce/protocol'
import { Check, Pencil, Search, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ThreadStatus } from '../events.ts'
import { PromptBox } from './PromptBox.tsx'

interface Props {
  projectId: string
  threads: Thread[]
  /** True only for the initial fetch after picking this project — see useThreads.ts. */
  loading: boolean
  statusOf: (threadId: string) => ThreadStatus
  onSelect: (threadId: string) => void
  onRename: (threadId: string, title: string) => void
  onDelete: (threadId: string) => void
  /** The bottom prompt bar minted a real thread by sending a first message — switch into it. */
  onStarted: (threadId: string) => void
}

/**
 * A project's home screen: every thread it has, newest first and grouped by
 * how recent, plus a prompt bar at the bottom that starts a brand-new one.
 * This is what you land on after picking a project that already has
 * conversations — a project with none skips straight past this into a fresh
 * thread (App.tsx), so `threads` here is never empty except mid-load.
 */
export function ThreadsHome({
  projectId,
  threads,
  loading,
  statusOf,
  onSelect,
  onRename,
  onDelete,
  onStarted,
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  // Stable for the life of this screen: minted once, handed to the bottom
  // prompt bar so it always has a real thread id to send against. Sending
  // through it is what turns this draft into an actual thread server-side.
  const [draftThreadId, setDraftThreadId] = useState(() => crypto.randomUUID())

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matching = q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads
    return groupByRecency(matching)
  }, [threads, query])

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-2">
        <div className="mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-muted"
            value={query}
            placeholder="Search threads…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {loading ? (
          <p className="m-auto text-center text-[13px] text-muted">Loading threads…</p>
        ) : groups.length === 0 ? (
          <p className="m-auto text-center text-[13px] text-muted">{threads.length === 0 ? 'No threads yet.' : 'No matches.'}</p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-3">
              <h3 className="mb-1 px-1 text-[12px] font-medium text-muted">{g.label}</h3>
              <ul className="flex flex-col gap-1">
                {g.threads.map((t) => (
                  <Row
                    key={t.id}
                    thread={t}
                    status={statusOf(t.id)}
                    onSelect={() => onSelect(t.id)}
                    onRename={(title) => onRename(t.id, title)}
                    onDelete={() => onDelete(t.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      <PromptBox
        projectId={projectId}
        threadId={draftThreadId}
        onSubmitted={() => {
          onStarted(draftThreadId)
          setDraftThreadId(crypto.randomUUID())
        }}
      />
    </>
  )
}

const STATUS_DOT: Record<ThreadStatus, string> = {
  active: 'bg-accent animate-pulse-dot',
  'needs-action': 'bg-warn',
  inactive: 'bg-muted',
}
const STATUS_LABEL: Record<ThreadStatus, string> = {
  active: 'Working…',
  'needs-action': 'Needs you',
  inactive: 'Inactive',
}

type RowMode = 'idle' | 'editing' | 'confirm-delete'

function Row({
  thread,
  status,
  onSelect,
  onRename,
  onDelete,
}: {
  thread: Thread
  status: ThreadStatus
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<RowMode>('idle')
  const [draft, setDraft] = useState(thread.title)

  function commitRename(): void {
    const next = draft.trim()
    if (next && next !== thread.title) onRename(next)
    setMode('idle')
  }

  if (mode === 'editing') {
    return (
      <li className="flex items-center gap-1 rounded-lg bg-panel-2 px-2 py-1.5">
        <input
          autoFocus
          className="min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setMode('idle')
          }}
        />
        <IconBtn label="Save" onClick={commitRename}>
          <Check className="size-4 text-add" />
        </IconBtn>
        <IconBtn label="Cancel" onClick={() => setMode('idle')}>
          <X className="size-4 text-muted" />
        </IconBtn>
      </li>
    )
  }

  return (
    <li className="group flex items-center rounded-lg hover:bg-panel-2">
      <button className="min-w-0 flex-1 px-2 py-2.5 text-left" onClick={onSelect}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} title={STATUS_LABEL[status]} />
          <span className="truncate text-[14px] text-fg">{thread.title}</span>
        </span>
        <span className="block text-[11px] text-muted">{thread.legacy ? 'read-only' : when(thread.lastActivity)}</span>
      </button>

      {thread.legacy ? null : mode === 'confirm-delete' ? (
        <span className="flex shrink-0 items-center gap-1 pr-1.5">
          <span className="text-[11px] text-del">Delete?</span>
          <IconBtn label="Confirm delete" onClick={onDelete}>
            <Check className="size-4 text-del" />
          </IconBtn>
          <IconBtn label="Cancel" onClick={() => setMode('idle')}>
            <X className="size-4 text-muted" />
          </IconBtn>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-0.5 pr-1.5 opacity-60 transition-opacity group-hover:opacity-100">
          <IconBtn
            label="Rename"
            onClick={() => {
              setDraft(thread.title)
              setMode('editing')
            }}
          >
            <Pencil className="size-4 text-muted" />
          </IconBtn>
          <IconBtn label="Delete" onClick={() => setMode('confirm-delete')}>
            <Trash2 className="size-4 text-muted" />
          </IconBtn>
        </span>
      )}
    </li>
  )
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button className="flex size-7 items-center justify-center rounded-md hover:bg-line" title={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  )
}

function when(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

/** Threads arrive newest-first from the server; this only buckets them, it
 *  never reorders within a bucket. The legacy "earlier conversation" bucket
 *  always lands in Earlier regardless of its (synthetic) timestamp. */
function groupByRecency(threads: Thread[]): { label: string; threads: Thread[] }[] {
  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  const today: Thread[] = []
  const thisWeek: Thread[] = []
  const earlier: Thread[] = []

  for (const t of threads) {
    const age = now - t.lastActivity
    if (t.legacy) earlier.push(t)
    else if (age < day) today.push(t)
    else if (age < 7 * day) thisWeek.push(t)
    else earlier.push(t)
  }

  return [
    { label: 'Today', threads: today },
    { label: 'This Week', threads: thisWeek },
    { label: 'Earlier', threads: earlier },
  ].filter((g) => g.threads.length > 0)
}
