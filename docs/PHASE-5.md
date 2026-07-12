# Phase 5 — Preview tab

Promote the "bookmark a dev server" workaround into the app. Seeing the running project is a
big deal on a phone, and it's the one thing every prior phase has punted on with "have Claude
start the dev server, bookmark it."

This doc started as a workshop draft; the design calls below are now decided and the server
side is built. Branch: `phase-5/preview-tab`.

**Status.**
- All design calls workshopped and decided (below), including the one genuine unknown — does
  Vite's HMR survive a same-origin reverse proxy under a subpath — spiked by hand against a real
  Vite dev server. See "Spike result" under design call 1.
- **Server side built**: `detectDevCommand` (`projects.ts`), `PreviewTracker` +
  `PreviewManager` (spawn, port-poll readiness, single-slot conflict handling, idle-timeout via
  `Presence`, boot recovery), the `preview_started`/`preview_stopped` protocol events and
  `Preview*` stream types, the three `/api/projects/:id/preview/*` routes, the
  `@fastify/http-proxy` reverse-proxy registration in `server.ts`, and the `preview_stopped`
  notifier cases. 145 workspace-server tests + 27 web tests green, full monorepo typecheck
  clean. One real bug found and fixed along the way: a stale child-process `exit` handler could
  clobber the reference to a just-started *replacement* preview during a forced eviction,
  leaking an unkillable orphaned process — fixed by only clearing `this.#child` if it's still
  the same object the handler belongs to (see the comment in `preview-manager.ts`).
- **Client built** (branch `phase-5/preview-client`): `Project.previewSupported` (server-computed
  via `detectDevCommand`, gates the nav button) threaded through the protocol and
  `ProjectStore.list()`; `api.ts` gained `startPreview`/`stopPreview`/`previewStreamUrl`/`previewUrl`
  and a client-side `PreviewConflictError`; the reducer (`events.ts`) tracks `state.preview` —
  the single active project id, durable across reloads — from `preview_started`/`preview_stopped`,
  never routed into a thread view; `usePreview.ts` layers optimistic open/close and the
  conflict-dialog flow on top of that durable state, the same shape as `useBuilds`;
  `usePreviewStream.ts` mirrors `useBuildStream` for the drawer's live phase/output; `PreviewDrawer.tsx`
  is a non-modal `vaul` drawer with two snap points (peek/full) — the iframe is never unmounted
  between them, only hidden via CSS, so HMR and scroll state survive peeking — with a starting
  spinner, an error state, a terminal-output toggle, "open in new tab", and the confirm-and-evict
  dialog; the nav button lives in `App.tsx` next to the `.env` button, gated on
  `activeProject.previewSupported`. Verified end-to-end against a real spawned child process (a
  stand-in dev server, since installing real Vite over the network proved unreliable in this
  sandbox — same npm flakiness noted above): start → `previewSupported` appears in
  `GET /api/projects` → 202 → SSE snapshot matches the client's expected shape → the reverse proxy
  serves the child's response → stop → the child process is actually gone (verified against
  `/proc`, not just the API's say-so) → the proxy correctly 404s afterward. 146 workspace-server
  tests + 28 web tests green (one new test in each, for `previewSupported` and for the
  `state.preview` reducer case), full monorepo typecheck and `apps/web` production build clean.
