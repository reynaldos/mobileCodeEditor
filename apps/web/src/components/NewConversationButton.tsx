import { useEffect, useState } from 'react'
import { startNewConversation } from '../api.ts'

/**
 * Two taps, not a `window.confirm`.
 *
 * Resetting is cheap to do by accident and expensive to undo — Claude forgets
 * everything, and there is no un-reset. A modal in a standalone PWA is a jarring
 * system sheet; an inline confirm that times out is the phone-native answer.
 */
const CONFIRM_TIMEOUT_MS = 4_000

/* 32px tall, under the 44px touch minimum on purpose: destructive, and two taps. */
const CHIP = 'h-8 shrink-0 whitespace-nowrap rounded-lg border px-3 text-[13px] disabled:opacity-50'

export function NewConversationButton({ busy }: { busy: boolean }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)

  // Change your mind by doing nothing, which is how most minds get changed.
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  async function reset(): Promise<void> {
    setSending(true)
    try {
      await startNewConversation()
      // The `conversation_reset` event arrives over SSE and clears the view.
    } finally {
      setSending(false)
      setConfirming(false)
    }
  }

  if (!confirming) {
    return (
      <button
        className={`${CHIP} border-line bg-panel-2 text-fg`}
        onClick={() => setConfirming(true)}
        title="Start a new conversation"
      >
        New
      </button>
    )
  }

  return (
    <span className="flex gap-1.5">
      <button
        className={`${CHIP} border-[#4a2326] bg-transparent font-semibold text-del`}
        disabled={sending}
        onClick={() => void reset()}
      >
        {sending ? '…' : busy ? 'Stop & start over' : 'Start over'}
      </button>
      <button
        className={`${CHIP} border-line bg-panel-2 px-2.5 text-muted`}
        onClick={() => setConfirming(false)}
      >
        ✕
      </button>
    </span>
  )
}
