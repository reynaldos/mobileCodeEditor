import { useState } from 'react'
import { sendPrompt } from '../api.ts'

export function PromptBox({
  projectId,
  threadId,
  disabledReason,
}: {
  projectId: string | null
  threadId: string | null
  disabledReason?: string
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const ready = Boolean(projectId && threadId && !disabledReason)

  async function submit(): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || sending || !projectId || !threadId || !ready) return

    setSending(true)
    setError(undefined)
    try {
      await sendPrompt(trimmed, projectId, threadId)
      setText('')
      // The `user_prompt` event comes back over SSE and renders itself.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    // `prompt-bar` is targeted by a :has() rule that drops the safe-area padding
    // once the keyboard has lifted the app. See styles.css.
    <div className="prompt-bar shrink-0 border-t border-line bg-panel px-3 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))]">
      {error && <p className="mb-2 text-[13px] text-del">{error}</p>}

      <div className="flex items-end gap-2">
        <textarea
          className="prompt-input max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-line bg-panel-2 px-3 py-2.5 text-fg outline-none focus:border-accent"
          value={text}
          rows={1}
          disabled={!ready}
          placeholder={ready ? 'What should Claude do?' : (disabledReason ?? 'Pick a project and thread')}
          // Enter inserts a newline on a phone keyboard. Sending is a button.
          onChange={(e) => setText(e.target.value)}
          onInput={(e) => {
            const el = e.currentTarget
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`
          }}
        />
        <button
          className="min-h-11 w-18 shrink-0 rounded-xl border border-accent bg-accent font-semibold text-[#06101f] disabled:opacity-50"
          disabled={sending || !text.trim() || !ready}
          onClick={() => void submit()}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
