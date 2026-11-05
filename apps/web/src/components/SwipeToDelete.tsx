import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'

/** Width of the revealed action, in px. A full swipe past twice this fires the action directly. */
const ACTION_WIDTH = 88
/** Movement before a pointer is treated as a drag rather than a tap. */
const DRAG_SLOP = 8

/**
 * iOS-style swipe-to-delete for a list row. Drag left to reveal a red action;
 * release past the midpoint to leave it open, tap it to fire `onDelete`. A long
 * swipe (past twice the action width) fires `onDelete` straight away.
 *
 * `onDelete` is expected to open a confirm step, not delete — the gesture is
 * easy to trigger by accident on a phone, so the caller must still ask.
 *
 * Pointer events, not touch events, so a mouse drag works too. `touch-action:
 * pan-y` leaves vertical scrolling to the browser; we only claim the pointer
 * once the movement is clearly horizontal, so the list still scrolls normally.
 */
export function SwipeToDelete({
  label,
  onDelete,
  className,
  children,
}: {
  /** Accessible name for the revealed action, e.g. "Remove my-app". */
  label: string
  onDelete: () => void
  /** Classes for the sliding content layer. It needs an opaque background to cover the action. */
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [x, setX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number; from: number } | null>(null)
  // Set once a pointer became a drag, so the click the browser fires on release
  // doesn't also select the row underneath.
  const dragged = useRef(false)
  // Whether horizontal movement has been established for this pointer ('pending' until decided).
  const axis = useRef<'pending' | 'x' | 'y'>('pending')

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    start.current = { x: event.clientX, y: event.clientY, from: x }
    axis.current = 'pending'
    dragged.current = false
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const s = start.current
    if (!s) return
    const dx = event.clientX - s.x
    const dy = event.clientY - s.y
    if (axis.current === 'pending') {
      if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (axis.current === 'x') {
        event.currentTarget.setPointerCapture(event.pointerId)
        dragged.current = true
        setDragging(true)
      }
    }
    if (axis.current !== 'x') return
    // Only leftward travel reveals anything; a little overshoot past the action is fine.
    setX(Math.max(-ACTION_WIDTH * 2.2, Math.min(0, s.from + dx)))
  }

  function onPointerEnd(event: React.PointerEvent<HTMLDivElement>): void {
    const s = start.current
    start.current = null
    if (!s || axis.current !== 'x') return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(false)
    if (x <= -ACTION_WIDTH * 2) {
      setX(0)
      onDelete()
      return
    }
    setX(x < -ACTION_WIDTH / 2 ? -ACTION_WIDTH : 0)
  }

  function suppressClickAfterDrag(event: React.MouseEvent): void {
    if (!dragged.current) return
    dragged.current = false
    event.preventDefault()
    event.stopPropagation()
    // A tap on an open row (no drag) closes it instead of selecting; a drag
    // that released closed has nothing more to do.
  }

  const open = x <= -ACTION_WIDTH / 2

  return (
    <div
      className="relative overflow-hidden"
      style={{ touchAction: 'pan-y' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <button
        type="button"
        aria-label={label}
        tabIndex={open ? 0 : -1}
        className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-0.5 bg-del text-[12px] font-semibold text-bg"
        style={{ width: ACTION_WIDTH }}
        onClick={() => {
          setX(0)
          onDelete()
        }}
      >
        <Trash2 className="size-4" />
        Remove
      </button>
      <div
        className={`relative ${className ?? ''}`}
        style={{ transform: `translateX(${x}px)`, transition: dragging ? 'none' : 'transform 160ms ease-out' }}
        onClickCapture={(event) => {
          if (open && !dragged.current) {
            // Tapping the content while the action is showing just slides it shut.
            event.preventDefault()
            event.stopPropagation()
            setX(0)
            return
          }
          suppressClickAfterDrag(event)
        }}
      >
        {children}
      </div>
    </div>
  )
}
