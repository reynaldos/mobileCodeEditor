import { Check, Loader, Terminal, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cancelBuild } from '../api.ts'
import { useBuildStream } from '../useBuildStream.ts'

interface Props {
  projectId: string
  projectName: string
  /** Ready → enter the thread. */
  onOpen: () => void
  /** Failed/cancelled → back to the project picker. */
  onBack: () => void
}

/**
 * Blocks the thread while a project sets up (clone → install), so it never looks
 * hung. Shows a live phase, an expandable terminal of the raw output, and Cancel.
 * On success it waits on an Open button; on failure, a way back.
 */
export function BuildModal({ projectId, projectName, onOpen, onBack }: Props): React.JSX.Element {
  const { phase, lines, error, warning } = useBuildStream(projectId)
  const [showTerminal, setShowTerminal] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const term = useRef<HTMLDivElement>(null)

  const active = phase === 'cloning' || phase === 'installing'

  // Keep the terminal pinned to the newest line.
  useEffect(() => {
    if (showTerminal) term.current?.scrollTo({ top: term.current.scrollHeight })
  }, [lines, showTerminal])

  // A cancelled build removed the project — there's nothing to stay for.
  useEffect(() => {
    if (phase === 'cancelled') onBack()
  }, [phase, onBack])

  async function cancel(): Promise<void> {
    setCancelling(true)
    await cancelBuild(projectId).catch(() => undefined)
  }

  const label =
    phase === 'cloning'
      ? 'Cloning repository…'
      : phase === 'installing'
        ? 'Installing dependencies…'
        : phase === 'ready'
          ? 'Ready'
          : phase === 'error'
            ? 'Setup failed'
            : 'Cancelling…'

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg px-4">
      <div className="m-auto flex max-h-full w-[min(460px,calc(100vw-24px))] flex-col rounded-2xl border border-line bg-panel p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-panel-2">
            {active ? (
              <Loader className="size-5 animate-spin text-accent" />
            ) : phase === 'ready' ? (
              <Check className="size-5 text-add" />
            ) : (
              <TriangleAlert className="size-5 text-del" />
            )}
          </span>
          <div className="min-w-0">
            <div className="truncate font-semibold text-fg">{projectName}</div>
            <div className="text-[13px] text-muted">{label}</div>
          </div>
        </div>

        {active && (
          <div className="mt-4 h-1 overflow-hidden rounded-full bg-panel-2">
            <div className="h-full w-1/3 rounded-full bg-accent animate-indeterminate" />
          </div>
        )}

        {phase === 'ready' && warning && <p className="mt-3 text-[13px] text-warn">{warning}</p>}
        {phase === 'error' && error && <p className="mt-3 text-[13px] text-del">{error}</p>}

        <button
          className="mt-4 flex items-center gap-1.5 self-start text-[13px] text-muted hover:text-fg"
          onClick={() => setShowTerminal((s) => !s)}
        >
          <Terminal className="size-4" />
          {showTerminal ? 'Hide terminal' : 'Show terminal'}
        </button>

        {showTerminal && (
          <div
            ref={term}
            className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted"
          >
            {lines.length === 0 ? (
              <span className="opacity-50">waiting for output…</span>
            ) : (
              lines.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">
                  {line}
                </div>
              ))
            )}
          </div>
        )}

        <div className="mt-5 flex shrink-0 gap-2">
          {active && (
            <button
              className="min-h-11 flex-1 rounded-xl border border-line bg-panel-2 text-[14px] font-medium text-fg disabled:opacity-50"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {phase === 'ready' && (
            <button
              className="min-h-11 flex-1 rounded-xl border border-accent bg-accent text-[14px] font-semibold text-[#06101f]"
              onClick={onOpen}
            >
              Open project
            </button>
          )}
          {phase === 'error' && (
            <button
              className="min-h-11 flex-1 rounded-xl border border-line bg-panel-2 text-[14px] font-medium text-fg"
              onClick={onBack}
            >
              Back to projects
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