- **Phase 6 (branch `phase-6/preview-nextjs-monorepo`): Next.js + monorepo support.** Design call
  1's "out of scope for now" call on Next.js — no CLI flag for a subpath base, only a
  `next.config.js`-only `basePath` — is superseded, without touching users' config files:
  - `detectDevCommand` now also recognizes Next.js (`next.config.*` or a `next` dependency), and
    — since only one preview ever runs system-wide (design call 2) — probes one level into
    `apps/*`/`packages/*` when the project root itself has no dev command, covering pnpm/yarn/npm
    monorepos (this repo's own `mobileCodeEditor` project included, whose Vite app lives in
    `apps/web`). `DevCommand` gained `cwd` (where the subpackage actually is) alongside `framework`.
  - `PreviewManager` spawns Next as `next dev -p <port> -H 0.0.0.0` — no `--base` equivalent
    exists — while Vite keeps the original `--base`/`--port`/`--host` flags. `PreviewTracker`
    now also tracks which framework is active (`activeFramework()`), since the proxy needs it.
  - `server.ts`'s `/preview/:projectId/*` route stays byte-for-byte transparent for Vite, but
    gained a `preRewrite` that strips the `/preview/<projectId>` prefix for Next (whose router
    expects `/`, not a subpath) before `@fastify/http-proxy`'s normal param-substitution rewrite
    runs. A second registration proxies Next's fixed, root-absolute `/_next/*` asset/HMR path —
    gated only on "a Next preview is active" (no projectId in that path to check, and none
    needed: single-slot again).
  - Verified against a **real** `next@14` dev server (network was available this time — installed
    for real, not the fake stand-in Phase 5's client verification needed): `previewSupported`
    true for a real Next project → 202 start → real SSR'd HTML through the proxy with the prefix
    correctly stripped → every `/_next/*` script tag the HTML actually emitted (`webpack.js`,
    `main.js`, the dev build manifest) resolved 200 through the global passthrough → wrong
    `projectId` 404s → stop → both proxy routes 404 again → child process confirmed gone via
    `/proc`, not just the API's say-so. Also added the monorepo case to the existing Vite fixture
    coverage. 155 workspace-server tests green (10 new: Next.js detection, monorepo subdir
    detection across both frameworks, framework-specific spawn args, monorepo spawn cwd), full
    monorepo typecheck and build clean.

---

## The starting idea

> A button in the top nav starts the local server and opens a drawer that takes up most of the
> viewport. The drawer has an iframe showing the project running locally. You can lower the
> drawer (without fully closing it) to check or make edits in the thread, then raise it back.
> Closing the drawer fully terminates the local server.

This is the right shape. A **peekable drawer with a persistent iframe** is exactly the mobile
pattern for "I want the thread and the running app both reachable without a tab bar eating
screen real estate" — and tying the server's lifetime to the drawer's lifecycle (not to the
project, not to the app being open) is a clean, easy-to-explain invariant: **drawer open →
server running, drawer closed → server gone.** No separate "stop server" affordance to forget
about, no orphaned process burning container CPU after you've moved on.

Three things about the mechanics are worth pinning down before building, because they interact
with the Fly wrinkle the roadmap already flagged and with a couple of failure modes this repo
has hit before (dead iframes on `X-Frame-Options`, stale-viewport bugs, orphaned processes on
restart). Working those out is most of this doc.

---

## Design calls (proposed — confirm before building)

### 1. Route the iframe through the workspace server, not a second Tailscale mapping

The roadmap's Fly note assumed the iframe would point straight at
`https://box.ts.net:<devport>`, which needs its own `tailscale serve` mapping added at
container boot — a second exposed port, hardcoded before you know what port a given project's
dev server wants.

**Proposal instead:** the iframe's `src` is same-origin — `/preview/<projectId>/*` — and the
workspace server reverse-proxies that path to `127.0.0.1:<devport>` inside the container.
`@fastify/http-proxy` (a Fastify plugin from the same family as `@fastify/cors`/`@fastify/static`
already in `apps/workspace-server`) does both the HTTP proxying and WebSocket upgrade
forwarding.

This buys three things at once:
- **No Fly-specific wrinkle.** One tailnet endpoint, the one that already exists. Works
  identically on Fly and a VM — the thing Tailscale note in the roadmap was worried about goes
  away entirely.
- **We can neutralize `X-Frame-Options`/CSP `frame-ancestors`.** Since we're already
  terminating the response, the proxy strips or rewrites those headers before they reach the
  browser. A raw port mapping can't do this — it passes the dev server's headers through
  untouched, which is exactly the "refuses to frame at all" failure the roadmap flagged.
- **The HMR-host mismatch is real, and now confirmed handled — with one requirement.** Vite's
  injected client script, when `server.hmr` isn't explicitly configured (true of this repo's
  own `apps/web/vite.config.ts`, and the common case generally), computes its WebSocket target
  from `import.meta.url` — i.e. the actual origin the *browser* loaded the script from — not a
  hardcoded dev port. That's exactly what makes a reverse proxy on a different port transparent
  to it.

