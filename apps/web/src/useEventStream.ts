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

    const viewport = window.visualViewport
    const updateKeyboardInset = (): void => {
      if (!viewport) return
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`)
    }

    const updateAll = (): void => {
      updateAppHeight()
      updateKeyboardInset()
    }
    updateAll()

    // A cold launch of an installed iOS PWA reads `window.innerHeight` before
    // WebKit finishes expanding the standalone window to its real full-screen
    // size — the first measurement lands short and leaves a dead strip at the
    // bottom that never self-corrects, because nothing short of a genuine
    // `resize` (rotating the device, or backgrounding/foregrounding the app)
    // makes it re-run. Rather than rely on the user doing that, re-measure a
    // few times right after mount to catch WebKit settling, and also listen
    // for the same signals a manual background/foreground would produce.
    const settleTimers = [50, 150, 300, 600, 1000].map((delay) => window.setTimeout(updateAll, delay))
    const rafId = requestAnimationFrame(() => requestAnimationFrame(updateAll))
    document.addEventListener('visibilitychange', updateAll)
    window.addEventListener('pageshow', updateAll)
    window.addEventListener('resize', updateAll)
    window.addEventListener('orientationchange', updateAll)

    updateKeyboardInset()
    viewport?.addEventListener('resize', updateKeyboardInset)
    viewport?.addEventListener('scroll', updateKeyboardInset)

    // The VisualViewport `resize` event is the only signal that's supposed to
    // fire when the on-screen keyboard dismisses, but on an installed iOS PWA
    // it sometimes just doesn't — leaving `--keyboard-inset` stuck at the
    // keyboard's height forever, which reserves that much of `.app` as
    // padding-bottom for a keyboard that's no longer there. Since nothing
    // repaints it, that padding shows through as a dead black strip below the
    // prompt bar, and unlike the cold-launch case, no resize/orientationchange
    // ever comes along to fix it. `visualViewport.height` itself is always
    // current when read (the event is only a notification, not a cache), so
    // re-reading it a beat after every blur — independent of whether the
    // resize event actually fires — closes the gap reliably.
    let blurTimers: number[] = []
    const onFocusOut = (): void => {
      blurTimers.forEach(window.clearTimeout)
      blurTimers = [50, 150, 300, 600].map((delay) => window.setTimeout(updateKeyboardInset, delay))
    }
    document.addEventListener('focusout', onFocusOut)

    return () => {
      settleTimers.forEach(window.clearTimeout)
      blurTimers.forEach(window.clearTimeout)
      cancelAnimationFrame(rafId)
      document.removeEventListener('visibilitychange', updateAll)
      window.removeEventListener('pageshow', updateAll)
      window.removeEventListener('resize', updateAll)
      window.removeEventListener('orientationchange', updateAll)
      viewport?.removeEventListener('resize', updateKeyboardInset)
      viewport?.removeEventListener('scroll', updateKeyboardInset)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])
}
