import { MoreVertical } from 'lucide-react'
import { useRef, useState } from 'react'

export interface MenuAction {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
}

/**
 * The top-nav's 4 actions (previous threads, new thread, env, preview),
 * collapsed behind a single kebab icon. Opens on hover (mouse) with a short
 * close delay so crossing the gap into the popup doesn't dismiss it, and also
 * toggles on tap — this is a touch-first app, and hover alone doesn't exist
 * on a phone.
 */
export function ActionsMenu({ actions }: { actions: MenuAction[] }): React.JSX.Element {
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
    <div className="relative flex items-center" onMouseEnter={() => { cancelClose(); setOpen(true) }} onMouseLeave={scheduleClose}>
      <button
        className="flex items-center text-muted"
        title="Actions"
        aria-label="Actions"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreVertical className="size-[18px]" />
      </button>

      {open && (
        <>
          {/* A transparent backdrop closes the popup on an outside tap. */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full z-40 mt-2 flex w-52 flex-col overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {actions.map((a) => (
              <button
                key={a.key}
                className="flex items-center gap-2.5 px-3 py-2 text-left text-[14px] text-fg hover:bg-panel-2"
                onClick={() => {
                  a.onClick()
                  setOpen(false)
                }}
              >
                <a.icon className="size-4 shrink-0 text-muted" />
                <span className="truncate">{a.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
