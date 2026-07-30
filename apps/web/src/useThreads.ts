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
 */
export function useThreads(projectId: string | null): { threads: Thread[]; loading: boolean; refresh: () => Promise<void> } {
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const currentProjectId = useRef(projectId)
  currentProjectId.current = projectId

  const refresh = useCallback(async () => {
    if (!projectId) {
      setThreads([])
      setLoading(false)
      return
    }
    const result = await fetchThreads(projectId).catch(() => [] as Thread[])
    if (currentProjectId.current !== projectId) return // a later project switch already superseded this fetch
    setThreads(result)
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    setThreads([])
    setLoading(true)
    void refresh()
  }, [refresh])

  return { threads, loading, refresh }
}
