/**
 * The client half of web push. Every iOS constraint that can fail silently is
 * handled explicitly here. See docs/PHASE-1.md.
 */
import { getPushKey, subscribePush, unsubscribePush } from './api.ts'

export type PushState =
  | 'unsupported' // no service worker / Push API (old browser, or Safari tab pre-16.4)
  | 'needs-install' // the APIs exist but we're not a home-screen PWA — iOS requires that
  | 'default' // installable and not yet asked
  | 'granted' // subscribed
  | 'denied' // the user said no; effectively permanent on iOS

/** iOS only permits push from a home-screen-installed PWA, never a Safari tab. */
function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's non-standard flag, still the only signal on older versions.
    (window.navigator as { standalone?: boolean }).standalone === true
  )
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function currentPushState(): PushState {
  if (!pushSupported()) return 'unsupported'
  if (!isStandalone()) return 'needs-install'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  return 'default'
}

/** Registered once on load. Safe to call when unsupported — it just no-ops. */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register('/sw.js')
  } catch {
    // A failed registration disables push, nothing else. Don't surface it.
  }
}

/**
 * The full enable flow, driven by a tap.
 *
 * MUST be called from a user gesture — `Notification.requestPermission()` is
 * ignored otherwise on iOS. And a denial is close to permanent: the user can't
 * re-grant from the page, only by deleting and re-adding the home-screen icon.
 * So this is called once, from a button, at a moment when the value is obvious.
 */
export async function enablePush(): Promise<PushState> {
  if (currentPushState() !== 'default') return currentPushState()

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const registration = await navigator.serviceWorker.ready
  const { key } = await getPushKey()

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true, // required by iOS: you cannot receive a push and show nothing
    applicationServerKey: urlBase64ToUint8Array(key),
  })

  await subscribePush(subscription.toJSON())
  return 'granted'
}

export async function disablePush(): Promise<void> {
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return

  await unsubscribePush(subscription.endpoint).catch(() => {})
  await subscription.unsubscribe().catch(() => {})
}

/**
 * VAPID keys travel as base64url; the Push API wants a byte view.
 *
 * Backed by an explicit ArrayBuffer so the type is `Uint8Array<ArrayBuffer>`,
 * which satisfies `BufferSource` — `new Uint8Array(n)` is `ArrayBufferLike`
 * under TS 5.7+ and would not.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}
