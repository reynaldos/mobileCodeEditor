import type { Event } from '@mce/protocol'
import { useEffect, useReducer, useState } from 'react'
import { eventStreamUrl, reportVisibility } from './api.ts'
import { initialState, reduce, type State } from './events.ts'

export type Connection = 'connecting' | 'live' | 'reconnecting'

const CLIENT_ID_KEY = 'mce.clientId'

/**
 * A random id for this tab, reused across reloads via localStorage so the
 * server's Presence tracker (presence.ts) can tell "this tab is still here,
 * just reconnecting" from "a different tab." Falls back to a per-mount id if
 * storage is unavailable (private browsing) — presence still works, it just
 * can't survive a reload of that one tab.
 */
function clientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY)
    if (existing) return existing
    const fresh = crypto.randomUUID()
    localStorage.setItem(CLIENT_ID_KEY, fresh)
    return fresh
  } catch {
    return crypto.randomUUID()
  }
}

/**
 * `EventSource` reconnects on its own and resends `Last-Event-ID` — the seq of
 * the last event it saw. The server replays from there. We write none of that.
 *
 * This is the whole reason iOS suspending a backgrounded page is survivable.
 * See DECISIONS #6.
 */
export function useEventStream(): { state: State; connection: Connection } {
  const [state, dispatch] = useReducer(reduce, initialState)
  const [connection, setConnection] = useState<Connection>('connecting')

  useEffect(() => {
    const id = clientId()
    const source = new EventSource(eventStreamUrl(id))

    const reportCurrentVisibility = (): void => {
      reportVisibility(id, document.visibilityState === 'visible')
    }

    source.onopen = () => {
      setConnection('live')
      // Re-assert on every open, including reconnects. The server clears this
      // tab's presence when its connection drops (routes/events.ts), so after
      // a network blip a still-visible tab must say so again — otherwise it
      // sits marked "not visible" until the next real visibilitychange, and a
      // push that should've been suppressed goes through.
      reportCurrentVisibility()
    }

    source.onmessage = (message) => {
      setConnection('live')
      try {
        dispatch(JSON.parse(message.data) as Event)
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    }

    // Fires on every drop. The browser is already retrying; say so and wait.
    source.onerror = () => setConnection('reconnecting')

    document.addEventListener('visibilitychange', reportCurrentVisibility)

    return () => {
      document.removeEventListener('visibilitychange', reportCurrentVisibility)
      source.close()
    }
  }, [])

  return { state, connection }
}

/**
 * The virtual keyboard does not resize the layout viewport, so `100vh` is a lie
 * whenever it is open. Track the visual viewport and let CSS use the truth.
 *
 * Also measures `window.innerHeight` into `--app-height`, independent of the
 * keyboard tracking below. An installed (home-screen) iOS PWA is known to
 * freeze the `100dvh` unit at a stale value — typically whatever it last
 * measured while the keyboard was open — leaving a dead strip of bare black
 * background below the app instead of the unit tracking back to the real
 * full-screen height once the keyboard closes. Writing our own measurement
 * sidesteps that browser bug; styles.css falls back to `100dvh` until this
 * effect has run.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const updateAppHeight = (): void => {
      document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`)
    }
    updateAppHeight()
    window.addEventListener('resize', updateAppHeight)
    window.addEventListener('orientationchange', updateAppHeight)

    const viewport = window.visualViewport
    const updateKeyboardInset = (): void => {
      if (!viewport) return
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`)
    }
    updateKeyboardInset()
    viewport?.addEventListener('resize', updateKeyboardInset)
    viewport?.addEventListener('scroll', updateKeyboardInset)

    return () => {
      window.removeEventListener('resize', updateAppHeight)
      window.removeEventListener('orientationchange', updateAppHeight)
      viewport?.removeEventListener('resize', updateKeyboardInset)
      viewport?.removeEventListener('scroll', updateKeyboardInset)
    }
  }, [])
}
