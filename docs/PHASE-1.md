# Phase 1 — Push Notifications

Design rationale lives in [DECISIONS.md](DECISIONS.md), the wire format in
[PROTOCOL.md](PROTOCOL.md). This is the build plan, in the shape of
[PHASE-0.md](PHASE-0.md).

---

## Why this and not the file browser

Phase 0 proved the loop works. Using it exposes the thing the loop cannot fix on its own:

> You send a prompt. You put the phone in your pocket. Claude works for ninety seconds, hits
> an `Edit`, and parks on `canUseTool` — **waiting for a person who isn't looking at the
> screen.** Permission prompts have no deadline. The agent will wait forever.

Right now the only way to find out is to keep the phone awake and stare at it, which defeats
the entire premise. Every other Phase 2+ feature — file browser, editor, terminal — makes
the app *bigger*. This one is what makes it *usable*.

The measurement that will prove it: **time parked awaiting approval**, computable from the
log today by diffing `approval_request` and `approval_decision` timestamps.

The Phase 0 baseline, from the first real sessions:

```
Edit   902.0s      <- the approval crushed to a hairline by the flexbox bug
Edit     5.9s
Edit     2.7s
Edit     7.5s
Edit     6.0s
```

Read it carefully. When the card is visible you answer in **under eight seconds** — your
latency is not the problem. The 902s is a bug, not a human. What Phase 1 changes is not how
fast you answer; it's whether you have to be *looking* in order to answer at all. Judge it
against approvals made with the phone in a pocket, which is a number that does not exist yet
because that situation is currently unsurvivable.

---

## Prerequisites

### Already true

- The PWA is installed to the iPhone home screen. **iOS only permits web push from a
  home-screen-installed PWA** (16.4+), never from a Safari tab. You did this in Phase 0.
- The site is served over HTTPS via `tailscale serve`. Push requires a secure context.
- A `manifest.webmanifest` exists.

### Needed

- **VAPID keys.** One keypair, generated once, stored in `/config/.env`. `npx web-push
  generate-vapid-keys`.
- **Outbound internet from the box** to `https://web.push.apple.com`. Tailscale doesn't
  block this; a locked-down container might.
- The Mac (or box) must be **awake**. A push cannot originate from a sleeping machine. This
  is the first place the "keep it on your laptop" shortcut genuinely bites.

---

## The one architectural decision

**Push subscriptions get a table, not an event.**

[DECISIONS #5](DECISIONS.md) says every table you'll ever want is a projection of the log.
That holds for anything that *happened in a conversation*. A push subscription is not that —
it's a device registration, new input to the system, and it is mutable (endpoints expire, get
revoked, return `410 Gone`).

Forcing it into the log as `push_subscribed` / `push_unsubscribed` events would mean deriving
current state by replaying two event types and diffing them, to model something that is
simply a row. That's the log serving the architecture instead of the architecture serving the
log.

```sql
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,   -- unique per device+browser
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
```

`p256dh` and `auth` are per-device secrets. They stay out of the event log entirely — nothing
in `redact.ts` needs to know about them, because they never pass through it.

---

## Block 1 — Server can send a push

> Get a notification onto your phone before writing a single line of trigger logic.

**1.1 — VAPID config.** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
(a `mailto:`). Read through `config.ts` like everything else; absent means push is disabled
and the server says so at boot, exactly as it does for a missing Claude token.

**1.2 — `push_subscriptions` table**, migration #2. `POST /api/push/subscribe` takes the
browser's `PushSubscription.toJSON()`. `DELETE /api/push/subscribe` removes it.

**1.3 — `push.ts`.** Wraps `web-push`. One function: `notify(title, body, url)`. Fans out to
every subscription.

> **Prune on failure.** A `404` or `410` from the push service means that subscription is
> dead — delete the row. Anything else, leave it and log. Without this, a reinstalled PWA
> leaves a corpse that fails on every notification forever.

**1.4 — `POST /api/_debug/push`**, dev only, alongside the existing debug injector. Same
trick, same reason: prove the transport before building anything on it.

**Done when** `curl -X POST localhost:3000/api/_debug/push` makes your phone buzz.

---

## Block 2 — Service worker

**2.1 — `apps/web/public/sw.js`.** Hand-written, ~40 lines. Two handlers: `push` and
`notificationclick`.

