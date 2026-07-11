import type { Project } from '@mce/protocol'
import { useCallback, useEffect, useState } from 'react'
import { fetchProjects } from './api.ts'

const ACTIVE_KEY = 'mce.activeProject'

/**
 * The project list (authoritative — the server reads disk) and the active
 * selection, persisted in localStorage so a reload stays on the same project.
 *
 * `refresh` is called on load and whenever a `project_created` event lands, so a
 * slow clone appears in the picker the moment it finishes.
 */
export function useProjects(): {
  projects: Project[]
  activeId: string | null
  setActiveId: (id: string) => void
  refresh: () => Promise<void>
} {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActive] = useState<string | null>(() => localStorage.getItem(ACTIVE_KEY))

  const refresh = useCallback(async () => {
    const list = await fetchProjects().catch(() => [] as Project[])
    setProjects(list)
    setActive((prev) => {
      // Keep the current selection if it still exists; otherwise fall to the first.
      if (prev && list.some((p) => p.id === prev)) return prev
      return list[0]?.id ?? null
    })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setActiveId = useCallback((id: string) => {
    localStorage.setItem(ACTIVE_KEY, id)
    setActive(id)
  }, [])

  return { projects, activeId, setActiveId, refresh }
}
