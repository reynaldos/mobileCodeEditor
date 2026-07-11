import type { Thread } from '@mce/protocol'
import { useState } from 'react'
import { createThread } from '../api.ts'

interface Props {
  projectId: string
  projectName: string
  threads: Thread[]
  activeThreadId: string | null
  onSelect: (threadId: string) => void
  /** Go back to the project picker. */
  onBack: () => void
  /** A thread was created; the parent should refresh + select it. */
  onCreated: (threadId: string) => void
}

/**
 * The threads of one project — the screen you land on after picking a project.
 * Newest first, with a "New thread" button. Tapping a thread continues it; the
 * legacy "Earlier conversation" is read-only.
 */
export function ThreadList({ projectId, projectName, threads, activeThreadId, onSelect, onBack, onCreated }: Props): React.JSX.Element {
  const [creating, setCreating] = useState(false)

  async function newThread(): Promise<void> {
    setCreating(true)
    try {
      onCreated(await createThread(projectId))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-bg/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-line px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top,0px))]">
        <button className="flex items-center gap-1 text-[13px] text-muted" onClick={onBack}>
          ‹ Projects
        </button>
        <span className="truncate font-semibold">{projectName}</span>
        <button
          className="h-8 rounded-lg border border-accent bg-accent px-3 text-[13px] font-semibold text-[#06101f] disabled:opacity-50"
          disabled={creating}
          onClick={() => void newThread()}
        >
          {creating ? '…' : 'New thread'}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <ul className="flex flex-col gap-2">
          {threads.map((t) => (
            <li key={t.id}>
              <button
                className={`w-full rounded-xl border p-3 text-left ${
                  t.id === activeThreadId ? 'border-accent bg-panel' : 'border-line bg-panel-2'
                }`}
                onClick={() => onSelect(t.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">
                    {t.legacy ? 'Earlier conversation' : t.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{when(t.lastActivity)}</span>
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  {t.messageCount} message{t.messageCount === 1 ? '' : 's'}
                  {t.legacy ? ' · read-only' : ''}
                </div>
              </button>
            </li>
          ))}
          {threads.length === 0 && (
            <li className="py-8 text-center text-muted">No threads yet. Start one with “New thread.”</li>
          )}
        </ul>
      </div>
    </div>
  )
}

function when(ms: number): string {
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}
