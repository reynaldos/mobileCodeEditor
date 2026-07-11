import type { Project, Visibility } from '@mce/protocol'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { BuildTracker } from './build-tracker.ts'
import type { Github } from './github.ts'
import type { EventLog } from './log.ts'

/**
 * The projects registry.
 *
 * The **filesystem is the source of truth for what exists** — each directory
 * under `projectsRoot` is a project. The log records how a project was created
 * (`project_created`), which is where the picker gets its "cloned from / when",
 * but existence is never a table that can drift from disk. See DECISIONS #5.
 */
export class ProjectStore {
  readonly #root: string
  readonly #log: EventLog
  readonly #github: Github | undefined
  readonly #builds: BuildTracker | undefined

  constructor(projectsRoot: string, log: EventLog, github?: Github, builds?: BuildTracker) {
    this.#root = resolve(projectsRoot)
    this.#log = log
    this.#github = github
    this.#builds = builds
    mkdirSync(this.#root, { recursive: true })
  }

  /** Every directory under the root is a project. Metadata is best-effort. */
  list(): Project[] {
    const createdAt = this.#createdAtByProject()

    return readdirSync(this.#root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e): Project => {
        const path = join(this.#root, e.name)
        return {
          id: e.name,
          name: e.name,
          ...(gitRemote(path) ? { repoUrl: gitRemote(path)! } : {}),
          ...(gitBranch(path) ? { branch: gitBranch(path)! } : {}),
          ...(createdAt[e.name] !== undefined ? { createdAt: createdAt[e.name] } : {}),
        }
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.name.localeCompare(b.name))
  }

  exists(id: string): boolean {
    const path = this.pathOf(id)
    return path !== undefined && existsSync(path) && statSync(path).isDirectory()
  }

  /**
   * Absolute path for a project id, or undefined if the id would escape the root.
   * The guard is load-bearing: `id` comes from a request, and `../` must never
   * resolve outside `projectsRoot`.
   */
  pathOf(id: string): string | undefined {
    const path = resolve(this.#root, id)
    if (path !== this.#root && !path.startsWith(this.#root + '/')) return undefined
    if (basename(path) !== id) return undefined // rejects `.`, `..`, nested paths
    return path
  }

  /**
   * Clone or init a project. Returns the id synchronously (so the caller can
   * 202 and the client can watch for it), then does the slow work in the
   * background, emitting `project_created` or `project_create_failed`.
   */
  create(input: { repoUrl?: string; name?: string; visibility?: Visibility }): { projectId: string } {
    const id = sanitizeProjectName(input.name ?? (input.repoUrl ? repoName(input.repoUrl) : ''))
    if (!id) throw new CreateError('a name or a repo URL is required')
    if (input.visibility && !this.#github) {
      throw new CreateError('creating a GitHub repo needs gh — set GH_TOKEN')
    }

    const path = this.pathOf(id)
    if (!path) throw new CreateError(`invalid project name: ${id}`)
    if (existsSync(path)) throw new CreateError(`a project named "${id}" already exists`)

    // Fire and forget; the outcome lands in the log, not this response.
    void this.#build(id, path, input)
    return { projectId: id }
  }

  async #build(
    id: string,
    path: string,
    input: { repoUrl?: string; visibility?: Visibility },
  ): Promise<void> {
    const signal = this.#builds?.start(id)
    this.#emit({ type: 'project_create_started', name: id, ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}) }, id)

    let repoUrl = input.repoUrl
    let cloned = false
    try {
      if (input.visibility && this.#github) {
        // Create the GitHub repo first, then clone it — so the project has a
        // remote and `git push` works from the first commit.
        this.#builds?.line(id, `Creating ${input.visibility} GitHub repo ${id}…`)
        repoUrl = await this.#github.createRepo(id, input.visibility)
      }

      this.#builds?.phase(id, 'cloning')
      if (repoUrl) {
        // `gh auth setup-git` (entrypoint) configured the credential helper, so a
        // plain clone works for private repos too. argv array — no shell.
        this.#builds?.line(id, `$ git clone ${repoUrl}`)
        await this.#spawn('git', ['clone', '--progress', repoUrl, path], id, signal)
      } else {
        mkdirSync(path, { recursive: true })
        this.#builds?.line(id, `$ git init -b main`)
        await this.#spawn('git', ['-C', path, 'init', '-b', 'main'], id, signal)
      }
      cloned = true

      // Dependencies, if this looks like a package. A failed install is a warning,
      // not a failure — the repo is already usable and you can retry in the thread.
      let warning: string | undefined
      const install = detectInstall(path)
      if (install) {
        this.#builds?.phase(id, 'installing')
        this.#builds?.line(id, `$ ${install.cmd} ${install.args.join(' ')}`)
        try {
          await this.#spawn(install.cmd, install.args, id, signal, path)
        } catch (err) {
          if (signal?.aborted) throw err
          warning = `Dependency install failed: ${messageOf(err)}`
          this.#builds?.line(id, warning)
        }
      }

      this.#emit({ type: 'project_created', name: id, ...(repoUrl ? { repoUrl } : {}) }, id)
      this.#builds?.phase(id, 'ready', warning ? { warning } : undefined)
    } catch (err) {
      const aborted = signal?.aborted ?? false
      // A cancel, or a clone that never produced a usable repo, leaves nothing
      // worth keeping — remove it so the next attempt doesn't 409 on the dir.
      if (aborted || !cloned) {
        try {
          rmSync(path, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
      const error = aborted ? 'Cancelled' : messageOf(err)
      this.#emit({ type: 'project_create_failed', name: id, error }, id)
      this.#builds?.phase(id, aborted ? 'cancelled' : 'error', { error })
    }
  }

  /**
   * Spawn a child, streaming its output into the build log line-by-line. The
   * AbortSignal (from BuildTracker) kills the process on cancel; we reject so
   * `#build` can clean up.
   */
  #spawn(cmd: string, args: string[], projectId: string, signal: AbortSignal | undefined, cwd?: string): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const child = spawn(cmd, args, { ...(cwd ? { cwd } : {}), ...(signal ? { signal } : {}) })
      child.stdout?.on('data', (d: Buffer) => this.#builds?.line(projectId, d.toString()))
      child.stderr?.on('data', (d: Buffer) => this.#builds?.line(projectId, d.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (signal?.aborted) return reject(new Error('cancelled'))
        if (code === 0) return resolvePromise()
        reject(new Error(`${cmd} exited with code ${code ?? 'null'}`))
      })
    })
  }

  /**
   * On boot, any `project_create_started` with no terminal event is a build that
   * died with the last process. Its directory is a half-made clone — remove it
   * and record the failure, so no client is left staring at a build that will
   * never finish. Mirrors SessionManager.recoverOnBoot for sessions.
   */
  recoverOnBoot(): void {
    for (const id of this.#log.interruptedBuilds()) {
      const path = this.pathOf(id)
      if (path) {
        try {
          rmSync(path, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
      this.#emit({ type: 'project_create_failed', name: id, error: 'Server restarted during setup.' }, id)
    }
  }

  #createdAtByProject(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const e of this.#log.projectCreations()) out[e.name] = e.ts
    return out
  }

  #emit(
    body:
      | { type: 'project_create_started'; name: string; repoUrl?: string }
      | { type: 'project_created'; name: string; repoUrl?: string }
      | { type: 'project_create_failed'; name: string; error: string },
    projectId: string,
  ): void {
    this.#log.append({ sessionId: 'system', projectId, ts: Date.now(), ...body })
  }
}

export class CreateError extends Error {}

/**
 * Which install command a freshly-cloned project wants, from its lockfile (then
 * a bare package.json). JS ecosystems only for now; unknown projects skip install.
 */
function detectInstall(path: string): { cmd: string; args: string[] } | undefined {
  const has = (f: string): boolean => existsSync(join(path, f))
  if (has('pnpm-lock.yaml')) return { cmd: 'pnpm', args: ['install'] }
  if (has('yarn.lock')) return { cmd: 'yarn', args: ['install'] }
  if (has('bun.lockb') || has('bun.lock')) return { cmd: 'bun', args: ['install'] }
  if (has('package-lock.json')) return { cmd: 'npm', args: ['install'] }
  if (has('package.json')) return { cmd: 'npm', args: ['install'] }
  return undefined
}

/** Directory-safe project id: letters, digits, dot, dash, underscore. */
export function sanitizeProjectName(name: string): string {
  return name
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
}

/** Last path segment of a git URL, ssh or https, minus `.git`. */
function repoName(url: string): string {
  const tail = url.replace(/\.git$/i, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? ''
  return tail
}

function gitRemote(path: string): string | undefined {
  return gitRead(path, ['remote', 'get-url', 'origin'])
}

function gitBranch(path: string): string | undefined {
  return gitRead(path, ['branch', '--show-current'])
}

/** Synchronous, best-effort git read. Returns undefined on any failure. */
function gitRead(path: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || undefined
  } catch {
    return undefined
  }
}

function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.trim()) {
    return err.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
  }
  return err instanceof Error ? err.message : String(err)
}
