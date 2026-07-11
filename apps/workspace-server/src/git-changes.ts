import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ChangedFile } from '@mce/protocol'

const run = promisify(execFile)

/** Best-effort git; returns '' on any failure so callers stay simple. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch {
    return ''
  }
}

/** Current HEAD, captured at turn start so we can diff what a turn changed. */
export async function headSha(cwd: string): Promise<string | undefined> {
  const out = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
  return out || undefined
}

function statusOf(letter: string | undefined): ChangedFile['status'] {
  if (letter === 'A') return 'added'
  if (letter === 'D') return 'deleted'
  if (letter?.startsWith('R')) return 'renamed'
  return 'modified'
}

/**
 * Files changed between `base` and the working tree — covers both committed and
 * uncommitted work since the snapshot, plus untracked new files. Names + counts
 * only; the diff bodies are fetched per file on demand (see `fileDiff`).
 */
export async function changedFiles(cwd: string, base: string): Promise<ChangedFile[]> {
  const files = new Map<string, ChangedFile>()

  const nameStatus = await git(cwd, ['diff', '--name-status', base, '--'])
  const status = new Map<string, string>()
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const path = parts[parts.length - 1]
    if (path) status.set(path, parts[0] ?? '')
  }

  const numstat = await git(cwd, ['diff', '--numstat', base, '--'])
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const path = parts[parts.length - 1]
    if (!path) continue
    const additions = parts[0] === '-' ? 0 : Number(parts[0]) || 0
    const deletions = parts[1] === '-' ? 0 : Number(parts[1]) || 0
    files.set(path, { path, additions, deletions, status: statusOf(status.get(path)) })
  }

  // Untracked files don't show in `git diff` — count them as new additions.
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard'])
  for (const raw of untracked.split('\n')) {
    const path = raw.trim()
    if (!path || files.has(path)) continue
    let additions = 0
    try {
      additions = (await readFile(join(cwd, path), 'utf8')).split('\n').length
    } catch {
      /* binary or unreadable — leave at 0 */
    }
    files.set(path, { path, additions, deletions: 0, status: 'added' })
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** Before/after text for one file, for the client's unified diff view. */
export async function fileDiff(cwd: string, base: string, path: string): Promise<{ before: string; after: string }> {
  const before = await git(cwd, ['show', `${base}:${path}`])
  let after = ''
  try {
    after = await readFile(join(cwd, path), 'utf8')
  } catch {
    /* deleted or unreadable → empty after */
  }
  return { before, after }
}
