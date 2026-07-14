import type { ChangedFile, GitRefreshResponse, GitStatusResponse, GitUpstream } from '@mce/protocol'
import { AlertTriangle, ChevronDown, ChevronRight, GitBranch, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fetchFileDiff, fetchGitStatus, refreshBranch } from '../api.ts'
import { DiffView } from './DiffView.tsx'

interface Props {
  projectId: string
}

/**
 * Read-only working-tree-vs-HEAD changes list (PHASE-3.md design call 4), plus
 * a narrow branch-sync affordance: when the branch tracks a remote, a Refresh
 * button fetches and fast-forwards it. Staging, commit, push, stash, and any
 * conflict/merge/rebase handling are Phase 6 — see the note in PHASE-3.md.
 */
export function SourceControlView({ projectId }: Props): React.JSX.Element {
  const [status, setStatus] = useState<GitStatusResponse | null>(null)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    return fetchGitStatus(projectId)
      .then((r) => setStatus(r))
      .catch(() => setError(true))
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    setError(false)
    setExpanded(new Set())
    setNotice(null)
    void fetchGitStatus(projectId)
      .then((r) => !cancelled && setStatus(r))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [projectId])

  const dirty = (status?.files.length ?? 0) > 0

  async function onRefresh(): Promise<void> {
    setRefreshing(true)
    setNotice(null)
    try {
      const r = await refreshBranch(projectId)
      setNotice(refreshNotice(r))
      if (r.upstream) setStatus((s) => (s ? { ...s, upstream: r.upstream } : s))
      if (r.ok) await load() // fast-forward moved HEAD — reload base + file list
    } catch {
      setNotice('Couldn’t reach the remote.')
    } finally {
      setRefreshing(false)
    }
  }

  if (error) return <p className="p-4 text-center text-[13px] text-del">Could not load git status.</p>
  if (!status) return <p className="p-4 text-center text-[13px] text-muted">Loading…</p>

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {status.upstream && (
        <BranchSync
          upstream={status.upstream}
          dirty={dirty}
          refreshing={refreshing}
          notice={notice}
          onRefresh={() => void onRefresh()}
        />
      )}

      {dirty ? (
        <>
          <p className="px-4 py-2 text-[12px] text-muted">
            {status.files.length} file{status.files.length === 1 ? '' : 's'} changed. Read-only — staging, commit, and
            push aren&rsquo;t here yet.
          </p>
          <ul className="flex flex-col">
            {status.files.map((f) => (
              <ChangedFileRow
                key={f.path}
                projectId={projectId}
                file={f}
                base={status.base}
                open={expanded.has(f.path)}
                onToggle={() =>
                  setExpanded((cur) => {
                    const next = new Set(cur)
                    if (next.has(f.path)) next.delete(f.path)
                    else next.add(f.path)
                    return next
                  })
                }
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="p-4 text-center text-[13px] text-muted">No changes.</p>
      )}
    </div>
  )
}

/** Turns a refresh result into a one-line status message for the sync row. */
function refreshNotice(r: GitRefreshResponse): string {
  if (r.ok) return 'Branch is up to date with the remote.'
  switch (r.reason) {
    case 'dirty':
      return 'You have uncommitted changes — commit or stash them before refreshing.'
    case 'diverged':
      return 'Your branch and the remote have both moved — this needs a manual merge or rebase (full source control is coming later).'
    case 'no-upstream':
      return 'This branch doesn’t track a remote.'
    default:
      return r.error ?? 'Couldn’t reach the remote.'
  }
}

/**
 * The branch-sync header: how the local branch sits against its remote, and a
 * Refresh (fetch + fast-forward) button. Refresh is blocked while the tree is
 * dirty — fast-forwarding over uncommitted work is exactly the "breaking" case
 * to avoid, so it asks you to commit or stash first.
 */
function BranchSync({
  upstream,
  dirty,
  refreshing,
  notice,
  onRefresh,
}: {
  upstream: GitUpstream
  dirty: boolean
  refreshing: boolean
  notice: string | null
  onRefresh: () => void
}): React.JSX.Element {
  const behind = upstream.behind
  const summary =
    behind > 0
      ? `${behind} commit${behind === 1 ? '' : 's'} behind ${upstream.name}`
      : upstream.ahead > 0
        ? `Up to date with ${upstream.name} · ${upstream.ahead} ahead`
        : `Up to date with ${upstream.name}`

  return (
    <div className="border-b border-line px-4 py-2.5">
      <div className="flex items-center gap-2">
        <GitBranch className="size-3.5 shrink-0 text-muted" />
        <span className={`min-w-0 flex-1 truncate text-[12px] ${behind > 0 ? 'text-warn' : 'text-muted'}`}>{summary}</span>
        <button
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-panel-2 disabled:opacity-50"
          disabled={dirty || refreshing}
          onClick={onRefresh}
        >
          <RotateCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {dirty && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>Commit or stash your changes before refreshing the branch.</span>
        </p>
      )}
      {notice && !dirty && <p className="mt-2 text-[11px] text-muted">{notice}</p>}
    </div>
  )
}

const STATUS_LABEL: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }
const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-add',
  modified: 'text-accent',
  deleted: 'text-del',
  renamed: 'text-muted',
}

function ChangedFileRow({
  projectId,
  file,
  base,
  open,
  onToggle,
}: {
  projectId: string
  file: ChangedFile
  base: string | undefined
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const [diff, setDiff] = useState<{ before: string; after: string } | null>(null)

  useEffect(() => {
    if (!open || diff || !base) return
    void fetchFileDiff(projectId, base, file.path)
      .then((r) => setDiff(r))
      .catch(() => setDiff({ before: '', after: '' }))
  }, [open, diff, base, projectId, file.path])

  return (
    <li className="border-b border-line">
      <button className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-panel-2" onClick={onToggle}>
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted" />
        )}
        <span className={`w-4 shrink-0 text-center text-[11px] font-semibold ${STATUS_COLOR[file.status]}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{file.path}</span>
        <span className="shrink-0 text-[11px] tabular-nums">
          <span className="text-add">+{file.additions}</span> <span className="text-del">-{file.deletions}</span>
        </span>
      </button>
      {open &&
        (diff ? (
          <DiffView subject={{ filePath: file.path, before: diff.before, after: diff.after }} />
        ) : (
          <p className="px-4 pb-3 text-[12px] text-muted">Loading diff…</p>
        ))}
    </li>
  )
}
