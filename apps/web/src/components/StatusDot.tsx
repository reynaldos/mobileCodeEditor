import { useRef, useState } from 'react'
import type { Connection } from '../useEventStream.ts'

/** Green once the SSE stream is live, flashing yellow while the initial
 *  connection is being established, flashing red while the browser is
 *  retrying a dropped connection. This is the transport's health, not
 *  whether the agent itself is thinking — see events.ts's `AgentState` for
 *  that (shown inline in the conversation, not in the header). */
const DOT_COLOR: Record<Connection, string> = {
  live: 'bg-add',
  connecting: 'bg-warn animate-pulse-dot',
  reconnecting: 'bg-del animate-pulse-dot',
}
const DOT_LABEL: Record<Connection, string> = {
  live: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
}

/**
 * The header's connection-status dot. No visible label sits next to it —
 * hover (or tap, since this is a touch-first app) pops a small card
 * underneath showing what the color means. Lives inside the "switch project"
 * button, so it's a `<span role="button">` rather than a real `<button>`
 * (nesting buttons is invalid HTML) and stops its click from bubbling into
 * the parent.
 */
export function StatusDot({ connection }: { connection: Connection }): React.JSX.Element {
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
        aria-label={DOT_LABEL[connection]}
        className={`size-2 shrink-0 rounded-full ${DOT_COLOR[connection]}`}
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
            {DOT_LABEL[connection]}
          </span>
        </>
      )}
    </span>
  )
}
