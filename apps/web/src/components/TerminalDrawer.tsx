import { ChevronDown, RotateCw, X } from 'lucide-react'
import { useState } from 'react'
import { Terminal } from './Terminal.tsx'
import { PeekableDrawer } from './ui/peekable-drawer.tsx'

/** Peeked-strip height — shared with every other peekable drawer. */
export const TERMINAL_PEEK = '72px'

interface Props {
  projectId: string
  projectName: string
  open: boolean
  /** Full-height vs peeked-strip. Meaningless while `open` is false. */
  raised: boolean
  onRaisedChange: (raised: boolean) => void
  onOpenChange: (open: boolean) => void
  /** Other peeked drawers' combined peek height below this one in the stack, so peek strips don't overlap. */
  bottomOffset?: string
}

/**
 * The terminal in a peekable drawer (`PeekableDrawer`, shared with every other
 * drawer): lowering to the peek strip keeps the shell (WebSocket + PTY) alive —
 * `<Terminal>` stays mounted, only hidden via CSS — so a long-running command
 * survives while you go back to the thread. Only the × (or drag-dismiss) fully
 * closes it, which is what actually ends the shell. "Restart" remounts
 * `<Terminal>` for a fresh one.
 */
export function TerminalDrawer({ projectId, projectName, open, raised, onRaisedChange, onOpenChange, bottomOffset }: Props): React.JSX.Element {
  // Bumping this remounts <Terminal>, which tears down the old socket/PTY and opens a fresh one.
  const [sessionKey, setSessionKey] = useState(0)

  return (
    <PeekableDrawer
      open={open}
      raised={raised}
      onRaisedChange={onRaisedChange}
      onOpenChange={onOpenChange}
      peekHeight={TERMINAL_PEEK}
      bottomOffset={bottomOffset}
      title={`Terminal · ${projectName}`}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 pb-3">
        <button
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2"
          aria-label="Minimize"
          title="Minimize (keeps the shell running)"
          onClick={() => onRaisedChange(false)}
        >
          <ChevronDown className="size-5" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col items-center">
          <span className="text-[15px] font-semibold text-fg">Terminal</span>
          <span className="max-w-full truncate text-xs text-muted">{projectName}</span>
        </div>
        <button
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2"
          aria-label="Restart shell"
          title="Restart shell"
          onClick={() => setSessionKey((k) => k + 1)}
        >
          <RotateCw className="size-5" />
        </button>
        <button
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2"
          aria-label="Close"
          title="Close terminal (ends the shell)"
          onClick={() => onOpenChange(false)}
        >
          <X className="size-5" />
        </button>
      </div>

      <Terminal key={sessionKey} projectId={projectId} />
    </PeekableDrawer>
  )
}
