import type { Project } from '@mce/protocol'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { EventLog } from './log.ts'

const run = promisify(execFile)

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

  constructor(projectsRoot: string, log: EventLog) {
    this.#root = resolve(projectsRoot)
    this.#log = log
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
  create(input: { repoUrl?: string; name?: string }): { projectId: string } {
    const id = sanitize(input.name ?? (input.repoUrl ? repoName(input.repoUrl) : ''))
    if (!id) throw new CreateError('a name or a repo URL is required')

    const path = this.pathOf(id)
    if (!path) throw new CreateError(`invalid project name: ${id}`)
    if (existsSync(path)) throw new CreateError(`a project named "${id}" already exists`)

    // Fire and forget; the outcome lands in the log, not this response.
    void this.#build(id, path, input)
    return { projectId: id }
  }

  async #build(id: string, path: string, input: { repoUrl?: string }): Promise<void> {
    try {
      if (input.repoUrl) {
        // `gh auth setup-git` (entrypoint) configured the credential helper, so a
        // plain clone works for private repos too. argv array — no shell.
        await run('git', ['clone', input.repoUrl, path], { timeout: 5 * 60_000 })
      } else {
        mkdirSync(path, { recursive: true })
        await run('git', ['-C', path, 'init', '-b', 'main'])
      }
      this.#emit({ type: 'project_created', name: id, ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}) }, id)
    } catch (err) {
      // Don't leave a half-cloned directory behind — the next attempt would 409.
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
      this.#emit({ type: 'project_create_failed', name: id, error: messageOf(err) }, id)
    }
  }

  #createdAtByProject(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const e of this.#log.projectCreations()) out[e.name] = e.ts
    return out
  }

  #emit(body: { type: 'project_created'; name: string; repoUrl?: string } | { type: 'project_create_failed'; name: string; error: string }, projectId: string): void {
    this.#log.append({ sessionId: 'system', projectId, ts: Date.now(), ...body })
  }
}

export class CreateError extends Error {}

/** Directory-safe project id: letters, digits, dot, dash, underscore. */
function sanitize(name: string): string {
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
