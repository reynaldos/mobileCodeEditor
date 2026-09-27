import type { PreviewPhase, PreviewSnapshot, PreviewStreamMessage } from '@mce/protocol'

/** Ring-buffer cap — a chatty dev server (Vite, webpack) can print a lot. */
const MAX_LINES = 3000

interface Preview {
  projectId: string
  framework: 'vite' | 'next' | 'cra'
  phase: PreviewPhase
  lines: string[]
  error?: string
  subscribers: Set<(m: PreviewStreamMessage) => void>
}

const isTerminal = (p: PreviewPhase): boolean => p === 'error' || p === 'stopped'

/**
 * Live, in-memory state for the one active preview dev server (Phase 5).
 *
 * Deliberately NOT in the durable event log: dev-server stdout/stderr is
 * high-volume and ephemeral, the same split `BuildTracker` makes for
 * clone/install output. The log carries only the two lifecycle markers
 * (`preview_started` / `preview_stopped`) a returning client needs; the
 * terminal *text* lives here and streams over its own SSE.
 *
 * Unlike `BuildTracker`, there is only ever **zero or one** entry — a single
 * fixed-port dev server, system-wide (see PHASE-5.md design call 2, "one dev
 * server at a time"). Starting a new preview simply replaces whatever was here.
 */
export class PreviewTracker {
  #active: Preview | undefined

  /** Begin tracking a new preview. Replaces (does not merge with) any previous one. */
  start(projectId: string, framework: 'vite' | 'next' | 'cra'): void {
    this.#active = { projectId, framework, phase: 'starting', lines: [], subscribers: new Set() }
  }

  phase(projectId: string, phase: PreviewPhase, error?: string): void {
    const p = this.#active
    if (!p || p.projectId !== projectId) return
    p.phase = phase
    if (error) p.error = error
    this.#emit(p, { type: 'phase', phase, ...(error ? { error } : {}) })
  }

  /** Feed raw stdout/stderr; split into lines. */
  line(projectId: string, chunk: string): void {
    const p = this.#active
    if (!p || p.projectId !== projectId) return
    for (const raw of chunk.split(/[\r\n]+/)) {
      const line = raw.trimEnd()
      if (!line) continue
      p.lines.push(line)
      if (p.lines.length > MAX_LINES) p.lines.shift()
      this.#emit(p, { type: 'line', line })
    }
  }

  /** The project currently holding the slot, or `undefined` once it's reached a terminal phase. */
  activeProjectId(): string | undefined {
    return this.#active && !isTerminal(this.#active.phase) ? this.#active.projectId : undefined
  }

  /** The framework of the project currently holding the slot. */
  activeFramework(): 'vite' | 'next' | 'cra' | undefined {
    return this.#active && !isTerminal(this.#active.phase) ? this.#active.framework : undefined
  }

  snapshot(projectId: string): PreviewSnapshot | undefined {
    const p = this.#active
    if (!p || p.projectId !== projectId) return undefined
    return { projectId, phase: p.phase, lines: [...p.lines], ...(p.error ? { error: p.error } : {}) }
  }

  /** Subscribe to live messages. Returns unsubscribe; no-op if this project isn't the active one. */
  subscribe(projectId: string, fn: (m: PreviewStreamMessage) => void): () => void {
    const p = this.#active
    if (!p || p.projectId !== projectId) return () => {}
    p.subscribers.add(fn)
    return () => p.subscribers.delete(fn)
  }

  #emit(p: Preview, m: PreviewStreamMessage): void {
    for (const fn of p.subscribers) {
      try {
        fn(m)
      } catch {
        /* a dead SSE connection is not the preview's problem */
      }
    }
  }
}
