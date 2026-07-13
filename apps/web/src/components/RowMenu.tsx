import { MoreVertical } from 'lucide-react'
import { useRef, useState } from 'react'

export interface RowMenuAction {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  /** Renders in the delete/destructive color. */
  destructive?: boolean
  onClick: () => void
}

interface Coords {
  right: number
  top?: number
  bottom?: number
}

/**
 * A per-row kebab: one vertical-dots button that opens a small popup of actions.
 * Tap toggles it (touch-first, so no hover-to-open), an outside tap dismisses it.
 *
 * The popup is `fixed` and measured from the trigger on open, so it never gets
 * clipped by a scrolling list and flips above the button when a bottom row
 * wouldn't leave room below.
 */
export function RowMenu({ actions, label = 'Actions' }: { actions: RowMenuAction[]; label?: string }): React.JSX.Element {
  const [pos, setPos] = useState<Coords | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  function toggle(): void {
    if (pos) {
      setPos(null)
      return
    }
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const estHeight = actions.length * 44 + 8
    const below = window.innerHeight - r.bottom
    const openUp = below < estHeight + 12 && r.top > below
    setPos({
      right: Math.max(8, window.innerWidth - r.right),
      ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    })
  }

  return (
    <>
      <button
        ref={btnRef}
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted opacity-60 transition-opacity hover:bg-panel-2 group-hover:opacity-100"
        title={label}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={pos !== null}
        onClick={toggle}
      >
        <MoreVertical className="size-[18px]" />
      </button>

      {pos && (
        <>
          {/* A full-screen backdrop closes the menu on an outside tap (and locks the list from scrolling out from under it). */}
          <div className="fixed inset-0 z-40" onClick={() => setPos(null)} />
          <div
            className="fixed z-50 flex w-44 flex-col overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-2xl"
            style={{ right: pos.right, top: pos.top, bottom: pos.bottom }}
            onClick={(e) => e.stopPropagation()}
          >
            {actions.map((a) => (
              <button
                key={a.key}
                className={`flex items-center gap-2.5 px-3 py-2.5 text-left text-[14px] hover:bg-panel-2 ${
                  a.destructive ? 'text-del' : 'text-fg'
                }`}
                onClick={() => {
                  a.onClick()
                  setPos(null)
                }}
              >
                <a.icon className={`size-4 shrink-0 ${a.destructive ? 'text-del' : 'text-muted'}`} />
                <span className="truncate">{a.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}
