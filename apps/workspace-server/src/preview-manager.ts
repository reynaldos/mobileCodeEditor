import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import type { Config } from './config.ts'
import type { EventLog } from './log.ts'
import type { Presence } from './presence.ts'
import { detectDevCommand, type ProjectStore } from './projects.ts'
import type { PreviewTracker } from './preview-tracker.ts'

/** How often we poll the fixed port while waiting for the dev server to bind. */
const READY_POLL_MS = 300
/** A dev server that hasn't bound the port by then is treated as failed to start. */
const READY_TIMEOUT_MS = 30_000
/** How often we check Presence for the idle-timeout watch. Cheap; not a hot path. */
const IDLE_POLL_MS = 15_000

export type PreviewStopReason = 'closed' | 'idle-timeout' | 'crashed' | 'restarted'

export class PreviewConflictError extends Error {
  readonly activeProjectId: string

  constructor(activeProjectId: string) {
    super(`A preview is already running for ${activeProjectId}`)
    this.activeProjectId = activeProjectId
  }
}

export class PreviewUnsupportedError extends Error {}

/** Same shape as `node:child_process`'s `spawn` — injectable for tests, exactly like `QueryFn` for the SDK. */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; detached: boolean; env: NodeJS.ProcessEnv },
) => ChildProcess

/**
 * Orchestrates the one active preview dev server (Phase 5): spawns it behind
 * the fixed `config.previewPort`, confirms it's actually listening by polling
 * the port rather than parsing framework-specific stdout (see PHASE-5.md
 * design call 4), retires it on idle, and is the only thing that touches the
 * durable `preview_started`/`preview_stopped` markers.
 *
 * Single-slot by construction — mirrors `SessionManager`/`ProjectStore` in
 * being the one place that owns the child process, but there is at most one
 * live child here, not a `Map` keyed by project. See PHASE-5.md design call 2.
 */
export class PreviewManager {
  readonly #log: EventLog
  readonly #tracker: PreviewTracker
  readonly #projects: ProjectStore
  readonly #presence: Presence
  readonly #port: number
  readonly #idleTimeoutMs: number
  readonly #idlePollMs: number
  readonly #readyPollMs: number
  readonly #readyTimeoutMs: number
  readonly #spawnFn: SpawnFn

  #child: ChildProcess | undefined
  #idleCheck: ReturnType<typeof setInterval> | undefined
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #wasVisible = true

  /**
   * The three `opts.*Ms` overrides and `opts.spawnFn` exist for tests — a 15s
   * idle-poll interval (the production default) would make idle-timeout
   * impossibly slow to exercise, and spawning a real `npm run dev` in every
   * test is slow and, under parallel test load, was outright flaky (npm's own
   * startup overhead varies wildly under CPU contention). `spawnFn` mirrors
   * `QueryFn`'s role for the Claude SDK in session.ts — same reason.
   * Production code never passes `opts`.
   */
  constructor(
    log: EventLog,
    tracker: PreviewTracker,
    projects: ProjectStore,
    presence: Presence,
    config: Config,
    opts: { idlePollMs?: number; readyPollMs?: number; readyTimeoutMs?: number; spawnFn?: SpawnFn } = {},
  ) {
    this.#log = log
    this.#tracker = tracker
    this.#projects = projects
    this.#presence = presence
    this.#port = config.previewPort
    this.#idleTimeoutMs = config.previewIdleTimeoutMs
    this.#idlePollMs = opts.idlePollMs ?? IDLE_POLL_MS
    this.#readyPollMs = opts.readyPollMs ?? READY_POLL_MS
    this.#readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.#spawnFn = opts.spawnFn ?? spawn
  }

