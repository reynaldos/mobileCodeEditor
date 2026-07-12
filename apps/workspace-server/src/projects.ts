import type { Project, Visibility } from '@mce/protocol'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { BuildTracker } from './build-tracker.ts'
import type { Github } from './github.ts'
import type { EventLog } from './log.ts'

/** Same shape as `node:child_process`'s `spawn` — injectable for tests, mirroring `PreviewManager`'s `SpawnFn`. */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; env: NodeJS.ProcessEnv },
) => ChildProcess

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
  readonly #spawnFn: SpawnFn

  constructor(projectsRoot: string, log: EventLog, github?: Github, builds?: BuildTracker, spawnFn?: SpawnFn) {
    this.#root = resolve(projectsRoot)
    this.#log = log
    this.#github = github
    this.#builds = builds
    this.#spawnFn = spawnFn ?? spawn
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
          previewSupported: detectDevCommand(path) !== undefined,
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
   *
   * `NODE_ENV: 'development'` overrides the server's own `NODE_ENV=production`
   * (Dockerfile) so it never leaks into a project's `install`: npm/pnpm/yarn/bun
   * all silently skip devDependencies under `NODE_ENV=production`, and most
   * projects' own dev tooling (typescript, vite, eslint, tailwind, …) lives
   * there — a project installed under the inherited env looks fine until its
   * dev server (or even loading a TS config file) needs one of them and
   * crashes. `git` (the other command this spawns) ignores NODE_ENV, so
   * applying this unconditionally is harmless.
   */
  #spawn(cmd: string, args: string[], projectId: string, signal: AbortSignal | undefined, cwd?: string): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const child = this.#spawnFn(cmd, args, {
        ...(cwd ? { cwd } : {}),
        ...(signal ? { signal } : {}),
        env: { ...process.env, NODE_ENV: 'development' },
      })
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

  /**
   * Remove a project's local directory ("offload", Phase 6). The filesystem is
   * the source of truth for existence (see the class doc) — once this returns,
   * `list()`/`exists()` no longer see the project. Never touches the git
   * remote; re-cloning by `repoUrl` brings it back.
   *
   * Purely a filesystem op — it's the caller's job (the DELETE route) to stop
   * anything still using the directory first: a live agent session, an
   * in-flight build, or the active preview. Deleting out from under any of
   * those is exactly the bug this ordering avoids.
   */
  remove(id: string): void {
    const path = this.pathOf(id)
    if (!path || !this.exists(id)) throw new RemoveError(`no such project: ${id}`)
    rmSync(path, { recursive: true })
    this.#emit({ type: 'project_removed' }, id)
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
      | { type: 'project_create_failed'; name: string; error: string }
      | { type: 'project_removed' },
    projectId: string,
  ): void {
    this.#log.append({ sessionId: 'system', projectId, ts: Date.now(), ...body })
  }
}

export class RemoveError extends Error {}

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

export interface DevCommand {
  cmd: string
  args: string[]
  /**
   * Vite accepts a subpath `--base` override at spawn time, which the preview
   * reverse-proxy uses to run it transparently under `/preview/<projectId>/`
   * (see PHASE-5.md's spike result). Next.js has no CLI equivalent — its
   * `basePath` is config-file-only — so it's spawned at root instead and the
   * proxy special-cases its fixed `/_next/*` asset path (Phase 6, server.ts).
   * Create React App (`cra`) is the same shape as Next here: `react-scripts`
   * takes no subpath flag either (only a `PORT`/`HOST` env pair), so it's
   * spawned at root too and the proxy special-cases its fixed `/static/*` and
   * `/ws` paths (server.ts).
   */
  framework: 'vite' | 'next' | 'cra'
  /**
   * Absolute directory to run `cmd` from. Equals the project root, unless this
   * is a monorepo whose Vite/Next app lives in a subpackage (Phase 6) — e.g.
   * `apps/web` — in which case detection walks down to find it.
   */
  cwd: string
}

