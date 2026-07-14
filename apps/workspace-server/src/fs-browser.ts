import type { FsEntry, FsSearchMatch } from '@mce/protocol'
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Resolve a client-supplied repo-relative path against a project root and
 * assert the result never escapes it. Load-bearing (PHASE-3.md design call
 * 8): `relPath` comes straight off a request query string. Mirrors
 * `ProjectStore.pathOf`'s guard, extended to nested paths — a project id is
 * always one path segment, a file path isn't.
 */
export function resolveSafe(root: string, relPath: string): string | undefined {
  const path = resolve(root, relPath.replace(/^\/+/, ''))
  if (path !== root && !path.startsWith(root + '/')) return undefined
  return path
}

/** Cap on entries returned per directory — a single `node_modules` level can otherwise be enormous. */
const MAX_ENTRIES = 1000

/**
 * One level of a directory: folders before files, both alphabetical. Never
 * recurses (PHASE-3.md design call 5 — the tree is fetched lazily, one expand
 * at a time). Dotfiles are included; VS Code's own explorer shows them too,
 * and this app has no `.gitignore`-aware filtering to hide them correctly.
 */
export function listDir(root: string, relPath: string): { entries: FsEntry[]; truncated: boolean } | undefined {
  const dir = resolveSafe(root, relPath)
  if (!dir) return undefined

  let raw
  try {
    raw = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const base = relPath.replace(/^\/+|\/+$/g, '')
  const entries = raw
    .map((e): FsEntry => ({
      name: e.name,
      path: base ? `${base}/${e.name}` : e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))

  return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES }
}

/** Large enough for real source files, small enough to hand a phone browser. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** A file's text contents, or undefined if it doesn't exist, isn't a regular file, is too large, or looks binary. */
export function readTextFile(root: string, relPath: string): string | undefined {
  const file = resolveSafe(root, relPath)
  if (!file) return undefined

  let stat
  try {
    stat = statSync(file)
  } catch {
    return undefined
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined

  let buf: Buffer
  try {
    buf = readFileSync(file)
  } catch {
    return undefined
  }
  return looksBinary(buf) ? undefined : buf.toString('utf8')
}

/** A NUL byte in the first few KB is the standard, dependency-free binary sniff. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(buf.length, 8000)).includes(0)
}

/** Total matches returned across all files, not per file. */
const MAX_SEARCH_MATCHES = 200
/** Matches taken from any single file, so one huge generated file can't crowd out everything else. */
const MAX_MATCHES_PER_FILE = 5

/**
 * ripgrep-backed content search, scoped to `root` (PHASE-3.md design call 5).
 * An empty query returns no matches rather than "everything" — there's no
 * useful flat list for a blank search.
 */
export async function searchFiles(root: string, query: string): Promise<{ matches: FsSearchMatch[]; truncated: boolean }> {
  const q = query.trim()
  if (!q) return { matches: [], truncated: false }

  let stdout: string
  try {
    ;({ stdout } = await run(
      'rg',
      ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(MAX_MATCHES_PER_FILE), '--', q, '.'],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    ))
  } catch {
    // ripgrep exits 1 for "no matches" (not a real error) and also on any
    // other failure (bad pattern, unreadable dir) — either way, no results.
    return { matches: [], truncated: false }
  }

  const matches: FsSearchMatch[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    // "<path>:<lineNo>:<text>" — text itself may contain colons, so only the
    // first two are structural.
    const first = line.indexOf(':')
    const second = line.indexOf(':', first + 1)
    if (first < 0 || second < 0) continue
    const lineNo = Number(line.slice(first + 1, second))
    if (!Number.isFinite(lineNo)) continue
    matches.push({
      path: line.slice(0, first).replace(/^\.\//, ''),
      line: lineNo,
      text: line.slice(second + 1).slice(0, 300),
    })
    if (matches.length >= MAX_SEARCH_MATCHES) break
  }
  return { matches, truncated: matches.length >= MAX_SEARCH_MATCHES }
}
