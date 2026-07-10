import webpush from 'web-push'
import type { VapidConfig } from './config.ts'
import type { PushStore, PushSubscription } from './push-store.ts'

export interface Notification {
  title: string
  body: string
  /** Where a tap should land. Default '/'. Carried in the SW's notification data. */
  url?: string
  /** Coalesces notifications on the device: a new one with the same tag replaces the old. */
  tag?: string
}

/** The send primitive, injected so tests never touch the network. */
export type SendFn = (sub: PushSubscription, payload: string) => Promise<{ statusCode: number }>

const defaultSend: SendFn = (sub, payload) =>
  webpush.sendNotification(sub, payload) as Promise<{ statusCode: number }>

/**
 * Fans a notification out to every registered device.
 *
 * The one behavior that matters: a `404` or `410` means that subscription is
 * dead — the PWA was deleted, or the endpoint rotated. Delete the row. Without
 * this, a reinstalled app leaves a corpse that fails on every future send
 * forever. Any other error is transient; leave the row and move on.
 */
export class Pusher {
  readonly #store: PushStore
  readonly #send: SendFn
  readonly #enabled: boolean

  constructor(store: PushStore, vapid: VapidConfig | undefined, send: SendFn = defaultSend) {
    this.#store = store
    this.#send = send
    this.#enabled = Boolean(vapid)

    // Only configure the real library when we'll actually use it. A test that
    // injects its own `send` passes placeholder keys that web-push would reject
    // at this call — validating keys is not this constructor's job, sending is.
    if (vapid && send === defaultSend) {
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
    }
  }

  get enabled(): boolean {
    return this.#enabled
  }

  /** @returns how many devices received it. Never throws — a dead device is not the caller's problem. */
  async notify(notification: Notification, now: number): Promise<number> {
    if (!this.#enabled) return 0

    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      url: notification.url ?? '/',
      tag: notification.tag,
    })

    const subs = this.#store.all()
    let delivered = 0

    await Promise.all(
      subs.map(async (sub) => {
        try {
          const { statusCode } = await this.#send(sub, payload)
          if (statusCode >= 200 && statusCode < 300) {
            this.#store.markDelivered(sub.endpoint, now)
            delivered++
          }
        } catch (err) {
          if (isGone(err)) this.#store.remove(sub.endpoint)
          // else: transient. Leave the subscription; it may work next time.
        }
      }),
    )

    return delivered
  }
}

/** web-push throws a WebPushError whose statusCode is 404 or 410 for a dead endpoint. */
function isGone(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode
  return status === 404 || status === 410
}