Deliberately **not** `vite-plugin-pwa`. We want no precaching, no offline shell, no
auto-update lifecycle — this app is useless offline by definition, since it's a view over a
server's log. A plugin would add a build step and an update dance to deliver two event
handlers.

**2.2 — Registration.** `navigator.serviceWorker.register('/sw.js')` on load. It must be
served from the root scope; Vite's `public/` gives that for free, and so does
`@fastify/static` in production.

**2.3 — `notificationclick` deep-links.** Focus an existing window if one is open, otherwise
`clients.openWindow('/')`. Carry the approval id in the notification `data` so the client can
scroll to that card.

> **Foreground suppression.** The `push` handler fires even when the app is open and visible.
> Check `clients.matchAll({ includeUncontrolled: true })` for a `visibilityState === 'visible'`
> client and skip `showNotification()` if one exists. Otherwise you buzz the phone in your
> hand while you're reading the very card it's telling you about.
>
> iOS requires `userVisibleOnly: true`, so you cannot receive a push and show nothing —
> the suppression has to be a decision inside the handler.

---

## Block 3 — Asking permission

**3.1 — An "Enable notifications" button** in the header, shown only when
`Notification.permission === 'default'`.

Three constraints, all of them iOS being iOS:

- `Notification.requestPermission()` **must be called from a user gesture.** Not on mount,
  not in an effect. A button.
- It must be running as an installed PWA. Detect with
  `window.matchMedia('(display-mode: standalone)').matches`. In a plain Safari tab, the API
  exists and quietly does nothing useful — so show an explanation, not a broken button.
- **Denial is close to permanent.** The user cannot re-grant from within the page; they have
  to delete the home-screen icon and re-add it. Ask once, at a moment when the value is
  obvious. Do not ask on first load.

**3.2 — Subscribe** with `applicationServerKey` = the VAPID public key, `userVisibleOnly:
true`, and POST the result to `/api/push/subscribe`.

**Done when** the permission prompt appears exactly once, from a tap, and never again.

---

## Block 4 — Triggers

A `Notifier` subscribes to the `EventLog` — the same synchronous fan-out the SSE route uses.
No polling, no second source of truth.

| Event | Notification | Why |
|---|---|---|
| `approval_request` | "Claude wants to edit page.tsx" | The agent is **blocked**. Always send. |
| `turn_complete` | "Claude finished" | Only if nobody is watching. |
| `session_ended` (`error`) | "Claude hit an error" | Always send. |

`approval_request` always notifies, even with a browser tab open on a laptop, because a
blocked agent is the one thing worth interrupting you for.

`turn_complete` notifies only when `log.subscriberCount === 0` — no SSE connection means no
one is looking. This is a decent proxy on a phone, where backgrounding kills the connection.
It is a *bad* proxy if you leave a desktop tab open, and the consequence is a missed
notification rather than a spurious one. Acceptable.

> **Notification text must not leak code.** "Claude wants to edit `page.tsx`" is fine. The
> diff body is not. Notifications appear on a lock screen, and `approval_request` already
> carries the SDK's own human-phrased `title` — use it.

**Debounce.** Three approvals in one turn should be one notification that says so, not three
buzzes. Coalesce within a short window.

---

## Acceptance test

> Send a prompt from the phone. **Lock it and put it in your pocket.** When Claude hits an
> `Edit`, the phone buzzes. Tap the notification; the app opens directly on the pending
> approval card. Approve it with your thumb. Lock the phone again. When the turn finishes,
> it buzzes once more.

At no point do you watch a screen waiting.

That is the difference between a thing that works and a thing you use.

---

## Size

Server: config, a migration, two routes, `push.ts`, and the notifier — call it 200 lines.
Service worker: 40. Client: a button, a permission dance, a subscribe call — 80.

Half a day, and the half you should budget for is iOS permission behavior, not code.

---

## Risks

**iOS fails silently when not installed.** No error, no exception, just nothing. Check
`display-mode: standalone` before showing the button, and say why when it isn't.

**A denied permission is very hard to undo.** Delete the icon, re-add it. Test with a second
device or be prepared to re-install.

**Push while the server sleeps doesn't happen.** If the box is your laptop with the lid shut,
nothing fires and nothing queues. This is the phase where a machine that stays up starts to
matter — and the first honest argument for the container.

**Apple's push endpoint can rate-limit you.** Debouncing is not only for your sanity.

---

## What this does not include

No notification settings screen. No per-project channels. No "quiet hours." Those are
features of a product; this is a phone that tells you when Claude needs you.
