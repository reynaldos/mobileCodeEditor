import { ChevronUp, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Drawer as Vaul } from 'vaul'

/** Full: nearly the whole viewport, for every peekable drawer. */
const FULL = 0.92

interface Props {
  open: boolean
  /** Full-height vs peeked-strip. Meaningless while `open` is false. */
  raised: boolean
  onRaisedChange: (raised: boolean) => void
  onOpenChange: (open: boolean) => void
  /** Peeked-strip height, e.g. '72px'. */
  peekHeight: string
  /** How far above the very bottom the peek strip sits — the sum of any other
   *  peeked drawers' own peek heights below it in the stack, so strips don't
   *  overlap when more than one is peeked at once. Defaults to flush with the bottom. */
  bottomOffset?: string
  /** Shown in the peeked strip, next to the raise control. */
  title: React.ReactNode
  /** The drawer's own full header + body, shown only while raised — build your
   *  own close/back controls in here; peeking is handled by the strip above. */
  children: React.ReactNode
}

/**
 * Shared peek/raise mechanics for a bottom drawer, factored out of
 * `PreviewDrawer` (the original) once `TerminalDrawer` needed the identical
 * behavior: a non-modal Vaul sheet with two snap points, where lowering to the
 * peek strip keeps whatever's inside alive (mounted, only CSS-hidden) instead
 * of tearing it down — the whole point being that a live process (dev server,
 * shell) or in-progress state (open editor tabs, a form) survives a peek.
 *
 * The peeked strip itself is generic (title + raise chevron + close); the
 * raised view is entirely up to the caller via `children`, which is why an
 * explicit `title` prop exists separately — the caller's own header (shown
 * only while raised) usually has a richer title of its own.
 */
export function PeekableDrawer({
  open,
  raised,
  onRaisedChange,
  onOpenChange,
  peekHeight,
  bottomOffset = '0px',
  title,
  children,
}: Props): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)

  // While peeked, undo two Vaul "modal" behaviors that make whatever's behind
  // the drawer unusable. Both are correct while RAISED (the drawer covers the
  // screen), so this only runs when lowered to the peek strip.
  //  1) Vaul locks `body { pointer-events: none }` — nothing behind it is clickable.
  //  2) Vaul's Radix focus scope is `trapped`, so focus is yanked back to the drawer
  //     the instant you focus something behind it — you can click it (I-beam shows)
  //     but can't type. Headless browsers skip that refocus, which is why it only
  //     shows in a real browser.
  useEffect(() => {
    if (!open || raised) return
    const body = document.body

    const unlock = (): void => {
      if (body.style.pointerEvents === 'none') body.style.pointerEvents = 'auto'
    }
    unlock()
    const styleObserver = new MutationObserver(unlock)
    styleObserver.observe(body, { attributes: true, attributeFilter: ['style'] })

    const stopSteal = (e: FocusEvent): void => {
      const content = contentRef.current
      if (!content) return
      const to = e.type === 'focusout' ? (e.relatedTarget as Node | null) : (e.target as Node | null)
      if (to && !content.contains(to)) e.stopImmediatePropagation()
    }
    document.addEventListener('focusin', stopSteal, true)
    document.addEventListener('focusout', stopSteal, true)

    return () => {
      styleObserver.disconnect()
      document.removeEventListener('focusin', stopSteal, true)
      document.removeEventListener('focusout', stopSteal, true)
    }
  }, [open, raised])

  return (
    <Vaul.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onOpenChange(false)
      }}
      modal={false}
      snapPoints={[peekHeight, FULL]}
      activeSnapPoint={raised ? FULL : peekHeight}
      setActiveSnapPoint={(snap) => onRaisedChange(snap === FULL)}
    >
      <Vaul.Portal>
        <Vaul.Content
          ref={contentRef}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={`fixed inset-x-0 z-40 flex h-full flex-col rounded-t-2xl border-t border-line bg-panel shadow-2xl outline-none ${
            raised ? '' : 'pointer-events-none'
          }`}
          style={{ bottom: raised ? '0px' : bottomOffset }}
        >
          <div className="pointer-events-auto mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-line" />

          {/* The peeked strip — always in the tree (never unmounted), just hidden
              while raised, so toggling never costs the caller's mounted state. */}
          <div className={raised ? 'hidden' : 'pointer-events-auto flex flex-1 items-center justify-between gap-2 px-4 py-2.5'}>
            <button
              className="flex min-w-0 items-center gap-2 text-left"
              onClick={() => onRaisedChange(true)}
              aria-label="Raise"
            >
              <ChevronUp className="size-4 shrink-0 text-muted" />
              <span className="truncate text-[14px] font-medium text-fg">{title}</span>
            </button>
            <button
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-line"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Never unmounted by peek/raise — only hidden — so whatever's inside survives. */}
          <div className={raised ? 'pointer-events-auto flex min-h-0 flex-1 flex-col' : 'hidden'}>{children}</div>
        </Vaul.Content>
      </Vaul.Portal>
    </Vaul.Root>
  )
}
