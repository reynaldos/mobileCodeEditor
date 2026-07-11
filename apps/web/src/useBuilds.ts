import { useCallback, useEffect, useState } from 'react'
import type { State } from './events.ts'

export interface Builds {
  /** Should the blocking build modal show for this project right now? */
  shouldShow: (projectId: string) => boolean
  /** Is setup still running (vs. finished-awaiting-Open)? */
  isBuilding: (projectId: string) => boolean
  /** Mark a build we just kicked off, before its `started` event round-trips. */
  start: (projectId: string) => void
  /** User closed the finished modal (Open / Back) — don't show it again. */
  dismiss: (projectId: string) => void
}

/**
 * Decides when the blocking build modal is shown, from the reducer's durable
 * `building`/`created`/`failed` plus a little session memory:
 *
 *  - `started` (optimistic, set on confirm) covers the round-trip gap so the
 *    modal appears immediately — no flash of the empty thread.
 *  - `seen` (any project observed building this session) lets the finished-state
 *    "Open" gate survive a build that was already running when the page loaded.
 *  - `dismissed` hides it once the user taps Open or Back.
 *
 * Tying visibility to the *active* project is what makes the modal "stay on that
 * project": switch away and it hides, come back and it returns — until complete.
 */
export function useBuilds(state: State): Builds {
  const [started, setStarted] = useState<Set<string>>(() => new Set())
  const [seen, setSeen] = useState<Set<string>>(() => new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())

  // Remember every project we've seen building this session.
  useEffect(() => {
    if (state.building.length === 0) return
    setSeen((prev) => {
      const missing = state.building.filter((id) => !prev.has(id))
      if (missing.length === 0) return prev
      const next = new Set(prev)
      for (const id of missing) next.add(id)
      return next
    })
  }, [state.building])

  const finished = useCallback(
    (id: string): boolean => state.created.includes(id) || id in state.failed,
    [state.created, state.failed],
  )

  const isBuilding = useCallback(
    (id: string): boolean => (state.building.includes(id) || started.has(id)) && !finished(id),
    [state.building, started, finished],
  )

  const shouldShow = useCallback(
    (id: string): boolean => {
      if (dismissed.has(id)) return false
      if (isBuilding(id)) return true
      // Finished, but only worth a modal if we watched it build this session.
      return (started.has(id) || seen.has(id)) && finished(id)
    },
    [dismissed, isBuilding, started, seen, finished],
  )

  const start = useCallback((id: string) => setStarted((prev) => new Set(prev).add(id)), [])
  const dismiss = useCallback((id: string) => setDismissed((prev) => new Set(prev).add(id)), [])

  return { shouldShow, isBuilding, start, dismiss }
}
