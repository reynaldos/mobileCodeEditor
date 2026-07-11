import type { Question } from '@mce/protocol'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { ApiError, answerQuestion } from '../api.ts'
import type { Item } from '../events.ts'

type QuestionItem = Extract<Item, { kind: 'question' }>

/**
 * The agent's AskUserQuestion, answered inline. Like the approval card, it blocks
 * the turn and sticks to the bottom while pending. Questions are shown one at a
 * time behind a tab strip: picking a single-select answer auto-advances to the
 * next unanswered tab, and any tab can be revisited to change its answer.
 * Single- or multi-select per question, plus a freeform "Other". Answers post
 * back keyed by question text.
 */
export function QuestionCard({ item }: { item: QuestionItem }): React.JSX.Element {
  const [picks, setPicks] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [active, setActive] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const pending = item.status === 'pending'
  const activeIndex = Math.min(active, item.questions.length - 1)

  function valueFor(i: number): string {
    const chosen = picks[i] ?? []
    const extra = (other[i] ?? '').trim()
    return [...chosen, ...(extra ? [extra] : [])].join(', ')
  }
  const allAnswered = item.questions.every((_, i) => valueFor(i).length > 0)

  function choose(i: number, label: string, multi: boolean): void {
    setPicks((prev) => {
      const current = prev[i] ?? []
      if (multi) {
        const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
        return { ...prev, [i]: next }
      }
      return { ...prev, [i]: [label] }
    })
    if (!multi) {
      setOther((prev) => ({ ...prev, [i]: '' }))
      // Single-select answers are complete in one click — jump to the next
      // question that still needs an answer (or just the next tab).
      setActive((prevActive) => {
        if (prevActive !== i || i >= item.questions.length - 1) return prevActive
        return i + 1
      })
    }
  }

  function changeOther(i: number, text: string, multi: boolean): void {
    setOther((prev) => ({ ...prev, [i]: text }))
    if (!multi && text) setPicks((prev) => ({ ...prev, [i]: [] }))
  }

  async function submit(): Promise<void> {
    setSending(true)
    setError(undefined)
    const answers: Record<string, string> = {}
    item.questions.forEach((q, i) => {
      answers[q.question] = valueFor(i)
    })
    try {
      await answerQuestion(item.requestId, answers)
      // The status change arrives over SSE.
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'Already answered, or the server restarted.'
          : err instanceof Error
            ? err.message
            : String(err),
      )
      setSending(false)
    }
  }

  const skin = pending ? 'approval-pending border-accent bg-panel' : 'border-line bg-panel opacity-80'

  return (
    <div className={`overflow-hidden rounded-xl border ${skin}`}>
      <div className="px-3 pt-2.5 text-[11px] uppercase tracking-[0.08em] text-muted">
        {pending ? 'Claude is asking' : item.status === 'answered' ? 'Answered' : 'Question dismissed'}
      </div>

      <div className="flex flex-col gap-3 p-3">
        {item.questions.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="tablist">
            {item.questions.map((q, i) => {
              const answered = valueFor(i).length > 0
              const current = i === activeIndex
              return (
                <button
                  key={i}
                  role="tab"
                  aria-selected={current}
                  className={`flex min-h-8 items-center gap-1 rounded-full border px-2.5 text-[12px] ${
                    current
                      ? 'border-accent bg-accent/10 text-fg'
                      : answered
                        ? 'border-line bg-panel-2 text-fg'
                        : 'border-line bg-panel-2 text-muted'
                  }`}
                  onClick={() => setActive(i)}
                >
                  {answered && <Check className="size-3" />}
                  {q.header || `Q${i + 1}`}
                </button>
              )
            })}
          </div>
        )}

        {item.questions.map((q, i) => (
          <div key={i} className={i === activeIndex ? '' : 'hidden'}>
            <QuestionBlock
              q={q}
              picks={picks[i] ?? []}
              other={other[i] ?? ''}
              answer={item.status === 'answered' ? item.answers?.[q.question] : undefined}
              disabled={!pending || sending}
              onChoose={(label) => choose(i, label, q.multiSelect)}
              onOther={(text) => changeOther(i, text, q.multiSelect)}
            />
          </div>
        ))}

        {error && <p className="text-[13px] text-del">{error}</p>}

        {pending && (
          <button
            className="min-h-11 rounded-[10px] border border-accent bg-accent font-semibold text-[#06101f] disabled:opacity-50"
            disabled={sending || !allAnswered}
            onClick={() => void submit()}
          >
            {sending ? 'Sending…' : 'Submit'}
          </button>
        )}
      </div>
    </div>
  )
}

function QuestionBlock({
  q,
  picks,
  other,
  answer,
  disabled,
  onChoose,
  onOther,
}: {
  q: Question
  picks: string[]
  other: string
  answer?: string
  disabled: boolean
  onChoose: (label: string) => void
  onOther: (text: string) => void
}): React.JSX.Element {
  return (
    <div>
      <p className="mb-2 font-medium">{q.question}</p>

      {answer !== undefined ? (
        <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] text-fg">{answer}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {q.options.map((o) => {
            const selected = picks.includes(o.label)
            return (
              <button
                key={o.label}
                disabled={disabled}
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left disabled:opacity-60 ${
                  selected ? 'border-accent bg-accent/10' : 'border-line bg-panel-2'
                }`}
                onClick={() => onChoose(o.label)}
              >
                <span
                  className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
                    selected ? 'border-accent bg-accent text-[#06101f]' : 'border-line'
                  }`}
                >
                  {selected && <Check className="size-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] text-fg">{o.label}</span>
                  {o.description && <span className="block text-[12px] text-muted">{o.description}</span>}
                </span>
              </button>
            )
          })}

          <input
            className="min-h-10 rounded-lg border border-line bg-panel-2 px-3 text-[16px] text-fg outline-none focus:border-accent disabled:opacity-60"
            placeholder="Other…"
            value={other}
            disabled={disabled}
            onChange={(e) => onOther(e.target.value)}
          />
        </div>
      )}
    </div>
  )
}
