import { useState } from 'react'
import { sendPrompt } from '../api.ts'

export function PromptBox(): React.JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  async function submit(): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || sending) return

    setSending(true)
    setError(undefined)
    try {
      await sendPrompt(trimmed)
      setText('')
      // The `user_prompt` event comes back over SSE and renders itself.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="prompt">
      {error && <p className="prompt-error">{error}</p>}
      <div className="prompt-row">
        <textarea
          className="prompt-input"
          value={text}
          rows={1}
          placeholder="What should Claude do?"
          // Enter inserts a newline on a phone keyboard. Sending is a button.
          onChange={(e) => setText(e.target.value)}
          onInput={(e) => {
            const el = e.currentTarget
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`
          }}
        />
        <button
          className="btn btn-send"
          disabled={sending || !text.trim()}
          onClick={() => void submit()}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