  /**
   * Start a preview for `projectId`. Throws `PreviewConflictError` if a
   * different project's preview is active and `force` wasn't set (the client
   * shows the confirm dialog and retries with `force: true` — PHASE-5.md
   * design call 2), or `PreviewUnsupportedError` if the project has no
   * detected dev command.
   */
  async start(projectId: string, opts: { force?: boolean } = {}): Promise<void> {
    const activeId = this.#tracker.activeProjectId()
    if (activeId === projectId) return // already running/starting — idempotent
    if (activeId) {
      if (!opts.force) throw new PreviewConflictError(activeId)
      await this.stop(activeId, 'closed')
    }

    const path = this.#projects.pathOf(projectId)
    if (!path || !this.#projects.exists(projectId)) throw new PreviewUnsupportedError('unknown project')
    const dev = detectDevCommand(path)
    if (!dev) throw new PreviewUnsupportedError("preview isn't supported for this project yet")

    this.#tracker.start(projectId, dev.framework)
    this.#appendEvent(projectId, { type: 'preview_started' })

    // Vite: confirmed by the PHASE-5.md spike, passing --base here is what
    // lets the dev server's own emitted asset/HMR paths line up with the
    // proxy's /preview/:projectId/* mount, with zero rewriting on the proxy
    // side. Next.js has no equivalent flag (Phase 6) — it's spawned at root,
    // and the proxy special-cases its fixed /_next/* asset path instead
    // (server.ts) plus strips the /preview/:projectId prefix for everything
    // else, via `preRewrite`.
    const flags =
      dev.framework === 'next'
        ? ['-p', String(this.#port), '-H', '0.0.0.0']
        : ['--base', `/preview/${projectId}/`, '--port', String(this.#port), '--host']
    const args = [...dev.args, '--', ...flags]

    // detached: true puts the child in its own process group. Necessary
    // because `dev.cmd` is npm/pnpm/yarn/bun, which runs the actual dev
    // server as a *grandchild* (via an intermediate shell) — a plain
    // SIGTERM to the direct child alone routinely leaves that grandchild
    // running and the port still bound. Killing the whole group (see stop())
    // is what actually reaches it.
    //
    // NODE_ENV: 'development' overrides the server's own NODE_ENV=production
    // (Dockerfile) — a dev server has no business inheriting that, and some
    // tooling (e.g. Next.js) actively warns or changes behavior when it sees
    // a "non-standard" NODE_ENV at runtime.
    const child = this.#spawnFn(dev.cmd, args, {
      cwd: dev.cwd,
      detached: true,
      env: { ...process.env, NODE_ENV: 'development' },
    })
    this.#child = child
    child.stdout?.on('data', (d: Buffer) => this.#tracker.line(projectId, d.toString()))
    child.stderr?.on('data', (d: Buffer) => this.#tracker.line(projectId, d.toString()))
    child.on('error', (err) => {
      if (this.#tracker.activeProjectId() === projectId) void this.stop(projectId, 'crashed', err.message)
    })
    child.on('exit', (code) => {
      // This handler is per-spawn, but the manager is single-slot: if `start`
      // already moved on to a *different* project by the time this (possibly
      // belated — the old process can take a moment to actually die) event
      // fires, `this.#child` already points at that new project's child.
      // Clearing it unconditionally here would drop the only reference to it
      // before anyone can ever kill it — a real leaked, un-killable process,
      // not just a stale-event no-op. Only clear what this handler actually owns.
      if (this.#child === child) this.#child = undefined
      // A clean stop() already moved the tracker to a terminal phase before
      // killing the child — only an *unrequested* exit is a crash.
      if (this.#tracker.activeProjectId() === projectId) {
        void this.stop(projectId, 'crashed', code === null ? 'exited unexpectedly' : `exited with code ${code}`)
      }
    })

    this.#startIdleWatch()

    void this.#waitForReady(projectId).catch((err: unknown) => {
      if (this.#tracker.activeProjectId() === projectId) {
        void this.stop(projectId, 'crashed', err instanceof Error ? err.message : String(err))
      }
    })
  }

  /** Stop the active preview, if `projectId` is the one holding the slot. Idempotent otherwise. */
  async stop(projectId: string, reason: PreviewStopReason, error?: string): Promise<void> {
    if (this.#tracker.activeProjectId() !== projectId) return

    this.#stopIdleWatch()
    if (this.#child) {
      killGroup(this.#child)
      this.#child = undefined
    }
    this.#tracker.phase(projectId, reason === 'crashed' ? 'error' : 'stopped', error)
    this.#appendEvent(projectId, { type: 'preview_stopped', reason })
  }

  /** Any preview left running by the last process died with it — mark it stopped, not stuck. */
  recoverOnBoot(): void {
    const active = this.#log.activePreview()
    if (active) this.#appendEvent(active.projectId, { type: 'preview_stopped', reason: 'restarted' })
  }

  async #waitForReady(projectId: string): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs
    while (Date.now() < deadline) {
      if (this.#tracker.activeProjectId() !== projectId) return // stopped/replaced while waiting
      if (await portOpen(this.#port)) {
        this.#tracker.phase(projectId, 'running')
        return
      }
      await sleep(this.#readyPollMs)
    }
    throw new Error(`dev server did not start listening within ${this.#readyTimeoutMs}ms`)
  }

  /**
   * Idle-timeout (PHASE-5.md design call 7, "build it now"): polled, not
   * event-driven, so `Presence` (built for push-suppression) needs no new
   * surface. Only a transition to fully-backgrounded (every device, not just
   * a peeked drawer — see the doc) arms the timer; a transition back cancels it.
   */
  #startIdleWatch(): void {
    this.#wasVisible = this.#presence.anyVisible
    this.#idleCheck = setInterval(() => this.#checkIdle(), this.#idlePollMs)
  }

  #stopIdleWatch(): void {
    if (this.#idleCheck) clearInterval(this.#idleCheck)
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleCheck = undefined
    this.#idleTimer = undefined
  }

  #checkIdle(): void {
    const visible = this.#presence.anyVisible
    if (visible) {
      this.#wasVisible = true
      if (this.#idleTimer) {
        clearTimeout(this.#idleTimer)
        this.#idleTimer = undefined
      }
      return
    }
    if (!this.#wasVisible) return // already idle and timer already armed
    this.#wasVisible = false
    this.#idleTimer = setTimeout(() => {
      const projectId = this.#tracker.activeProjectId()
      if (projectId) void this.stop(projectId, 'idle-timeout')
    }, this.#idleTimeoutMs)
  }

  #appendEvent(
    projectId: string,
    body: { type: 'preview_started' } | { type: 'preview_stopped'; reason: PreviewStopReason },
  ): void {
    this.#log.append({ sessionId: 'system', projectId, ts: Date.now(), ...body })
  }
}

/**
 * Kill the child's whole process group (negative pid), not just the direct
 * child — see the comment at the spawn call in `start()`. Falls back to a
 * plain kill if the group is already gone (ESRCH) or `pid` is somehow unset.
 */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
