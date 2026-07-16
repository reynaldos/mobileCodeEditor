import { RotateCw, X } from 'lucide-react'
import { useState } from 'react'
import { Terminal } from './Terminal.tsx'
import { Drawer, DrawerContent } from './ui/drawer.tsx'

interface Props {
  projectId: string
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The terminal in a full-height drawer (Phase 4). Opening it connects a shell;
 * closing it ends that shell (the WebSocket drops and the server kills the PTY).
 * "Restart" remounts `Terminal` for a fresh shell — handy after you `exit` or a
 * command wedges. Lazy-loaded from App: xterm is heavy and most sessions never
 * open a terminal.
 */
export function TerminalDrawer({ projectId, projectName, open, onOpenChange }: Props): React.JSX.Element {
  // Bumping this remounts <Terminal>, which tears down the old socket/PTY and
  // opens a fresh one.
  const [sessionKey, setSessionKey] = useState(0)

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      {/* Don't let Radix pull focus to the close button on open — Terminal focuses
          the shell itself, so the cursor is live immediately. */}
      <DrawerContent className="h-[92vh] max-h-[92vh]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 pb-3">
          <button
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-5" />
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
        </div>

        <Terminal key={sessionKey} projectId={projectId} />
      </DrawerContent>
    </Drawer>
  )
}