**Spike result (done).** Ran a real Vite 6 dev server (`apps/web` itself) behind a from-scratch,
dependency-free byte-level reverse proxy on a different port, deliberately the crudest possible
implementation so a pass here is a floor, not a best case (`@fastify/http-proxy` in the real
build only has an easier job from here). Confirmed via a scripted WebSocket client — not
inspecting source, actually observing the wire:
- HTTP asset requests proxy cleanly.
- The HMR WebSocket handshake succeeds through the port-mismatched proxy.
- A live source-file edit produces a real-time `full-reload` message delivered over that proxied
  socket. (The specific message was `full-reload` rather than a granular `update` — expected,
  since the spike's raw WS client never actually executed the module graph in a real browser for
  React Fast Refresh to track; that distinction is Vite/Fast-Refresh's own internal call and is
  identical with or without a proxy in front of it. The thing this spike needed to prove — the
  transport carries live messages end-to-end through a mismatched-port proxy — is proven.)

**The requirement the spike surfaced, which the original proposal missed:** running the dev
server under a **path prefix** (`/preview/<projectId>/*`, needed since the workspace server's
own SPA already owns `/`) only works if the dev server itself knows to emit asset/module paths
under that prefix — otherwise `index.html`'s `<script src="/@vite/client">` requests the wrong
place (root of the proxy's own origin, not the prefixed path) and everything 404s. Vite has an
explicit answer: pass `--base=/preview/<projectId>/` at spawn time, confirmed in the spike
(`vite --host --base /preview/test/` correctly prefixed every emitted path, HTML and client
script alike). **v1 scope, decided from this:** only dev commands that accept an equivalent
subpath-base override are supported for in-app preview. Vite is confirmed; anything else
(webpack-dev-server/CRA has no reliable CLI equivalent, Next.js dev needs a config-file change,
not a flag) is out of scope for now — same honest, JS-ecosystem-shaped cut `detectInstall()`
already makes for install, not a new kind of limitation.

### 2. One dev server, system-wide, at a time — fixed port

Only one preview drawer can plausibly be open at once (it's most of the viewport), so there's
no reason to support N concurrent dev servers. Proposal: the server always spawns the dev
process on **one fixed local port** — `4999` (an env override, `PREVIEW_PORT`, same pattern as
every other config value in `config.ts`, in case it collides with something someday) — passed
to the dev command explicitly (`--port`/`-p`/`PORT=`, whichever the detected tool wants).

This sidesteps port-allocation bookkeeping entirely, and it makes "closing the drawer kills the
server" the *only* lifecycle rule needed — there's never a second server to reconcile with.

**Confirmed:** starting a preview for project B while project A's is still running stops A
first, behind a confirm dialog — same shape as the existing build-confirm dialog (Phase 2.6):
"This will stop the preview running for `fitnessTracker`. Continue?" Not silent, so you're
never surprised by a server you forgot you'd started disappearing out from under you.

### 3. Detecting the dev command

`detectInstall()` in `projects.ts` already reads the lockfile to pick an install command. A
sibling `detectDevCommand()` can do the same for `package.json`'s `scripts.dev` (falling back
to `scripts.start`), with the package manager matched to whichever one `detectInstall` chose.
JS-ecosystem-only, like install detection — same honest scope-cut.

**Refined after the spike:** detection also has to confirm the project can actually run under a
subpath base — for v1, that means confirming it's Vite (a `vite.config.*` file, or `vite` in
`devDependencies`) and appending `--base=/preview/<projectId>/ --port <fixed>` to the detected
dev script. Non-Vite projects: `detectDevCommand()` returns `undefined` and the preview button
is disabled with a clear reason ("preview isn't supported for this project yet"), not a silent
failure on tap.

**Confirmed: autodetect-only for v1, no override surface yet.** The guess will be wrong
sometimes (custom script names, a monorepo project needing a `--filter`, non-JS projects) —
deliberately deferred rather than built speculatively. Same call this repo already made for
push notifications: ship the simple version, add the override once autodetect actually guesses
wrong on a real project and you know its exact shape, instead of guessing at a settings UI now.
When it's needed, it slots into the project-settings surface the `.env` editor already opened
up in Phase 2.7 rather than a new location. No detected command → the preview button is
disabled/hidden for that project with a reason, not a silent failure on tap.

### 4. Readiness: poll the port, don't parse stdout

Every framework prints something different for "ready" ("Local: ...", "ready in Xms",
"compiled successfully"). Parsing that is a maintenance tax with an ever-growing regex list.
**Proposal:** once the child process is spawned, poll a TCP connect to the fixed port until it
accepts, then flip the drawer from "starting" spinner to iframe. Simple, framework-agnostic,
matches the existing "poll, don't parse" instinct already used elsewhere in this codebase
(the two-tier streaming split in Phase 2.6 treats output as opaque, structural state as
separate signals).

