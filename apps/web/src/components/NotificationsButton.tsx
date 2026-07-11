import { Bell } from 'lucide-react'
import { useEffect, useState } from 'react'
import { currentPushState, enablePush } from '../push.ts'

/**
 * "Enable notifications" — shown ONLY when it's worth showing: an installed PWA
 * whose permission hasn't been set yet.
 *
 * `currentPushState()` returns 'default' exactly in that case (standalone display
 * mode + Notification.permission === 'default'). Every other state — a plain
 * Safari tab (needs-install), already granted, already denied, or unsupported —
 * renders nothing. A denial is close to permanent on iOS, so once set the button
 * never returns.
 */
export function NotificationsButton(): React.JSX.Element | null {
  const [state, setState] = useState(() => currentPushState())
  const [busy, setBusy] = useState(false)

  // Re-read on return to the tab: the user may have just installed the PWA, which
  // flips 'needs-install' → 'default' and makes this button appear.
  useEffect(() => {
    const onVisible = (): void => setState(currentPushState())
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  if (state !== 'default') return null

  async function enable(): Promise<void> {
    setBusy(true)
    try {
      setState(await enablePush())
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-accent bg-transparent px-3 text-[13px] font-medium text-accent disabled:opacity-50"
      disabled={busy}
      onClick={() => void enable()}
      title="Get notified when Claude needs you"
    >
      <Bell className="size-4" />
      {busy ? 'Enabling…' : 'Enable'}
    </button>
  )
}
