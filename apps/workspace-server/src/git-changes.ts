import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ChangedFile, GitStashEntry } from '@mce/protocol'

const run = promisify(execFile)

/**
 * git's well-known empty tree. The diff base for a repo with no commits yet, so
 * a project the app just created (`git init`, or a clone of a brand-new GitHub
 * repo) still lists its files as changes and can make its first commit.
 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Best-effort git; returns '' on any failure so callers stay simple. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch {
    return ''
  }
}

/** Like `git`, but reports success/failure — for mutating/network ops where the caller must know it worked. */
async function tryGit(cwd: string, args: string[], timeoutMs?: number): Promise<{ ok: boolean; stderr: string }> {
  try {
    await run('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024, ...(timeoutMs ? { timeout: timeoutMs } : {}) })
    return { ok: true, stderr: '' }
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err)
    return { ok: false, stderr }
  }
}

/** Current HEAD, captured at turn start so we can diff what a turn changed. */
export async function headSha(cwd: string): Promise<string | undefined> {
  const out = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
  return out || undefined
}

/** `origin`'s URL, or undefined when the repo has no remote. No network. */
export async function remoteUrl(cwd: string): Promise<string | undefined> {
  const out = (await git(cwd, ['remote', 'get-url', 'origin'])).trim()
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

/**
 * The branch's upstream tracking ref plus ahead/behind counts, or undefined if
 * it tracks no remote. No network — the counts reflect the last fetch, exactly
 * like `git status`'s "your branch is behind…" line.
 */
export async function upstreamStatus(cwd: string): Promise<{ name: string; ahead: number; behind: number } | undefined> {
  const name = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim()
  if (!name) return undefined
  // `--left-right --count @{upstream}...HEAD`: left = commits only on upstream (behind), right = only on HEAD (ahead).
  const counts = (await git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim()
  const [behind, ahead] = counts.split(/\s+/).map((n) => Number(n) || 0)
  return { name, behind: behind ?? 0, ahead: ahead ?? 0 }
}

/** Any uncommitted or untracked change in the working tree — the guard the refresh refuses to cross. */
export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])).trim().length > 0
}

/**
 * Fetch the branch's remote and fast-forward the local branch onto it. Caller
 * MUST have already confirmed the tree is clean (see `isDirty`). Never merges or
 * rebases: `--ff-only` succeeds when up-to-date or purely behind, and fails
 * (→ 'diverged') the moment a real merge would be required.
 */
export async function fastForwardToUpstream(cwd: string): Promise<'ok' | 'diverged' | 'error'> {
  const fetched = await tryGit(cwd, ['fetch', '--quiet'], 20_000)
  if (!fetched.ok) return 'error'
  const ff = await tryGit(cwd, ['merge', '--ff-only', '@{upstream}'])
  return ff.ok ? 'ok' : 'diverged'
}

// --- Manual git controls (local-only): branches, stash, commit --------------

/** The current branch (or a short sha in detached HEAD) plus the local branches, sorted. */
export async function listBranches(cwd: string): Promise<{ current: string; branches: string[] }> {
  // `symbolic-ref` names the branch even before its first commit (an unborn
  // branch has no sha for `rev-parse` to resolve). It fails on a detached HEAD;
  // fall back to a short sha so the UI shows something real.
  const head = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim()
  const current = head || (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
  const out = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  const branches = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
  return { current, branches }
}

/** A branch name git will accept: no spaces, no `..`, no leading `-`, none of git's reserved chars. */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock')) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  return !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)
}

/** Switch to `branch`, creating it off HEAD when `create`. Fails (not throws) on a git error. */
export async function checkoutBranch(cwd: string, branch: string, create: boolean): Promise<{ ok: boolean; stderr: string }> {
  return tryGit(cwd, create ? ['checkout', '-b', branch] : ['checkout', branch])
}

