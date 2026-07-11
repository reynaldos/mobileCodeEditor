import type { Thread } from '@mce/protocol'
import { ChevronLeft } from 'lucide-react'

interface Props {
  projectName: string
  threads: Thread[]
  activeThreadId: string | null
  onSelect: (threadId: string) => void
  /** Start a fresh thread. */
  onNew: () => void
  /** Go back to the project picker. */
  onBack: () => void
}

/**
 * Previous threads for a project — reached via the history icon. Newest first,
 * tap to switch. The legacy "previous conversation" bucket is read-only (you view
 * it, then start a new thread to continue).
 */
export function ThreadList({ projectName, threads, activeThreadId, onSelect, onNew, onBack }: Props): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-bg/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-line px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top,0px))]">
        <button className="flex items-center gap-0.5 text-[13px] text-muted" onClick={onBack}>
          <ChevronLeft className="size-4" />
          Projects
        </button>
        <span className="truncate font-semibold">{projectName}</span>
        <button
          className="h-8 rounded-lg border border-accent bg-accent px-3 text-[13px] font-semibold text-[#06101f]"
          onClick={onNew}
        >
          New thread
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
                  <span className="truncate font-medium">{t.title}</span>
                  <span className="shrink-0 text-[11px] text-muted">
                    {t.legacy ? 'read-only' : when(t.lastActivity)}
                  </span>
                </div>
              </button>
            </li>
          ))}
          {threads.length === 0 && (
            <li className="py-8 text-center text-muted">No previous threads yet.</li>
          )}
        </ul>
      </div>
    </div>
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