### 5. Durable markers + ephemeral output — mirror `BuildTracker`

Phase 2.6 already solved "long-ish-running child process, live output, durable enough to
survive a reload" with `BuildTracker`: two tiny events in the log (`project_create_started` /
terminal event) plus an in-memory ring-buffer SSE for the noisy part. A dev server is the same
shape, just longer-lived and without a terminal phase until you close the drawer.

**Proposal:** `preview_started { projectId }` / `preview_stopped { projectId, reason: 'closed'
| 'idle-timeout' | 'crashed' | 'restarted' }` as the two durable markers, and a
`PreviewTracker` — genuinely almost `BuildTracker` with `ready`/`error`/`cancelled` swapped for
a long-lived `running` phase and no `RETAIN_FINISHED` pruning (there's only ever zero or one
active preview).

**Decided: a separate class for v1, not a shared base with `BuildTracker`.** Extracting a
common ring-buffer/subscriber/abort base after exactly one reuse is premature — the two also
diverge in a few places (terminal-phase set, single-slot-vs-many, idle timeout only applies to
previews) that would otherwise leak into the shared base as flags. Revisit if Phase 4's
terminal makes it a rule-of-three; a real third shape will make the right cut obvious in a way
guessing now can't.

### 6. Boot recovery

A restart/redeploy kills the dev server child process same as it kills an agent turn.
`ProjectStore.recoverOnBoot()` already handles the equivalent case for interrupted builds.
**Proposal:** an equivalent `recoverOnBoot()` for previews — any `preview_started` with no
terminal event becomes `preview_stopped { reason: 'restarted' }`, so a client reconnecting
after a deploy sees the drawer as closed rather than stuck "starting" forever.

### 7. Drawer mechanics: peek vs. raise vs. close

The Projects picker already uses a shadcn `Drawer` (built on `vaul`) for Clone/Create. `vaul`
supports **snap points** natively — exactly the "full height / peeked strip / gone" three-state
behavior described in the original idea — so this is very likely an extension of a component
already in the app, not a new pattern.

**The one thing that needs to be explicit:** the iframe must never unmount between snap
points — only reposition/resize via CSS — or you lose HMR connection state and scroll position
every time you peek. This is the same "don't destroy on collapse" principle already applied to
sessions when switching projects.

**How "peek" differs from "close":** dragging to the peek snap point keeps the server alive (a
slim bar showing "Previewing `fitnessTracker`" so it's clear which project, in case you've since
switched projects in the main nav — mirroring how the Phase 2.6 build panel stays tied to *its*
project regardless of nav). Only dragging **past** the peek point to fully dismiss — or an
explicit close (×) on the peeked bar — stops the server.

**Confirmed: no confirm on full-close.** Trust the gesture at face value, per the original ask
— full drag-to-close or the × kills the server immediately, no prompt. There's nothing
unsaved server-side to lose, and a confirm on every close would add friction to the single most
common interaction in this whole feature.

**Confirmed: idle-timeout auto-stop, built for v1** (this one *did* get built now rather than
deferred — orphaned processes are a real cost on a single always-on container, not a
theoretical one). Reuses infrastructure that already exists rather than inventing a new
mechanism: `Presence` (`presence.ts`) already tracks, server-side, whether *any* client has the
app foregrounded at all — it was built for exactly this "is anyone actually looking" question,
just for push-notification suppression instead. Proposal: when a preview is active and
`Presence.anyVisible` flips to `false` (every device backgrounded, not merely peeked-while-still-
looking-at-the-thread — peeked-but-foregrounded is legitimate active use, not idle), start a
timer; if visibility returns before it fires, cancel; otherwise stop the preview with
`preview_stopped { reason: 'idle-timeout' }` and a push notification ("Preview stopped —
idle"), so it's never a silent surprise the next time you open the drawer. Default **30
minutes** (`PREVIEW_IDLE_TIMEOUT_MS` env override, same pattern as everything else in
`config.ts`) — a number to revisit once it's actually lived with, not a promise it's the right
one on paper.

### 8. Always ship "open in new tab"

Per the roadmap's own note — some app will set `X-Frame-Options`/frame-bust in a way even the
proxy can't cleanly work around (a `<script>` checking `window.top !== window.self`, for
instance). A same-origin "open in new tab" link/button next to the drawer content, always
present, is the escape hatch. Cheap, and it's already the documented decision.

