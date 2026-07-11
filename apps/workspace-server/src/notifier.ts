import type { Event } from '@mce/protocol'
import type { EventLog } from './log.ts'
import type { Presence } from './presence.ts'
import type { Pusher } from './push.ts'

/** Coalesce a burst of approvals in one turn into a single buzz. */
const DEBOUNCE_MS = 1_500

export interface Clock {
  now(): number
}

const systemClock: Clock = { now: () => Date.now() }

/**
 * Turns log events into push notifications, on the same synchronous fan-out the
 * SSE route uses. No polling, no second source of truth.
 *
 * One rule now governs every event type: **never buzz a screen someone is
 * already looking at.** `#send` gates on `presence.anyVisible` right before it
 * actually pushes — evaluated at send time, not at event-arrival time, so a
 * debounced approval burst is judged by whether you're looking *when the timer
 * fires*, not when the first tool call happened.
 *
 * This used to be two different rules per PHASE-1.md — `approval_request`
 * always notified regardless of who was watching, `turn_complete` only
 * notified with no open SSE connection — reasoned about via `watcherCount`
 * (an SSE-connection proxy for "someone might be looking"). `watcherCount`
 * is gone from this decision: it can't tell foreground from a backgrounded
 * tab that just hasn't dropped its connection yet. `Presence` (reported by
 * the page's own `document.visibilityState`) is a direct signal instead of a
 * proxy. See presence.ts.
 */
export class Notifier {
  readonly #log: EventLog
  readonly #pusher: Pusher
  readonly #presence: Presence
  readonly #clock: Clock

  #pendingApprovals = 0
  #approvalTimer: ReturnType<typeof setTimeout> | undefined
  #unsubscribe: (() => void) | undefined

  constructor(log: EventLog, pusher: Pusher, presence: Presence, clock: Clock = systemClock) {
    this.#log = log
    this.#pusher = pusher
    this.#presence = presence
    this.#clock = clock
  }

  start(): void {
    if (!this.#pusher.enabled) return
    // watcher: false — the notifier listens to *send* pushes, it is not a human
    // looking at the screen. Counting itself would make "nobody watching" false
    // forever and silence every turn_complete notification.
    this.#unsubscribe = this.#log.subscribe((event) => this.#onEvent(event), { watcher: false })
  }

  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    if (this.#approvalTimer) clearTimeout(this.#approvalTimer)
  }

  #onEvent(event: Event): void {
    switch (event.type) {
      case 'approval_request':
        this.#coalesceApproval(this.#approvalTitle(event))
        return

      case 'turn_complete':
        void this.#send({ title: 'Claude finished', body: 'Ready for your next message.', tag: 'turn' })
        return

      case 'session_ended':
        if (event.reason === 'error') {
          void this.#send({
            title: 'Claude hit an error',
            body: event.message ?? 'The session ended unexpectedly.',
            tag: 'error',
          })
        }
        return

      // Project setup is long-running and often backgrounded — always notify when
      // it finishes, success or failure. A user-initiated cancel is not news.
      case 'project_created':
        void this.#send({ title: 'Project ready', body: `${event.name} finished setting up.`, tag: `build-${event.name}` })
        return

      case 'project_create_failed':
        if (event.error !== 'Cancelled') {
          void this.#send({ title: 'Project setup failed', body: `${event.name}: ${event.error}`, tag: `build-${event.name}` })
        }
        return

      default:
        return
    }
  }

  /**
   * First approval in a burst arms a short timer. Further approvals within the
   * window just bump the count, so three tool calls in one turn become one buzz
   * that says "3 actions", not three buzzes.
   */
  #coalesceApproval(firstTitle: string): void {
    this.#pendingApprovals++

    if (this.#approvalTimer) return
    this.#approvalTimer = setTimeout(() => {
      const n = this.#pendingApprovals
      this.#pendingApprovals = 0
      this.#approvalTimer = undefined

      void this.#send({
        title: 'Claude needs you',
        body: n === 1 ? firstTitle : `${n} actions waiting for approval`,
        tag: 'approval',
      })
    }, DEBOUNCE_MS)
  }

  #approvalTitle(event: Extract<Event, { type: 'approval_request' }>): string {
    // The SDK already phrased this for a human, e.g. "Claude wants to edit foo.ts".
    // Never fall through to input, which could put a command on a lock screen.
    return event.title ?? `Approve a ${event.tool} action`
  }

  async #send(n: { title: string; body: string; tag: string }): Promise<void> {
    // The one gate every notification passes through. Evaluated now, not when
    // the triggering event arrived — presence can change in the seconds an
    // approval burst spends debouncing.
    if (this.#presence.anyVisible) return

    try {
      await this.#pusher.notify({ ...n, url: '/' }, this.#clock.now())
    } catch {
      // A failed notification must never take down the log fan-out.
    }
  }
}
