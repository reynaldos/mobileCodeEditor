import type { Thread } from '@mce/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchThreads } from './api.ts'

/**
 * The active project's thread list (authoritative — the server derives it from
 * the log). Just the list: the active thread is App state — a project with no
 * threads yet starts a fresh one automatically, otherwise you land on the
 * thread list and pick (or start) one from there.
 *
 * `refresh` runs on project change and as the stream advances, so a new thread
 * or message reorders the list. `loading` is true only for the initial fetch of
 * a given project (reset on every `projectId` change, alongside clearing stale
 * `threads` from whichever project was previously active) — a `refresh` fired
 * by conversation activity doesn't re-flip it, so the list doesn't flicker back
 * to a loading state on every event.
 *
 * Responses are tagged with the project they were fetched for and dropped if
 * the project changed meanwhile. Without that, switching projects while a
 * fetch for the previous one is in flight (they fire on every stream event)
 * let the late response land on top of the new project's list, and the only
 * way to get the right threads back was a full reload.
 */
export function useThreads(projectId: string | null): { threads: Thread[]; loading: boolean; refresh: () => Promise<void> } {
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const current = useRef(projectId)
  current.current = projectId

  const refresh = useCallback(async () => {
    if (!projectId) {
      setThreads([])
      setLoading(false)
      return
    }
    const list = await fetchThreads(projectId).catch(() => [] as Thread[])
    if (current.current !== projectId) return // a stale response for a project we've left
    setThreads(list)
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    setThreads([])
    setLoading(true)
    void refresh()
  }, [refresh])

  return { threads, loading, refresh }
}
