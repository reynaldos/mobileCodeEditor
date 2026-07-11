# Phase 2.6 — Project setup, made visible

Cloning a project used to look hung: a single "Cloning…" line, then — a minute later — the
project either appeared or an error did. No progress, no output, no way to tell a slow clone
from a stuck one. This phase turns setup into a visible, cancellable, notify-when-done flow,
and does the actual dependency install while it's at it.

Builds on Phase 2 ([PHASE-2.md](PHASE-2.md)) and the picker rework (below).

---

## Concept

Setup for a new project is now: **clone/init → detect the package manager → install
dependencies**, with every line of git/npm output streamed to the client as it happens.

The user flow:

1. Tap a repo in the Clone drawer (or **Create**) → a **confirmation dialog** names the
   target ("It'll be downloaded and set up…"). A pre-flight failure (e.g. name taken) stays
   in the dialog; Cancel does nothing.
2. **Confirm** → the picker closes, the project is selected, and a **build panel takes over
   the thread area**. The top nav stays usable on purpose — you can switch to another project
   and come back, and the panel is still there, tied to *that* project until setup finishes.
3. The panel shows the **phase** (Cloning… / Installing…) with an honest indeterminate bar,
   an expandable **Show terminal** with the live output, and a **Cancel**.
4. Terminal states: **ready** → an *Open project* button; **error** → the message + *Back to
   projects*; **cancel** aborts the child process, removes the half-made directory, and
   returns you to the picker.
5. When it finishes, a **push notification** fires — *"Project ready"* or *"Project setup
   failed"* (a user-initiated cancel is not news).

---

## The one decision that shaped it — two-tier streaming

Git and npm are chatty; a clone alone can print hundreds of `--progress` lines. The event log
is append-only and **replayed in full to every fresh SSE connection**, so dumping that output
into it would bloat every page load, forever. So progress is split:

- **Durable, tiny markers in the log** — `project_create_started`, then the existing terminal
  `project_created` / `project_create_failed`. Two events per project. That's all a client
  needs to know a build is *still running* after a reload, a navigation, or a day away — which
  is what makes the panel persist and "stay on that project."
- **Ephemeral live output on its own stream** — `GET /api/projects/:id/build` (SSE), fed from
  an in-memory ring buffer in `BuildTracker`. A joiner gets a `snapshot` (current phase +
  buffered lines) then live `line` / `phase` messages until the build resolves. Never
  persisted, so it can be as verbose as the tools are.

The blocking panel keys its *visibility and terminal state* off the durable events (via the
reducer's `building` set), and its *live detail* off the build stream. Two sources, each doing
what it's good at.

---

## Notable calls

- **Install failure is non-fatal.** If the clone succeeds but `install` fails, the repo is
  kept (it's usable) and the build finishes **ready with a warning** rather than deleting a
  freshly-cloned repo. You re-run install in the thread. Only a failed *clone* — or a cancel —
  removes the directory.
- **Package manager from the lockfile.** `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
  `bun.lock[b]` → bun, `package-lock.json`/bare `package.json` → npm. JS ecosystems only for
  now; anything else skips install. The chosen manager must exist in the container or the
  install step fails visibly (repo still kept).
- **Cancel is a real abort.** `POST /api/projects/:id/build/cancel` trips the build's
  `AbortController`; the child gets SIGTERM and `#build` cleans up.
- **Interrupted builds recover on boot.** A `project_create_started` with no terminal event
  means the process died mid-setup; `ProjectStore.recoverOnBoot()` removes the half-made dir
  and records a failure, so no client is left watching a build that will never finish. Mirrors
  `SessionManager.recoverOnBoot` for sessions.
- **No schema change.** New event types are just new `type` values in the existing table.

---

## Blocks — both ✅ (built + verified locally; on-device test pending)

Committed as two blocks: server, then client.

### Block 1 — Server: stream, install, cancel, notify
- `BuildTracker` (`build-tracker.ts`) — in-memory phase + ring-buffered lines + subscribers +
  an `AbortController` per build; retains a few finished builds for late log viewers.
- `ProjectStore.#build` rewritten to `spawn` (not buffered `execFile`), streaming stdout/stderr
  line-by-line; `git clone --progress` / `git init`, then `detectInstall` → the package
  manager. Emits `project_create_started` and the terminal event; `#spawn` honours the abort
  signal.
- `routes/build.ts` — the live SSE and the cancel endpoint. `log.interruptedBuilds()` +
  `ProjectStore.recoverOnBoot()` for restart recovery.
- `Notifier` fires a push on `project_created` / `project_create_failed`.
- Protocol: `project_create_started` event; `BuildPhase`, `BuildSnapshot`, `BuildStreamMessage`.

### Block 2 — Client: confirm dialog + blocking build modal
- shadcn/ui **Dialog** (`components/ui/dialog.tsx`, Radix) for the confirmation, themed to the
  app tokens like the Drawer.
- `BuildModal` — phase, indeterminate bar, expandable terminal, Cancel / Open / Back.
- `useBuildStream` (live phase + lines) and `useBuilds` (decides when the modal shows —
  survives reload/navigation via a `seen` set, honours the Open gate via `dismissed`, and is
  tied to the active project).
- Reducer gains a `building` set from the durable events; `ProjectPicker` routes clone/create
  through the confirmation and hands the new `projectId` up so `App` swaps the thread for the
  build modal.

---

## Context — also in this stretch (post-2.5 picker work)

Tracked here so the history is in one place, though not strictly "2.6":
- **Threads**: rename + delete (2.5's deferred items), plus a searchable **history popup** and
  a new-thread nav button. `thread_renamed` / `thread_deleted` events; the log stays
  append-only (delete hides, never erases).
- **Projects picker**: Clone/Create moved into bottom-docked **shadcn Drawers**; clone search
  is debounced with a scroll-to-reveal list; create form redesigned. Server returns the full
  matched repo set instead of the top 8.

---

## Deferred

- **npm fallback** when a detected manager (pnpm/yarn/bun) isn't installed in the container.
- **Non-JS ecosystems** (pip, bundler, go mod, …) — currently skipped.
- **Configurable/custom setup command** per project (the third build-scope option).
- **Multiple concurrent build panels** — visibility is tied to the active project; other
  in-flight builds still finish and still notify, you just don't see their panel until you
  switch to them.

---

## Acceptance test

> Clone a real repo with dependencies. Confirm the dialog. Watch the panel go Cloning →
> Installing; open the terminal and see live git/npm output. Switch to another project and
> back — the panel is still there, still building. Let it finish: the Open button appears and
> a push notification arrives (background the app first to be sure). Then clone another and hit
> **Cancel** mid-install — it stops, the directory is gone, you're back in the picker. Finally,
> start a clone and restart the server mid-build: on reload it resolves to a failure, not a
> forever-spinner.
