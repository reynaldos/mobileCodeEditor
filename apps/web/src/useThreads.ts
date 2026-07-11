import type { Thread } from '@mce/protocol'
import { useCallback, useEffect, useState } from 'react'
import { fetchThreads } from './api.ts'

const activeKey = (projectId: string): string => `mce.activeThread.${projectId}`

/**
 * The active project's thread list (authoritative — the server derives it from
 * the log) and the active thread within it, persisted per project so a reload
 * lands back where you were.
 *
 * `refresh` is called when the project changes and whenever the event stream
 * suggests thread activity, so a new thread or a new message reorders the list.
 */
export function useThreads(projectId: string | null): {
  threads: Thread[]
  activeThreadId: string | null
  setActiveThreadId: (id: string | null) => void
  refresh: () => Promise<void>
} {
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThreadId, setActive] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!projectId) {
      setThreads([])
      return
    }
    const list = await fetchThreads(projectId).catch(() => [] as Thread[])
    setThreads(list)
  }, [projectId])

  // On project change, load its saved active thread and refetch its list.
  useEffect(() => {
    setActive(projectId ? localStorage.getItem(activeKey(projectId)) : null)
    void refresh()
  }, [projectId, refresh])

  const setActiveThreadId = useCallback(
    (id: string | null) => {
      if (projectId && id) localStorage.setItem(activeKey(projectId), id)
      setActive(id)
    },
    [projectId],
  )

  return { threads, activeThreadId, setActiveThreadId, refresh }
}
