import { useCallback, useEffect, useState } from 'react'
import { PreviewConflictError, startPreview, stopPreview } from './api.ts'

export interface Preview {
  /** The project id currently showing in the drawer, or null (drawer closed). */
  projectId: string | null
  /** Full-height vs peeked-strip. Meaningless while `projectId` is null. */
  raised: boolean
  /** The POST /start itself failed outright (not a conflict) — shown in the drawer in place of the SSE-driven view. */
  startError: string | null
  /** Set when a start hit 409 — the id of the OTHER project whose preview is active. The caller shows the confirm-and-evict dialog. */
  conflictWith: string | null
  /** Tap the nav button for `projectId`. Opens+raises the drawer optimistically; may set `conflictWith` instead of actually starting. */
  request: (projectId: string) => void
  /** Confirm the evict-and-start after a conflict. */
  confirmEvict: () => void
  /** Dismiss the conflict dialog without starting anything. */
  cancelConflict: () => void
  raise: () => void
  peek: () => void
  /** Full close — always stops the server immediately, no confirm (PHASE-5.md: trust the gesture). */
  close: () => void
}

/**
 * Drives the preview drawer's UI state. `durablePreview` is `state.preview`
 * from the event reducer — the source of truth for which project (if any) has
 * a preview actually running, durable across reloads and other tabs.
 *
 * Layered on top of that is a little optimistic/session-only state, same shape
 * as `useBuilds`: `projectId` shows the drawer the instant you tap (before the
 * `preview_started` event round-trips), and `closedFor` hides it the instant
 * you close (before `preview_stopped` round-trips) — the request is fired
 * either way, this is purely about not making the UI wait on the network for
 * something the user just told it to do.
 */
export function usePreview(durablePreview: string | null): Preview {
  const [optimistic, setOptimistic] = useState<string | null>(null)
  const [raised, setRaised] = useState(true)
  const [conflictWith, setConflictWith] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [closedFor, setClosedFor] = useState<string | null>(null)

  // The durable event moving on (a real stop landed, or a different project's
  // preview started) makes whatever we'd locally dismissed stale — drop it so
  // a *new* preview for the same project id isn't born pre-closed.
  useEffect(() => {
    setClosedFor((prev) => (prev === durablePreview ? prev : null))
  }, [durablePreview])

  const rawId = durablePreview ?? optimistic
  const projectId = rawId !== null && rawId === closedFor ? null : rawId

  const go = useCallback((id: string, force: boolean) => {
    setClosedFor(null)
    setOptimistic(id)
    setRaised(true)
    setStartError(null)
    setConflictWith(null)
    startPreview(id, force).catch((err: unknown) => {
      if (err instanceof PreviewConflictError) {
        setOptimistic(null)
        setConflictWith(err.activeProjectId)
        setPendingId(id)
        return
      }
      setStartError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  const request = useCallback((id: string) => go(id, false), [go])
  const confirmEvict = useCallback(() => {
    if (pendingId) go(pendingId, true)
  }, [pendingId, go])
  const cancelConflict = useCallback(() => {
    setConflictWith(null)
    setPendingId(null)
  }, [])

  const raise = useCallback(() => setRaised(true), [])
  const peek = useCallback(() => setRaised(false), [])

  const close = useCallback(() => {
    const id = durablePreview ?? optimistic
    setOptimistic(null)
    setStartError(null)
    setRaised(true)
    if (id) {
      setClosedFor(id)
      void stopPreview(id).catch(() => undefined)
    }
  }, [durablePreview, optimistic])

  return { projectId, raised, startError, conflictWith, request, confirmEvict, cancelConflict, raise, peek, close }
}
