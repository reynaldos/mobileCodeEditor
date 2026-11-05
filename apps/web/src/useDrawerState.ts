import { useCallback, useMemo, useState } from 'react'

export interface DrawerState {
  open: boolean
  /** Full-height vs minimized to a strip. Meaningless while closed. */
  raised: boolean
  /** Open (or re-open) raised. */
  show: () => void
  raise: () => void
  peek: () => void
  close: () => void
}

/**
 * Open/raised state for one `PeekDrawer` that App owns (terminal, explorer,
 * .env). The preview's lives in `usePreview`, tied to its server lifecycle;
 * this is the plain version for drawers with nothing to start or stop.
 */
export function useDrawerState(): DrawerState {
  const [open, setOpen] = useState(false)
  const [raised, setRaised] = useState(true)

  const show = useCallback(() => {
    setOpen(true)
    setRaised(true)
  }, [])
  const raise = useCallback(() => setRaised(true), [])
  const peek = useCallback(() => setRaised(false), [])
  // Reset to raised so the next open lands full-height, like a fresh preview.
  const close = useCallback(() => {
    setOpen(false)
    setRaised(true)
  }, [])

  // One object per (open, raised) so App can hold it in hook deps.
  return useMemo(() => ({ open, raised, show, raise, peek, close }), [open, raised, show, raise, peek, close])
}

/**
 * `drawer` with `show` and `raise` that run `before` first. App uses it to lower
 * every other drawer, so only one is raised at a time: raised drawers share one
 * z-index, and a second full-height one would otherwise hide behind the first.
 */
export function exclusiveRaise(drawer: DrawerState, before: () => void): DrawerState {
  return {
    ...drawer,
    show: () => {
      before()
      drawer.show()
    },
    raise: () => {
      before()
      drawer.raise()
    },
  }
}
