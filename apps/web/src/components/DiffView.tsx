import { lineDiff, type DiffSubject } from '../diff.ts'

const SIGIL = { context: ' ', added: '+', removed: '-', gap: '' } as const

/**
 * Unified, never side-by-side. Two columns at 390px is unreadable.
 * See DECISIONS #9.
 */
export function DiffView({ subject }: { subject: DiffSubject }): React.JSX.Element {
  const rows = lineDiff(subject.before, subject.after)

  return (
    <div className="diff">
      {subject.filePath && <div className="diff-path">{subject.filePath}</div>}
      <pre className="diff-body">
        {rows.map((row, index) => (
          <div key={index} className={`diff-row diff-${row.kind}`}>
            <span className="diff-sigil">{SIGIL[row.kind]}</span>
            <span className="diff-text">{row.text || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}
