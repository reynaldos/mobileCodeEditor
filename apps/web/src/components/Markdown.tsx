import { Check } from 'lucide-react'

/**
 * A small, dependency-free Markdown-ish renderer for assistant replies.
 *
 * Claude's replies arrive as a complete markdown string — headings, bold
 * labels, numbered/bulleted lists, inline code. Rendering that as literal
 * `**text**` / `##` / `1. ` inside a `white-space: pre-wrap` block (the old
 * behavior) is what made replies hard to skim. This covers the subset Claude
 * actually uses in chat, not full CommonMark: headings, bold, inline code,
 * and ordered/unordered lists.
 */

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = re.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    if (match[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{match[1]}</strong>)
    } else if (match[2] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-${i++}`} className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[0.9em]">
          {match[2]}
        </code>,
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[16px] font-semibold',
  2: 'text-[15px] font-semibold',
  3: 'text-[14px] font-semibold',
  4: 'text-[13px] font-semibold',
}

const HEADING_RE = /^(#{1,4})\s+(.*)$/
const ORDERED_RE = /^\d+[.)]\s+(.*)$/
const BULLET_RE = /^[-*]\s+(.*)$/
/** A bullet item's content, as a task: `[ ]`/`[x]` (GitHub) or the bare `[]` the model often writes. */
const TASK_ITEM_RE = /^\[([ xX]?)\]\s+(.*)$/
const FENCE_RE = /^```(\S*)$/
const STRUCTURAL_RE = [HEADING_RE, ORDERED_RE, BULLET_RE]
const isStructural = (line: string): boolean => STRUCTURAL_RE.some((re) => re.test(line))

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined) break
    if (!line.trim()) {
      i++
      continue
    }

    const fence = FENCE_RE.exec(line.trim())
    if (fence) {
      const lang = fence[1] ?? ''
      const rows: string[] = []
      i++
      while (i < lines.length) {
        const cur = lines[i]
        if (cur === undefined || FENCE_RE.test(cur.trim())) {
          i++
          break
        }
        rows.push(cur)
        i++
      }
      const k = key++
      blocks.push(
        <div key={k} className="overflow-hidden rounded-md border border-line bg-panel-2">
          {lang && (
            <div className="border-b border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-muted">
              {lang}
            </div>
          )}
          <pre className="overflow-x-auto p-2.5 font-mono text-[12.5px] leading-snug">
            <code>{rows.join('\n')}</code>
          </pre>
        </div>,
      )
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = heading[1]?.length ?? 1
      const k = key++
      blocks.push(
        <p key={k} className={HEADING_CLASS[level]}>
          {renderInline(heading[2] ?? '', `h${k}`)}
        </p>,
      )
      i++
      continue
    }

    if (ORDERED_RE.test(line)) {
      const rows: string[] = []
      let next = lines[i]
      while (i < lines.length && next !== undefined) {
        const m = ORDERED_RE.exec(next)
        if (!m) break
        rows.push(m[1] ?? '')
        i++
        next = lines[i]
      }
      const k = key++
      blocks.push(
        <ol key={k} className="list-decimal space-y-1 pl-5">
          {rows.map((r, j) => (
            <li key={j}>{renderInline(r, `ol${k}-${j}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    if (BULLET_RE.test(line)) {
      const rows: string[] = []
      let next = lines[i]
      while (i < lines.length && next !== undefined) {
        const m = BULLET_RE.exec(next)
        if (!m) break
        rows.push(m[1] ?? '')
        i++
        next = lines[i]
      }
      const k = key++
      // A checklist (task items) renders as checkboxes, not disc bullets.
      const tasks = rows.map((r) => TASK_ITEM_RE.exec(r))
      if (tasks.some(Boolean)) {
        blocks.push(
          <ul key={k} className="flex flex-col gap-1">
            {rows.map((r, j) => {
              const m = tasks[j]
              if (!m) return <li key={j} className="pl-6">{renderInline(r, `tl${k}-${j}`)}</li>
              const checked = m[1] === 'x' || m[1] === 'X'
              return (
                <li key={j} className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                      checked ? 'border-add bg-add/20 text-add' : 'border-line text-transparent'
                    }`}
                  >
                    <Check className="size-3" />
                  </span>
                  <span className={checked ? 'text-muted line-through' : ''}>{renderInline(m[2] ?? '', `tl${k}-${j}`)}</span>
                </li>
              )
            })}
          </ul>,
        )
        continue
      }
      blocks.push(
        <ul key={k} className="list-disc space-y-1 pl-5">
          {rows.map((r, j) => (
            <li key={j}>{renderInline(r, `ul${k}-${j}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // Plain paragraph: consecutive non-blank, non-structural lines. Joined
    // with real line breaks, not merged into flowing text — short replies
    // often use newlines deliberately.
    const rows: string[] = []
    let next = lines[i]
    while (i < lines.length && next !== undefined && next.trim() && !isStructural(next)) {
      rows.push(next)
      i++
      next = lines[i]
    }
    const k = key++
    blocks.push(
      <p key={k}>
        {rows.map((r, j) => (
          <span key={j}>
            {j > 0 && <br />}
            {renderInline(r, `p${k}-${j}`)}
          </span>
        ))}
      </p>,
    )
  }

  return <div className="flex flex-col gap-2">{blocks}</div>
}