/**
 * Subdirectories probed, one level deep, when the project root itself has no
 * dev command — covers the common `apps/*`/`packages/*` monorepo layouts
 * (pnpm/yarn/npm workspaces). First match wins, apps before packages,
 * alphabetical within each.
 */
const MONOREPO_SEARCH_DIRS = ['apps', 'packages']

/**
 * Which dev command a project's in-app preview (Phase 5/6) should run, or
 * `undefined` if this project isn't previewable yet.
 *
 * Supports Vite and Next.js projects, at the project root or one level down a
 * monorepo's `apps/*`/`packages/*`. A project without a `dev` script, or
 * without either framework, gets no preview button rather than a silent
 * failure on tap — same honest, JS-ecosystem-shaped cut `detectInstall`
 * already makes.
 */
export function detectDevCommand(path: string): DevCommand | undefined {
  const atRoot = detectFrameworkAt(path)
  if (atRoot) return { ...packageManagerFor(path, path, scriptFor(atRoot)), framework: atRoot }

  for (const group of MONOREPO_SEARCH_DIRS) {
    const groupDir = join(path, group)
    if (!existsSync(groupDir) || !statSync(groupDir).isDirectory()) continue
    const children = readdirSync(groupDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
    for (const child of children) {
      const dir = join(groupDir, child)
      const framework = detectFrameworkAt(dir)
      // The lockfile lives at the monorepo root, not in each subpackage, even
      // though `cmd` actually runs from `dir` — see packageManagerFor below.
      if (framework) return { ...packageManagerFor(dir, path, scriptFor(framework)), framework }
    }
  }
  return undefined
}

/** Vite/Next/CRA detection at exactly `dir` — no recursion, no package-manager selection. */
function detectFrameworkAt(dir: string): 'vite' | 'next' | 'cra' | undefined {
  const has = (f: string): boolean => existsSync(join(dir, f))
  const pkg = readPackageJson(dir)
  if (!pkg) return undefined

  if (pkg.scripts?.dev) {
    const isVite =
      has('vite.config.ts') ||
      has('vite.config.js') ||
      has('vite.config.mjs') ||
      has('vite.config.cjs') ||
      Boolean(pkg.dependencies?.vite || pkg.devDependencies?.vite)
    if (isVite) return 'vite'

    const isNext =
      has('next.config.ts') ||
      has('next.config.js') ||
      has('next.config.mjs') ||
      has('next.config.cjs') ||
      Boolean(pkg.dependencies?.next || pkg.devDependencies?.next)
    if (isNext) return 'next'
  }

  // Create React App has no dev-server flag or config file to key off of
  // (react-scripts is a monolithic black box) and, unlike Vite/Next, its dev
  // script is conventionally named "start", not "dev" — so it's checked
  // independently of the `scripts.dev` gate above.
  const isCra =
    Boolean(pkg.scripts?.start) && Boolean(pkg.dependencies?.['react-scripts'] || pkg.devDependencies?.['react-scripts'])
  if (isCra) return 'cra'

  return undefined
}

/** Which script name actually starts each framework's dev server — CRA alone uses "start" instead of "dev". */
function scriptFor(framework: 'vite' | 'next' | 'cra'): string {
  return framework === 'cra' ? 'start' : 'dev'
}

/**
 * Package manager + `run <script>` args, keyed off `lockfileDir` (a
 * workspace's lockfile lives at the monorepo root, not in each subpackage) —
 * `cwd` is where the process actually spawns, which may be a subpackage dir.
 */
function packageManagerFor(
  cwd: string,
  lockfileDir: string,
  script: string,
): { cmd: string; args: string[]; cwd: string } {
  const has = (f: string): boolean => existsSync(join(lockfileDir, f))
  if (has('pnpm-lock.yaml')) return { cmd: 'pnpm', args: ['run', script], cwd }
  if (has('yarn.lock')) return { cmd: 'yarn', args: [script], cwd }
  if (has('bun.lockb') || has('bun.lock')) return { cmd: 'bun', args: ['run', script], cwd }
  return { cmd: 'npm', args: ['run', script], cwd }
}

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPackageJson(path: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return undefined
  }
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
