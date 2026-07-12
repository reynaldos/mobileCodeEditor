import type { PreviewPhase, PreviewStreamMessage } from '@mce/protocol'
import { useEffect, useState } from 'react'
import { previewStreamUrl } from './api.ts'

export interface PreviewView {
  phase: PreviewPhase
  lines: string[]
  error?: string
}

/**
 * Subscribe to the active preview's live phase + dev-server output (Phase 5). A
 * `snapshot` catches up a late joiner (drawer reopened, page reloaded mid-run);
 * `line`/`phase` messages stream after. Pass `null` to stay disconnected — the
 * drawer does this while closed, so a peeked-but-closed tab doesn't hold an SSE
 * connection for a preview nobody's looking at.
 */
export function usePreviewStream(projectId: string | null): PreviewView {
  const [view, setView] = useState<PreviewView>({ phase: 'starting', lines: [] })

  useEffect(() => {
    if (!projectId) return
    setView({ phase: 'starting', lines: [] })

    const source = new EventSource(previewStreamUrl(projectId))
    source.onmessage = (e) => {
      const m = JSON.parse(e.data) as PreviewStreamMessage
      setView((prev) => {
        if (m.type === 'snapshot') {
          return { phase: m.snapshot.phase, lines: m.snapshot.lines, error: m.snapshot.error }
        }
        if (m.type === 'line') return { ...prev, lines: [...prev.lines, m.line] }
        return { ...prev, phase: m.phase, error: m.error ?? prev.error }
      })
    }
    return () => source.close()
  }, [projectId])

  return view
}
