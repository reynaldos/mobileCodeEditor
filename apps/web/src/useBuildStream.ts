import type { BuildPhase, BuildStreamMessage } from '@mce/protocol'
import { useEffect, useState } from 'react'
import { buildStreamUrl } from './api.ts'

export interface BuildView {
  phase: BuildPhase
  lines: string[]
  error?: string
  warning?: string
}

/**
 * Subscribe to a project's live setup output (clone + install). A `snapshot`
 * catches up a late joiner; `line`/`phase` messages stream until the build
 * resolves. Pass `null` to stay disconnected.
 */
export function useBuildStream(projectId: string | null): BuildView {
  const [view, setView] = useState<BuildView>({ phase: 'cloning', lines: [] })

  useEffect(() => {
    if (!projectId) return
    setView({ phase: 'cloning', lines: [] })

    const source = new EventSource(buildStreamUrl(projectId))
    source.onmessage = (e) => {
      const m = JSON.parse(e.data) as BuildStreamMessage
      setView((prev) => {
        if (m.type === 'snapshot') {
          return { phase: m.snapshot.phase, lines: m.snapshot.lines, error: m.snapshot.error, warning: m.snapshot.warning }
        }
        if (m.type === 'line') return { ...prev, lines: [...prev.lines, m.line] }
        return { ...prev, phase: m.phase, error: m.error ?? prev.error, warning: m.warning ?? prev.warning }
      })
    }
    return () => source.close()
  }, [projectId])

  return view
}
