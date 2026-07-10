import type { Event } from '@mce/protocol'
import { useEffect, useReducer, useState } from 'react'
import { eventStreamUrl } from './api.ts'
import { initialState, reduce, type State } from './events.ts'

export type Connection = 'connecting' | 'live' | 'reconnecting'

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
    const source = new EventSource(eventStreamUrl())

    source.onopen = () => setConnection('live')

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

    return () => source.close()
  }, [])

  return { state, connection }
}

/**
 * The virtual keyboard does not resize the layout viewport, so `100vh` is a lie
 * whenever it is open. Track the visual viewport and let CSS use the truth.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const update = (): void => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`)
    }

    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
}
