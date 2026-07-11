import type { Thread } from '@mce/protocol'
import { useCallback, useEffect, useState } from 'react'
import { fetchThreads } from './api.ts'

/**
 * The active project's thread list (authoritative — the server derives it from
 * the log). Just the list: the active thread is App state, since by default we
 * start a fresh thread on project select and only reach old ones via history.
 *
 * `refresh` runs on project change and as the stream advances, so a new thread
 * or message reorders the list.
 */
export function useThreads(projectId: string | null): { threads: Thread[]; refresh: () => Promise<void> } {
  const [threads, setThreads] = useState<Thread[]>([])

  const refresh = useCallback(async () => {
    if (!projectId) {
      setThreads([])
      return
    }
    setThreads(await fetchThreads(projectId).catch(() => [] as Thread[]))
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { threads, refresh }
}
