import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Drawer as Vaul } from 'vaul'
import { FULL, peekSnap } from '../peek.ts'

interface Props {
  open: boolean
  /** Full-height vs minimized to a bottom strip. Meaningless while closed. */
  raised: boolean
  /** Strip position from `peekSlots` — which other strips this one stacks on. */
  slot: number
  onRaise: () => void
  onPeek: () => void
  /** Full close: drag-dismiss, Escape, or the strip's ×. The drawer decides what that tears down. */
  onClose: () => void
  title: React.ReactNode
  /** Rendered before the raise/minimize button — the Explorer's back arrow. */
  leading?: React.ReactNode
  /** Rendered between the title and the × — a kebab, a restart button. */
  actions?: React.ReactNode
  closeLabel: string
  closeTitle?: string
  onOpenAutoFocus?: (e: Event) => void
  /** Everything under the header. Never unmounted by minimize/raise — only hidden. */
  children: React.ReactNode
}

/**
 * A drawer that minimizes instead of only closing (the preview's original peek
 * logic, shared by every drawer): a persistent body plus a strip with the
 * grabber, a raise/minimize toggle, optional actions and a ×. Lowering it keeps
 * the body mounted (a shell, an iframe, open tabs, unsaved edits all survive)
 * and hides it via CSS; only a full close tears it down.
 *
 * Non-modal (no backdrop): minimizing is meant to let you keep using the
 * thread underneath. Several can be minimized at once — the strips stack in
 * the order `peekSlots` gives, and `.app` pads its bottom by their total.
 */
export function PeekDrawer({
  open,
  raised,
  slot,
  onRaise,
  onPeek,
  onClose,
  title,
  leading,
  actions,
  closeLabel,
  closeTitle,
  onOpenAutoFocus,
  children,
}: Props): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const peekPoint = peekSnap(slot)
  // Stable identity: Vaul recomputes its offsets whenever this array changes.
  const snapPoints = useMemo(() => [peekPoint, FULL], [peekPoint])

  // While minimized, undo two Vaul "modal" behaviors that make the thread behind the
  // drawer unusable. Both are correct while RAISED (the drawer covers the screen),
  // so this only runs when lowered to the strip.
  //  1) Vaul locks `body { pointer-events: none }` — nothing behind it is clickable.
  //  2) Vaul's Radix focus scope is `trapped`, so focus is yanked back to the drawer
  //     the instant you focus a thread input — you can click it (I-beam shows) but
  //     can't type. Headless browsers skip that refocus, which is why it only shows
  //     in a real browser.
  useEffect(() => {
    if (!open || raised) return
    const body = document.body

    // (1) keep the body interactive; re-assert since Vaul rewrites the style on snap/drag.
    const unlock = (): void => {
      if (body.style.pointerEvents === 'none') body.style.pointerEvents = 'auto'
    }
    unlock()
    const styleObserver = new MutationObserver(unlock)
    styleObserver.observe(body, { attributes: true, attributeFilter: ['style'] })

    // (2) stop the focus-scope steal: swallow focus events, before Radix's document
    // handlers, whenever focus moves to something OUTSIDE the drawer. Focus into the
    // drawer's own controls (inside `contentRef`) is left alone.
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
        if (!o) onClose()
      }}
      modal={false}
      snapPoints={snapPoints}
      activeSnapPoint={raised ? FULL : peekPoint}
      setActiveSnapPoint={(snap) => (snap === FULL ? onRaise() : onPeek())}
    >
      <Vaul.Portal>
        {/* The content is full-height and translated down to the strip, so when
            minimized its off-strip area still overlaps the thread (and any strips
            stacked below it). `modal=false` means no backdrop, but the element itself
            would swallow taps and paint over the lower strips — kill its pointer
            events and background when minimized and re-enable only the strip.
            Pointer events go in an inline style, not a class: Radix's dismissable
            layer writes its own inline `pointer-events` (auto on the newest open
            layer, none on the rest), which would override a class and leave a raised
            drawer that was opened before another one untappable. Inline wins over it.
            Raised, the bottom 5% sits below the screen (Vaul translates by that
            much at the FULL snap), so pad it back in. */}
        <Vaul.Content
          ref={contentRef}
          onOpenAutoFocus={onOpenAutoFocus}
          style={{ pointerEvents: raised ? 'auto' : 'none' }}
          className={`fixed inset-x-0 bottom-0 flex h-full flex-col outline-none ${
            raised ? 'z-50 rounded-t-2xl bg-panel pb-[calc(var(--app-height)*0.05)] shadow-2xl' : 'z-40'
          }`}
        >
          {/* 72px = PEEK_PX; the strip is exactly one snap step tall. */}
          <div
            className={`pointer-events-auto flex h-[72px] shrink-0 flex-col rounded-t-2xl border-t border-line bg-panel ${
              raised ? '' : 'shadow-2xl'
            }`}
          >
            <div className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-line" />

            <div className="flex min-h-0 flex-1 items-center justify-between gap-2 px-4">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {leading}
                <button
                  className="flex min-w-0 items-center gap-2 text-left"
                  onClick={raised ? onPeek : onRaise}
                  aria-label={raised ? 'Minimize' : 'Raise'}
                >
                  {raised ? (
                    <ChevronDown className="size-4 shrink-0 text-muted" />
                  ) : (
                    <ChevronUp className="size-4 shrink-0 text-muted" />
                  )}
                  <Vaul.Title asChild>
                    <span className="truncate text-[14px] font-medium text-fg">{title}</span>
                  </Vaul.Title>
                </button>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {actions}
                <button
                  className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-line"
                  onClick={onClose}
                  aria-label={closeLabel}
                  title={closeTitle}
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>
          </div>

          <div className={raised ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>{children}</div>
        </Vaul.Content>
      </Vaul.Portal>
    </Vaul.Root>
  )
}
