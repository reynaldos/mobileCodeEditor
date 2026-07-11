/**
 * Tracks whether any client currently has the app visible in the foreground.
 *
 * Why this exists instead of trusting the service worker: the `push` handler's
 * own `clients.matchAll()` / `Client.visibilityState` check
 * (`apps/web/public/sw.js`) is a known-flaky bridge on iOS Safari — WebKit
 * often reports a foregrounded PWA as `'hidden'`, so the suppression silently
 * no-ops and you get buzzed while looking at the screen. `document.
 * visibilityState` inside the *page* is reliable; it's only the propagation
 * into the service worker that isn't. So the page reports its own visibility
 * here, and the server makes the send/no-send call before ever pushing. The
 * SW-side check stays too, as a harmless backstop.
 *
 * Keyed by a per-tab client id rather than a single boolean, so one backgrounded
 * tab doesn't clobber another tab (or another device) that's actually visible.
 */
export class Presence {
  readonly #visible = new Set<string>()

  set(clientId: string, visible: boolean): void {
    if (visible) this.#visible.add(clientId)
    else this.#visible.delete(clientId)
  }

  /** Called when a client's SSE connection drops — a dead tab reports nothing further. */
  clear(clientId: string): void {
    this.#visible.delete(clientId)
  }

  /** Is anyone, on any device, currently looking at the app? */
  get anyVisible(): boolean {
    return this.#visible.size > 0
  }
}
