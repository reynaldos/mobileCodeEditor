import { useEffect, useState } from 'react'
import { currentPushState, enablePush, type PushState } from '../push.ts'

const CHIP = 'h-8 shrink-0 whitespace-nowrap rounded-lg border px-3 text-[13px] disabled:opacity-50'

/**
 * "Enable notifications", shown only when it can actually do something.
 *
 * The iOS rules, all enforced here rather than discovered at runtime:
 *  - requestPermission must run inside this click, never on mount.
 *  - it only works as an installed PWA; in a Safari tab we explain instead.
 *  - a denial is close to permanent, so once denied or granted the button goes away.
 */
export function NotificationsButton(): React.JSX.Element | null {
  const [state, setState] = useState<PushState>(() => currentPushState())
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState(false)

  // Re-read after returning to the tab: the user may have installed the PWA.
  useEffect(() => {
    const onVisible = (): void => setState(currentPushState())
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Nothing to offer: already on, hard-denied, or the browser can't do push.
  if (state === 'granted' || state === 'denied' || state === 'unsupported') return null

  if (state === 'needs-install') {
    // The API exists but iOS won't grant from a tab. A button would silently do
    // nothing, so show a hint instead of a broken control.
    return (
      <>
        <button className={`${CHIP} border-line bg-panel-2 text-muted`} onClick={() => setHint((h) => !h)}>
          🔔
        </button>
        {hint && (
          <span className="absolute right-3 top-14 z-10 max-w-[240px] rounded-lg border border-line bg-panel-2 p-2.5 text-xs text-muted shadow-lg">
            To get notified when Claude needs you, add this to your home screen: Share →
            Add to Home Screen, then open it from there.
          </span>
        )}
      </>
    )
  }

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
      className={`${CHIP} border-accent bg-transparent font-medium text-accent`}
      disabled={busy}
      onClick={() => void enable()}
      title="Get notified when Claude needs you"
    >
      {busy ? '…' : '🔔 Enable'}
    </button>
  )
}
