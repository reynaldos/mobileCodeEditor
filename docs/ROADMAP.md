# Roadmap

Phases are ordered by what teaches you the most, not by what feels most concrete.

The convenience features — git buttons, Vercel, a file tree — feel like the real work and
will eat your first three weekends if you let them. Claude already does all of them through
Bash. Build the things that don't exist unless you build them.

---

## Phase 0 — MVP: one screen

**Goal.** Prove the bet the whole project rests on: that approving diffs with your thumb,
inside a conversation, is a pleasant way to program.

A single scrolling page. Message list, prompt box at the bottom, diff cards inline in the
stream with Approve and Reject. No tabs, no file tree, no editor, no terminal.

### In scope

- One **hardcoded project.** You `git clone` it into the container by hand, once, and set
  the path in an env var. A project picker is a feature; a project is a directory.
- One SQLite table, `events`. The log is the only server state.
- Four routes: `POST /api/prompt`, `GET /api/events` (SSE), `POST /api/approvals/:id`,
  static assets.
- Nine event types. See [PROTOCOL.md](PROTOCOL.md).
- `PreToolUse` hook auto-approving Read/Grep/Glob, prompting on everything else.
- **Reconnect.** Non-negotiable — it's what separates this from a desktop app.
- Tailscale on the host, `tailscale serve` terminating TLS.

### Out of scope, and how you live without it

| Cut | How you cope |
|---|---|
| Preview tab | Have Claude start the dev server. `tailscale serve https:5173`. Bookmark it. Zero code. |
| Terminal | Claude has Bash. "Run the tests." |
| Git UI | "Commit this on a branch and open a PR." `gh` is in the image. |
| Editor | You said you're directing, not typing. Find out if that's true by not building one. |
| Project picker | An env var. |
| Push notifications | You'll want these immediately. Ship without them first, so you're solving a problem you've felt. |

The editor is the interesting cut. My guess is you'll go a month before you genuinely need
to hand-edit a line from a phone — and when you do, you'll ask Claude to do it.

### Build order

1. `packages/protocol` — the event union. It's the contract; write it first.
2. `apps/workspace-server` — until `curl` can stream the SSE and approve a diff from the
   command line. Do not open a browser yet.
3. `apps/web` — EventSource, reducer, message list, diff card, prompt box.
4. Dockerfile, volumes, `tailscale serve`.

### Done when

> From your phone, on cellular, you send a prompt to Claude in a real repo, watch it stream,
> approve a diff, and the change lands on disk. You lock the phone mid-run, come back four
> minutes later, and nothing is lost.

Test that last clause with airplane mode. It is the acceptance criterion.

### Size

Server is roughly 300 lines: Fastify, a SQLite handle, the agent loop, the hook. Client
roughly 400: EventSource, reducer, list, card, prompt box. Protocol 50. Dockerfile 15.

A weekend if it goes well, two if it doesn't. The time actually goes to the approval
promise plumbing — a hook returning a promise resolved by a later HTTP request is a slightly
odd shape — and to getting `tailscale serve` to terminate TLS the way you want.

### What it teaches

Whether the thumb-approval loop is pleasant, which is the entire bet. How noisy the tool
stream is, which *gives you* the allowlist rather than making you guess it. Whether you miss
the editor. And how reconnect behaves on real cellular rather than on your couch.

---

## Phase 1 — Push notifications

**Why first.** The moment you use the MVP you'll hit the real mobile failure mode: you send
a prompt, lock the phone, and now you're either staring at a black screen for three minutes
or you've forgotten the agent exists.

Web push from a home-screen-installed PWA, iOS 16.4+. Two triggers: *needs your approval*
and *turn complete*. Tapping a notification deep-links to the approval card.

This is what makes the thing usable rather than merely working.

**Done when** you can start a refactor, put your phone in your pocket, and get tapped on the
shoulder when Claude needs you.

---

## Phase 2 — Projects

Picker screen, clone from GitHub, create from scratch.

`projects` table lands here — but as a *projection of the log*, not a new source of truth.
Same for `sessions`. `project_id` and `session_id` have been on the events table since the
first migration, so nothing backfills.

One container, `/projects/<name>`. Assign each project a fixed preview port in its settings.
Sessions key off the project.

**Done when** you can clone a repo from your phone and start talking to Claude about it
without touching a laptop.

---

## Phase 3 — Files and editor

File browser with ripgrep-backed search. CodeMirror 6, read-only first, then editable.

This is where the FS/exec RPC surface gets built — and it's worth noticing that this single
surface is what the terminal, git, and Vercel phases all sit on top of. Five tabs light up
from one piece of work.

Path guard: resolve every path and assert it's under `/projects`. The workspace server must
stay incurious about its host.

**Do this only if you've missed it.** If three months in you've never wanted a phone-side
editor, that's not a gap — that's the thesis being right.

---

