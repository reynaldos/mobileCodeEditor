import type { Event } from '@mce/protocol'
import type { EventLog } from './log.ts'
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
 * The judgment calls, all from PHASE-1.md:
 *
 *  - `approval_request` ALWAYS notifies. The agent is blocked and prompts have no
 *    deadline; this is the one thing worth interrupting you for.
 *  - `turn_complete` notifies only when nobody is watching (`subscriberCount === 0`,
 *    i.e. no live SSE connection). A missed buzz beats a spurious one.
 *  - `session_ended` with reason `error` always notifies.
 *
 * Notification text is drawn from the SDK's own human-phrased fields. It appears
 * on a lock screen, so it must never carry a diff body or a command.
 */
export class Notifier {
  readonly #log: EventLog
  readonly #pusher: Pusher
  readonly #clock: Clock

  #pendingApprovals = 0
  #approvalTimer: ReturnType<typeof setTimeout> | undefined
  #unsubscribe: (() => void) | undefined

  constructor(log: EventLog, pusher: Pusher, clock: Clock = systemClock) {
    this.#log = log
    this.#pusher = pusher
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
        // Nobody watching means no open SSE connection — on a phone, backgrounded.
        if (this.#log.watcherCount === 0) {
          void this.#send({ title: 'Claude finished', body: 'Ready for your next message.', tag: 'turn' })
        }
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
    try {
      await this.#pusher.notify({ ...n, url: '/' }, this.#clock.now())
    } catch {
      // A failed notification must never take down the log fan-out.
    }
  }
}
