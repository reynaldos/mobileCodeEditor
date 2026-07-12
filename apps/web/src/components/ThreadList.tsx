import type { Thread } from '@mce/protocol'
import { Check, Pencil, Search, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

interface Props {
  threads: Thread[]
  activeThreadId: string | null
  /** Thread ids the agent is actively working in right now — drives the flashing dot. */
  workingThreadIds: Set<string>
  onSelect: (threadId: string) => void
  onRename: (threadId: string, title: string) => void
  onDelete: (threadId: string) => void
  /** Dismiss the popup (tap outside, or after picking). */
  onClose: () => void
}

/**
 * The history popup: a searchable, scrollable list of a project's threads,
 * anchored under the top-nav history icon. Tap a row to switch to it; hover (or,
 * on touch, just look) reveals rename and delete. The legacy "earlier
 * conversation" bucket is read-only — you can open it, not edit it.
 */
export function ThreadList({
  threads,
  activeThreadId,
  workingThreadIds,
  onSelect,
  onRename,
  onDelete,
  onClose,
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return threads
    return threads.filter((t) => t.title.toLowerCase().includes(q))
  }, [threads, query])

  return (
    // A transparent backdrop closes the popup; the card floats under the nav.
    <div className="fixed inset-0 z-30" onClick={onClose}>
      <div
        className="absolute right-2 top-[calc(52px+env(safe-area-inset-top,0px))] flex max-h-[70vh] w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-muted"
            value={query}
            placeholder="Search sessions…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <ul className="flex flex-col gap-1 overflow-y-auto p-1.5">
          {filtered.map((t) => (
            <Row
              key={t.id}
              thread={t}
              active={t.id === activeThreadId}
              working={workingThreadIds.has(t.id)}
              onSelect={() => onSelect(t.id)}
              onRename={(title) => onRename(t.id, title)}
              onDelete={() => onDelete(t.id)}
            />
          ))}
          {filtered.length === 0 && (
            <li className="px-2 py-6 text-center text-[13px] text-muted">
              {threads.length === 0 ? 'No threads yet.' : 'No matches.'}
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}

type RowMode = 'idle' | 'editing' | 'confirm-delete'

function Row({
  thread,
  active,
  working,
  onSelect,
  onRename,
  onDelete,
}: {
  thread: Thread
  active: boolean
  working: boolean
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
    <li
      className={`group flex items-center rounded-lg ${active ? 'bg-panel-2' : 'hover:bg-panel-2'}`}
    >
      <button className="min-w-0 flex-1 px-2 py-2 text-left" onClick={onSelect}>
        <span className="flex min-w-0 items-center gap-1.5">
          {working && (
            <span className="size-1.5 shrink-0 rounded-full bg-accent animate-pulse-dot" title="Working…" />
          )}
          <span className={`truncate text-[14px] ${active ? 'font-medium text-fg' : 'text-fg'}`}>{thread.title}</span>
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

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      className="flex size-7 items-center justify-center rounded-md hover:bg-line"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
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
