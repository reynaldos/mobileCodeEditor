import type { ChangedFile } from '@mce/protocol'
import { ChevronRight, Loader } from 'lucide-react'
import { useState } from 'react'
import { fetchFileDiff } from '../api.ts'
import type { DiffSubject } from '../diff.ts'
import { DiffView } from './DiffView.tsx'

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}
const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-add',
  modified: 'text-warn',
  deleted: 'text-del',
  renamed: 'text-accent',
}

const sum = (files: ChangedFile[], key: 'additions' | 'deletions'): number =>
  files.reduce((n, f) => n + f[key], 0)

/**
 * The post-turn changes summary: a GitHub-style list of files a turn touched,
 * each expandable to its diff. The list + counts come from the durable
 * `turn_changes` event; each diff body is fetched lazily on expand.
 */
export function ChangesView({
  base,
  files,
  projectId,
}: {
  base: string
  files: ChangedFile[]
  projectId?: string
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[13px] font-medium">
          Changes <span className="text-muted">{files.length}</span>
        </span>
        <span className="font-mono text-[12px]">
          <span className="text-add">+{sum(files, 'additions')}</span>{' '}
          <span className="text-del">−{sum(files, 'deletions')}</span>
        </span>
      </div>
      <ul>
        {files.map((f) => (
          <FileRow key={f.path} file={f} base={base} projectId={projectId} />
        ))}
      </ul>
    </div>
  )
}

function FileRow({
  file,
  base,
  projectId,
}: {
  file: ChangedFile
  base: string
  projectId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<DiffSubject | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  async function toggle(): Promise<void> {
    const next = !open
    setOpen(next)
    if (!next || diff || loading || !projectId) return
    setLoading(true)
    setError(undefined)
    try {
      const r = await fetchFileDiff(projectId, base, file.path)
      setDiff({ before: r.before, after: r.after, filePath: file.path })
    } catch {
      setError('Could not load this diff.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <li className="border-t border-line">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-panel-2" onClick={() => void toggle()}>
        <ChevronRight className={`size-3.5 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={`w-3 shrink-0 text-center font-mono text-[12px] ${STATUS_COLOR[file.status]}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{file.path}</span>
        <span className="shrink-0 font-mono text-[11px]">
          {file.additions > 0 && <span className="text-add">+{file.additions}</span>}{' '}
          {file.deletions > 0 && <span className="text-del">−{file.deletions}</span>}
        </span>
      </button>

      {open && (
        <div className="border-t border-line">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted">
              <Loader className="size-3.5 animate-spin" /> loading diff…
            </div>
          )}
          {error && <p className="px-3 py-3 text-[12px] text-del">{error}</p>}
          {diff && <DiffView subject={diff} />}
        </div>
      )}
    </li>
  )
}
