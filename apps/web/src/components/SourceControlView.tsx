import type { ChangedFile, GitStatusResponse } from '@mce/protocol'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchFileDiff, fetchGitStatus } from '../api.ts'
import { DiffView } from './DiffView.tsx'

interface Props {
  projectId: string
}

/**
 * Read-only working-tree-vs-HEAD changes list (PHASE-3.md design call 4).
 * Staging, commit, and push are Phase 6 — this is browse-only, reusing the
 * same `DiffView` the post-turn changes accordion already renders.
 */
export function SourceControlView({ projectId }: Props): React.JSX.Element {
  const [status, setStatus] = useState<GitStatusResponse | null>(null)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    setError(false)
    setExpanded(new Set())
    void fetchGitStatus(projectId)
      .then((r) => !cancelled && setStatus(r))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [projectId])

  if (error) return <p className="p-4 text-center text-[13px] text-del">Could not load git status.</p>
  if (!status) return <p className="p-4 text-center text-[13px] text-muted">Loading…</p>
  if (status.files.length === 0) return <p className="p-4 text-center text-[13px] text-muted">No changes.</p>

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <p className="px-4 py-2 text-[12px] text-muted">
        {status.files.length} file{status.files.length === 1 ? '' : 's'} changed. Read-only — staging, commit, and push
        aren&rsquo;t here yet.
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