---

## Sketch of the work

**Server**
- `detectDevCommand()` next to `detectInstall()` in `projects.ts` — lockfile → package manager
  → `scripts.dev`/`scripts.start`, with the fixed port injected.
- `PreviewTracker` (new class, not shared with `BuildTracker` — see above) — spawn, port-poll
  for ready, ring-buffer output, single active slot enforced (starting a new one requires
  confirming and stopping the old one first). Holds the idle-timeout timer, driven by
  `Presence.anyVisible` transitions rather than a new visibility mechanism.
- `@fastify/http-proxy` route: `/preview/:projectId/*` (HTTP + WS upgrade) → `127.0.0.1:<port>`,
  header-stripping for frame-blocking headers. Guard: proxy only forwards while *that* project's
  preview is the active one — never trusts a client-supplied port/host. Confirmed by the spike:
  no path rewriting needed on the proxy side — the dev server itself (via `--base`) already
  emits every asset/module/HMR path pre-prefixed with `/preview/<projectId>/`, so the proxy is a
  transparent 1:1 forward, not a rewriting one.
- `POST /api/projects/:id/preview/start`, `POST /api/projects/:id/preview/stop`,
  `GET /api/projects/:id/preview/stream` (SSE, snapshot + live phase/line, mirrors
  `routes/build.ts`).
- `recoverOnBoot()` for interrupted previews.
- Protocol: `preview_started` / `preview_stopped` events; `PreviewPhase`, `PreviewSnapshot`,
  `PreviewStreamMessage` types (parallel to the `Build*` family).

**Client**
- Nav button (only enabled/visible when the active project has a detected or configured dev
  command) → confirms-and-stops-other-preview-if-needed → starts.
- `PreviewDrawer`: shadcn `Drawer` with snap points (full / peek / closed), iframe pinned to
  `/preview/<projectId>/`, "starting" spinner until port-poll flips ready, error state on crash
  (reuse `DiffView`/build-panel's terminal-toggle pattern for stdout/stderr), "open in new tab"
  always visible, peeked bar shows the previewing project's name.
- Reducer: `preview` state keyed by project, driven by the durable events same as `building`
  is today.

---

## Decisions made (workshopped 2026-07-12)

| Question | Decision |
|---|---|
| Stealing the server from another project | Confirm dialog, always — never silent |
| Full drag-to-close | Trust the gesture, no confirm tap |
| Idle-timeout auto-stop | Build it now (30 min default, `Presence.anyVisible`-driven), not deferred |
| Per-project dev-command override | Autodetect-only for v1; override surface deferred until autodetect is actually wrong on a real project |
| `BuildTracker`/`PreviewTracker` sharing | Separate classes for v1; revisit at Phase 4's rule-of-three |

## Still open

1. **Fixed port number** — proposing `4999` (env-overridable via `PREVIEW_PORT`); mostly just
   needs a sanity check it doesn't collide with anything else in the container image. Low
   stakes, happy to just go with it unless you'd rather pick differently.
2. ~~The Vite HMR-through-proxy spike~~ — **done, see design call 1.** Confirmed working, and
   it surfaced the subpath-base requirement folded into design call 3 above.

## Deferred deliberately

Per-project port *history* / manual port override UI beyond the dev-command override above,
multiple simultaneous previews, non-JS project support, and anything related to a full
Vercel-style deploy preview (that's Phase 6 territory, a different problem — a deployed URL,
not a local process).

## Acceptance test (draft — refine once the Vite HMR spike lands)

> From your phone, open a project, tap the preview button. A drawer rises showing the running
> app in an iframe within a few seconds of a real dev-server boot. Peek the drawer down, send a
> prompt in the thread, confirm the server is still alive (raise back — no reload, HMR still
> connected if you edited a file while peeked). Fully close the drawer — the dev server process
> is actually gone (not just hidden; check on the box). Reopen — starts clean.
>
> Switch to a second project and tap preview there — a confirm names the first project's
> preview before stopping it. Background the app entirely (not just peek) with a preview
> running and leave it alone past the idle timeout — it stops on its own and a notification
> says so; reopening shows it stopped, not stuck "running." Kill the app mid-"starting" and
> reopen — no stuck spinner, no orphaned process survives a redeploy.
