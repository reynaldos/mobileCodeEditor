import type { BuildPhase, BuildSnapshot, BuildStreamMessage } from '@mce/protocol'

/** Ring-buffer cap per build — a big clone can print a lot of progress lines. */
const MAX_LINES = 3000
/** How many finished builds to keep around for late log viewers before pruning. */
const RETAIN_FINISHED = 24

interface Build {
  projectId: string
  phase: BuildPhase
  lines: string[]
  error?: string
  warning?: string
  abort: AbortController
  finishedAt?: number
  subscribers: Set<(m: BuildStreamMessage) => void>
}

const isTerminal = (p: BuildPhase): boolean => p === 'ready' || p === 'error' || p === 'cancelled'

/**
 * Live, in-memory state for project builds (Phase 2.6).
 *
 * Deliberately NOT in the durable event log: git/npm output is high-volume and
 * ephemeral. The log carries only the two lifecycle markers a returning client
 * needs (`project_create_started` / the terminal event); the terminal *text*
 * lives here and streams over a dedicated SSE. Finished builds linger briefly so
 * you can still read the log right after it completes.
 */
export class BuildTracker {
  readonly #builds = new Map<string, Build>()

  /** Begin tracking; returns the AbortSignal to pass to the build's child processes. */
  start(projectId: string): AbortSignal {
    this.#pruneFinished()
    const abort = new AbortController()
    this.#builds.set(projectId, { projectId, phase: 'cloning', lines: [], abort, subscribers: new Set() })
    return abort.signal
  }

  phase(projectId: string, phase: BuildPhase, extra?: { error?: string; warning?: string }): void {
    const b = this.#builds.get(projectId)
    if (!b) return
    b.phase = phase
    if (extra?.error) b.error = extra.error
    if (extra?.warning) b.warning = extra.warning
    if (isTerminal(phase)) b.finishedAt = Date.now()
    this.#emit(b, {
      type: 'phase',
      phase,
      ...(extra?.error ? { error: extra.error } : {}),
      ...(extra?.warning ? { warning: extra.warning } : {}),
    })
  }

  /** Feed raw stdout/stderr; split into lines (git --progress uses \r). */
  line(projectId: string, chunk: string): void {
    const b = this.#builds.get(projectId)
    if (!b) return
    for (const raw of chunk.split(/[\r\n]+/)) {
      const line = raw.trimEnd()
      if (!line) continue
      b.lines.push(line)
      if (b.lines.length > MAX_LINES) b.lines.shift()
      this.#emit(b, { type: 'line', line })
    }
  }

  /** Request cancellation; the child processes get SIGTERM via their AbortSignal. */
  cancel(projectId: string): boolean {
    const b = this.#builds.get(projectId)
    if (!b || b.finishedAt) return false
    b.abort.abort()
    return true
  }

  isActive(projectId: string): boolean {
    const b = this.#builds.get(projectId)
    return b !== undefined && b.finishedAt === undefined
  }

  snapshot(projectId: string): BuildSnapshot | undefined {
    const b = this.#builds.get(projectId)
    if (!b) return undefined
    return {
      projectId,
      phase: b.phase,
      lines: [...b.lines],
      ...(b.error ? { error: b.error } : {}),
      ...(b.warning ? { warning: b.warning } : {}),
    }
  }

  /** Subscribe to live messages. Returns unsubscribe; no-op if the build is unknown. */
  subscribe(projectId: string, fn: (m: BuildStreamMessage) => void): () => void {
    const b = this.#builds.get(projectId)
    if (!b) return () => {}
    b.subscribers.add(fn)
    return () => b.subscribers.delete(fn)
  }

  #emit(b: Build, m: BuildStreamMessage): void {
    for (const fn of b.subscribers) {
      try {
        fn(m)
      } catch {
        /* a dead SSE connection is not the build's problem */
      }
    }
  }

  #pruneFinished(): void {
    const finished = [...this.#builds.values()]
      .filter((b) => b.finishedAt !== undefined)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    while (finished.length > RETAIN_FINISHED) {
      this.#builds.delete(finished.shift()!.projectId)
    }
  }
}