## Phase 4 — Terminal

xterm.js over a WebSocket to node-pty.

Budget for the soft key row above the keyboard — tab, escape, ctrl, arrows, pipe. Every
mobile terminal ships one, because a phone keyboard cannot produce Ctrl-C.

Terminal bytes are ephemeral. They do not go in the event log.

---

## Phase 5 — Preview tab

Promote the bookmark into the app. An iframe against `https://box.ts.net:<port>`, with a
project-port mapping from settings.

Two things will bite. Vite's HMR websocket needs to be told what host it's actually behind
or the page loads and then silently stops updating. And any app setting `X-Frame-Options`
refuses to frame at all — so ship "open in new tab" beside the frame, always.

---

## Phase 6 — Convenience

Git UI. Project settings page. Vercel.

All of these are buttons over commands Claude can already run. They're worth building
because tapping is faster than typing a sentence, not because they add capability. Vercel in
particular is `vercel link` and `vercel deploy` with a token in `/config` — an afternoon,
whenever you feel like it.

Order them by what you actually reach for. You won't be able to predict it now.

---

## Later — usage and analytics

Deliberately not in the UI, and deliberately already in the log.

The SDK reports `total_cost_usd` per turn: what those tokens would have cost at API rates.
Because auth is a `claude setup-token` OAuth token riding a Max subscription, nothing is
billed per token — usage draws on plan limits. A dollar figure in the header is a meter
reading rendered as an invoice, so the MVP had one and it was removed.

The data is recorded regardless. `turn_complete` and `session_ended` carry `costUsd`,
`session_started` carries `apiKeySource` (`'oauth'` means subscription). So the whole
feature is a query:

```sql
SELECT date(ts/1000, 'unixepoch') AS day,
       SUM(json_extract(payload, '$.costUsd')) AS est_usd
  FROM events WHERE type = 'turn_complete' GROUP BY day;
```

This is the property [DECISIONS #5](DECISIONS.md) was bought for: every table you will ever
want is a projection of the log. Nothing to migrate, nothing to backfill. When you want
usage, you write a `SELECT`.

Worth adding then: turns per session, tools per turn, the approve/reject ratio (which tells
you what your allowlist should be), and time parked awaiting approval. That last one is the
real metric for whether this thing is pleasant to use.

---

## Later — many containers

The only genuine cliff. It arrives when two projects want conflicting toolchains: two Node
majors, or a Python project beside a Rust one.

You run the same workspace image N times and put a router in front. Because multi-tenancy
was always designed to live *in front of* the workspace server rather than through it, the
server itself doesn't change.

The decision waiting for you: one shared SQLite means multiple writers and WAL contention
for nothing; a log per workspace means "show me all my sessions" is a fan-out the router
aggregates. Prefer the latter. Each container stays self-contained and independently
restartable.

Realistically, you may never get here. One image with Node, Python, and a couple of runtimes
covers a lot of personal projects.

---

## Not doing — multiple users

Not a later phase. A different product that shares a UI.

The container stops being a convenience and becomes a security boundary, and everything
expensive follows: per-user workspace lifecycle, a control plane, Firecracker or gVisor
because Docker isolation isn't considered sufficient against hostile code, egress filtering
and an abuse story because you'd be serving strangers' code from your domain, wildcard DNS
and certs for previews.

And the part with no technical answer: Anthropic forbids third parties offering claude.ai
login, so your subscription cannot cover anyone else. Each user brings an
`ANTHROPIC_API_KEY` — encrypted per-user secret storage, rotation, cost accounting, and an
onboarding flow whose first step is "go create an Anthropic API key." That step alone loses
most people.

Two to three months, almost none of it the editor.

Full reasoning in
[DECISIONS.md](DECISIONS.md#13-single-tenant-and-multi-tenancy-would-live-in-front).

---

## Risks

**The approval loop might not be pleasant.** This is the thesis, and Phase 0 exists to test
it in the cheapest possible way. If tapping through diffs on a phone turns out to be
tedious, you learn it in a weekend rather than a quarter — and the answer is probably a
smarter allowlist, not a different architecture.

~~**`PreToolUse` hook semantics.**~~ **Resolved during Phase 0.** The mechanism is
`canUseTool`, which returns `Promise<PermissionResult | null>`. Never return `null` — the
SDK reads it as "answered out of band," writes no control response, and the tool blocks
forever with no error. Both leak paths (turn aborted while parked; server shutting down)
are handled in `session.ts`.

**iOS web push has a sharp edge.** It requires the PWA to be added to the home screen, not
merely visited. If that turns out to be unreliable in practice, Capacitor wraps the same
codebase for native push in about a day. The PWA decision is reversible.

**Long `query()` sessions and server restarts.** Deploying kills in-flight agent turns. The
log survives and `resume` exists, so this is an inconvenience rather than data loss — but
don't deploy mid-refactor.
