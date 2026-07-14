import { useLayoutEffect, useRef } from 'react'
import { cn } from '../lib/utils.ts'

/**
 * A `<textarea>` that renders `@file/path` references as a blue highlight — the
 * affordance that lets someone see, mid-sentence, that a prompt references a
 * file (like the Claude editor extension's `@` mentions).
 *
 * A textarea can't style its own text, so this is the standard backdrop trick:
 * an aria-hidden div renders the same string with the references wrapped in
 * colored spans, and the real textarea sits exactly on top with transparent
 * text but a visible caret. The two layers MUST share identical typography,
 * padding, and wrapping (see `fieldClassName`) or the highlight drifts off the
 * characters — so the highlight spans carry only color, never any box metrics.
 *
 * The textarea node itself is never remounted by this component, which matters:
 * PromptBox documents that mid-keystroke DOM churn corrupts the iOS text input
 * session. Only the sibling backdrop re-renders as you type.
 */

// `@` followed by a path, only at a word boundary (start of input or after
// whitespace) so `foo@bar` emails don't light up. A capture group is used
// instead of a lookbehind for older-iOS-Safari safety.
const REF_RE = /(^|\s)(@[\w./-]+)/g

function renderWithRefs(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  REF_RE.lastIndex = 0
  while ((m = REF_RE.exec(text))) {
    const ref = m[2] ?? ''
    const refStart = m.index + (m[1]?.length ?? 0)
    if (refStart > last) nodes.push(text.slice(last, refStart))
    nodes.push(
      // Color only — no padding/margin/letter-spacing, or the text below shifts.
      <span key={key++} className="rounded bg-accent/25 text-accent">
        {ref}
      </span>,
    )
    last = refStart + ref.length
  }
  // Trailing remainder (may be ''), so a trailing newline still contributes a line.
  nodes.push(text.slice(last))
  return nodes
}

export function HighlightedInput({
  textareaRef,
  value,
  fieldClassName,
  textareaClassName,
  wrapperClassName,
  wrapperStyle,
  ...textareaProps
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  /** Typography + padding shared by BOTH layers — the alignment contract. */
  fieldClassName: string
  /** Textarea-only sizing/scroll (e.g. `max-h-40 min-h-9` or `h-full`). */
  textareaClassName?: string
  wrapperClassName?: string
  wrapperStyle?: React.CSSProperties
} & Omit<React.ComponentProps<'textarea'>, 'value' | 'ref' | 'className' | 'style'>): React.JSX.Element {
  const backdropRef = useRef<HTMLDivElement>(null)

  // Keep the backdrop's scroll offset locked to the textarea's, so a scrolled
  // (capped-height or expanded) field stays aligned with its highlights.
  const syncScroll = (): void => {
    const ta = textareaRef.current
    const bd = backdropRef.current
    if (!ta || !bd) return
    bd.scrollTop = ta.scrollTop
    bd.scrollLeft = ta.scrollLeft
  }
  useLayoutEffect(syncScroll)

  return (
    <div className={cn('relative', wrapperClassName)} style={wrapperStyle}>
      <div
        ref={backdropRef}
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words text-fg',
          fieldClassName,
        )}
      >
        {renderWithRefs(value)}
      </div>
      <textarea
        {...textareaProps}
        ref={textareaRef}
        value={value}
        onScroll={syncScroll}
        style={{ caretColor: 'var(--color-fg)' }}
        className={cn(
          'relative z-[1] block w-full resize-none bg-transparent text-transparent caret-fg outline-none placeholder:text-muted',
          fieldClassName,
          textareaClassName,
        )}
      />
    </div>
  )
}
