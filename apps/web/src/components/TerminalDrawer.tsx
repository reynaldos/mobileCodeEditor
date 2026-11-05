import { RotateCw } from 'lucide-react'
import { useState } from 'react'
import type { DrawerState } from '../useDrawerState.ts'
import { PeekDrawer } from './PeekDrawer.tsx'
import { Terminal } from './Terminal.tsx'

interface Props {
  projectId: string
  projectName: string
  drawer: DrawerState
  /** Strip position while minimized (see `peekSlots`). */
  slot: number
}

/**
 * The terminal in a minimizable drawer (Phase 4). Opening it connects a shell;
 * minimizing keeps that shell alive (the socket stays up, output keeps
 * streaming); closing it ends the shell (the WebSocket drops and the server
 * kills the PTY).
 * "Restart" remounts `Terminal` for a fresh shell — handy after you `exit` or a
 * command wedges. Lazy-loaded from App: xterm is heavy and most sessions never
 * open a terminal.
 */
export function TerminalDrawer({ projectId, projectName, drawer, slot }: Props): React.JSX.Element {
  // Bumping this remounts <Terminal>, which tears down the old socket/PTY and
  // opens a fresh one.
  const [sessionKey, setSessionKey] = useState(0)

  return (
    <PeekDrawer
      open={drawer.open}
      raised={drawer.raised}
      slot={slot}
      onRaise={drawer.raise}
      onPeek={drawer.peek}
      onClose={drawer.close}
      title={
        <>
          Terminal <span className="font-normal text-muted">· {projectName}</span>
        </>
      }
      actions={
        <button
          className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-line"
          aria-label="Restart shell"
          title="Restart shell"
          onClick={() => setSessionKey((k) => k + 1)}
        >
          <RotateCw className="size-4" />
        </button>
      }
      closeLabel="Close terminal"
      closeTitle="Close terminal (ends the shell)"
      // Don't let Radix pull focus to the close button on open — Terminal focuses
      // the shell itself, so the cursor is live immediately.
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <Terminal key={sessionKey} projectId={projectId} />
    </PeekDrawer>
  )
}
