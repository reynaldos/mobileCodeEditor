import { lineDiff, type DiffSubject, type RowKind } from '../diff.ts'

const SIGIL: Record<RowKind, string> = { context: ' ', added: '+', removed: '-', gap: '' }

const ROW: Record<RowKind, string> = {
  context: '',
  added: 'bg-add-bg',
  removed: 'bg-del-bg',
  gap: 'bg-panel-2 text-muted text-[11px] pl-5',
}

const SIGIL_COLOR: Record<RowKind, string> = {
  context: 'text-muted',
  added: 'text-add',
  removed: 'text-del',
  gap: 'text-muted',
}

/**
 * Unified, never side-by-side. Two columns at 390px is unreadable.
 * See DECISIONS #9.
 */
export function DiffView({ subject }: { subject: DiffSubject }): React.JSX.Element {
  const rows = lineDiff(subject.before, subject.after)

  return (
    <div className="mt-2.5 border-t border-line">
      {subject.filePath && (
        <div className="overflow-x-auto whitespace-nowrap bg-panel-2 px-3 py-1.5 font-mono text-[11px] text-muted">
          {subject.filePath}
        </div>
      )}

      {/* Wide lines scroll inside the diff. The page never scrolls sideways. */}
      <pre className="scroll-cap m-0 overflow-x-auto font-mono text-xs leading-[1.55]">
        {rows.map((row, index) => (
          <div key={index} className={`flex min-w-max pr-3 ${ROW[row.kind]}`}>
            <span className={`w-5 shrink-0 select-none text-center ${SIGIL_COLOR[row.kind]}`}>
              {SIGIL[row.kind]}
            </span>
            <span className="whitespace-pre">{row.text || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}
