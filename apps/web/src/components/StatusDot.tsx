import { useRef, useState } from 'react'
import type { AgentState } from '../events.ts'

/** Green when ready, flashing yellow while the agent is working, red when
 *  it's blocked on you. `ended` reads as neutral — the session is over, not
 *  broken. */
const DOT_COLOR: Record<AgentState, string> = {
  idle: 'bg-add',
  awaiting_input: 'bg-add',
  thinking: 'bg-warn animate-pulse-dot',
  awaiting_approval: 'bg-del',
  ended: 'bg-muted',
}
const DOT_LABEL: Record<AgentState, string> = {
  idle: 'Ready',
  awaiting_input: 'Ready',
  thinking: 'Working…',
  awaiting_approval: 'Needs you',
  ended: 'Ended',
}

/**
 * The header's agent-status dot. No visible label sits next to it — hover (or
 * tap, since this is a touch-first app) pops a small card underneath showing
 * what the color means. Lives inside the "switch project" button, so it's a
 * `<span role="button">` rather than a real `<button>` (nesting buttons is
 * invalid HTML) and stops its click from bubbling into the parent.
 */
export function StatusDot({ agent }: { agent: AgentState }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current === null) return
    window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 200)
  }

  return (
    <span
      className="relative inline-flex shrink-0"
      onMouseEnter={(e) => {
        e.stopPropagation()
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label={DOT_LABEL[agent]}
        className={`size-2 shrink-0 rounded-full ${DOT_COLOR[agent]}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      />

      {open && (
        <>
          {/* A transparent backdrop closes the card on an outside tap. */}
          <span className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setOpen(false) }} />
          <span
            className="absolute left-1/2 top-full z-40 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-fg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {DOT_LABEL[agent]}
          </span>
        </>
      )}
    </span>
  )
}