/** The stash stack, newest first (index 0 is the most recent). */
export async function listStashes(cwd: string): Promise<GitStashEntry[]> {
  const out = await git(cwd, ['stash', 'list', '--format=%gd%x09%gs']) // %x09 = TAB
  const entries: GitStashEntry[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const tab = line.indexOf('\t')
    const ref = tab === -1 ? line : line.slice(0, tab)
    const message = tab === -1 ? '' : line.slice(tab + 1)
    const m = ref.match(/stash@\{(\d+)\}/)
    entries.push({ index: m ? Number(m[1]) : entries.length, ref, message })
  }
  return entries
}

/** One stash operation. `index` selects the entry for pop/apply/drop. Fails (not throws) on a git error. */
export async function stashAction(
  cwd: string,
  action: 'save' | 'pop' | 'apply' | 'drop',
  index = 0,
  message?: string,
): Promise<{ ok: boolean; stderr: string }> {
  if (action === 'save') {
    return tryGit(cwd, message ? ['stash', 'push', '-m', message] : ['stash', 'push'])
  }
  return tryGit(cwd, ['stash', action, `stash@{${index}}`])
}

/**
 * Stage exactly `paths` and commit them with `message`. `git add` stages
 * modifications, additions (untracked), and deletions alike; committing with the
 * same pathspec keeps the commit to just the selected files even if the index
 * held other staged changes. Local only — never pushes.
 */
export async function commitPaths(cwd: string, message: string, paths: string[]): Promise<{ ok: boolean; stderr: string }> {
  if (paths.length === 0) return { ok: false, stderr: 'No files selected.' }
  const added = await tryGit(cwd, ['add', '--', ...paths])
  if (!added.ok) return added
  return tryGit(cwd, ['commit', '-m', message, '--', ...paths])
}

/**
 * Push the current branch. Best-effort follow-on to a commit: needs network,
 * so it's reported separately and a failure never undoes the commit.
 *
 * A branch with no upstream is the normal state of a project the app created
 * (`git init`, or a clone of a brand-new GitHub repo, where even the first
 * commit has nothing to track) and of any branch made locally. When `origin`
 * exists, publish the branch there (`push -u`) so it tracks from then on;
 * `published` says that happened. `noUpstream` is only for a repo with no
 * remote at all.
 */
export async function pushCurrent(
  cwd: string,
): Promise<{ ok: boolean; stderr: string; noUpstream?: boolean; published?: boolean }> {
  const upstream = await upstreamStatus(cwd)
  if (upstream) {
    const r = await tryGit(cwd, ['push'], 30_000)
    return { ok: r.ok, stderr: r.stderr }
  }
  if (!(await remoteUrl(cwd))) return { ok: false, stderr: '', noUpstream: true }
  const r = await tryGit(cwd, ['push', '-u', 'origin', 'HEAD'], 30_000)
  return { ok: r.ok, stderr: r.stderr, ...(r.ok ? { published: true } : {}) }
}

/**
 * Discard working-tree changes for `paths`, restoring each to HEAD. Per path
 * (so one untracked file can't abort the whole batch): unstage, then either
 * `checkout HEAD` for a tracked file or `clean` for an untracked one. Verifies
 * the paths are clean afterward. Destructive and irreversible — the caller
 * confirms first.
 */
export async function discardPaths(cwd: string, paths: string[]): Promise<{ ok: boolean; stderr: string }> {
  if (paths.length === 0) return { ok: false, stderr: 'No files selected.' }
  const errors: string[] = []
  for (const path of paths) {
    await tryGit(cwd, ['reset', '-q', 'HEAD', '--', path]) // unstage (no-op if nothing staged)
    const restored = await tryGit(cwd, ['checkout', 'HEAD', '--', path]) // restore a tracked file
    if (!restored.ok) {
      // Not in HEAD → it's a new/untracked file; remove it from the working tree.
      const cleaned = await tryGit(cwd, ['clean', '-fd', '--', path])
      if (!cleaned.ok) errors.push(cleaned.stderr.trim() || restored.stderr.trim())
    }
  }
  const remaining = (await git(cwd, ['status', '--porcelain', '--', ...paths])).trim()
  if (remaining) return { ok: false, stderr: errors.length ? errors.join('\n') : `Could not fully discard:\n${remaining}` }
  return { ok: true, stderr: '' }
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
