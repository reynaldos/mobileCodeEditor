# Phase 0 — Build Checklist

Design lives in [ARCHITECTURE.md](ARCHITECTURE.md), wire format in
[PROTOCOL.md](PROTOCOL.md), rationale in [DECISIONS.md](DECISIONS.md). This is the
operational plan: what to do, in what order, and how you know each step is done.

**Blocks 1–3 run entirely on your laptop.** No container, no Tailscale, no box. The
hardware decision doesn't block anything until Block 4.

---

## Prerequisites

### Needed now

- **Node 22** and **pnpm**.
- **A Claude Code token.** Run `claude setup-token` somewhere you can complete the browser
  OAuth flow. It mints a token valid roughly a year, riding your existing subscription. Keep
  it out of git — it goes in a local `.env` now and `/config/.env` on the box later.
- **A test repo**, cloned locally. Pick something real with a dev server, not a toy. You want
  to feel what it's like to point Claude at code you care about.

That's the whole list. Three things.

### Needed at Block 4, not before

- **A box that stays up.** Not your laptop — you'll close the lid. A mini PC, an old Mac, or
  a VPS you already pay for.
- **Docker** on that box.
- **Tailscale** on the box and on your phone.
  > **Gotcha:** `tailscale serve` needs HTTPS certificates enabled in the tailnet admin
  > console, under DNS. MagicDNS too. Neither is on by default, and nothing tells you.
- **A GitHub fine-grained PAT** as `GH_TOKEN`, with `gh auth setup-git` run once at image
  build. Simpler than device-flow login inside a container.

---

## Block 1 — Protocol

> Nothing else can be built honestly until the contract exists.

**1.1 — `packages/protocol`**
The event union from [PROTOCOL.md](PROTOCOL.md). Nine types. Roughly 50 lines of TypeScript
and a pnpm workspace that both apps depend on.

*Done when:* both `apps/web` and `apps/workspace-server` can import `Event` and neither
exists yet.

---

## Block 2 — Server, verified by `curl`

> **Do not open a browser during this block.** If `curl` can't drive the whole loop, a
> browser will only hide which half is broken.

**2.1 — Fastify skeleton + `config.ts`**
Every credential read goes through the config module. Not `process.env` at the call site.
See [DECISIONS #14](DECISIONS.md#14-cheap-insurance-we-are-buying-now).

**2.2 — `log.ts`: append and replay**
One SQLite table, global autoincrement `seq`. Two functions: `append(event)` and
`replaySince(seq)`. Secrets redacted on the way in.

*Done when:* a unit test appends ten events and replays from seq 4, getting six back.

**2.3 — `GET /api/events` (SSE)**
Replay `WHERE seq > ?` from `Last-Event-ID`, then attach to a live fan-out. Emit `id:` on
every event. Send `: ping` every 20s so intermediaries don't idle you out.

> **Off-by-one:** `Last-Event-ID` is the last event the client *saw*. Replay is strictly
> `seq > N`, not `>=`. Getting this wrong duplicates one message on every reconnect, which
> looks like a rendering bug for a week.

**2.4 — Debug event injector**
A dev-only `POST /api/_debug/event` that appends an arbitrary event. This is the highest-
leverage twenty lines in the project: it lets you build and verify SSE, replay, and
reconnect *before the agent exists* — no tokens burned, no waiting on Claude.

*Done when:* `curl -N localhost:3000/api/events` streams events you inject from a second
terminal. Kill the server, restart, reconnect with `curl -N -H "Last-Event-ID: 5" ...` and
you get exactly events 6 onward.

**2.5 — `AgentSession`**
A class. One `query()` in **streaming-input mode** — the prompt is an async generator you
push into, so follow-up messages feed the same conversation.

> Without streaming-input mode every prompt starts a fresh session and Claude forgets the
> last turn. This is the single easiest thing to get subtly wrong.

Map SDK messages onto log events: `session_started`, `assistant_text`, `tool_use`,
`tool_result`, `session_ended`. Keep `tool_result.summary` to one line — don't log a 40KB
file read.

**2.6 — `canUseTool` + approvals**
Auto-approve Read, Grep, Glob. Everything else: mint an `approvalId`, append
`approval_request`, store a deferred promise in the session's pending map, return the
promise. `POST /api/approvals/:id` appends `approval_decision` and resolves it. Already-
decided or expired → `409`.

On boot, any `approval_request` with no matching decision gets `approval_expired` appended
and the session moves to `interrupted`. The promise died with the process.

> **Never return `null` from `canUseTool`.** The SDK reads it as "the consumer already
> answered out of band," writes no control response, and the tool blocks **indefinitely** —
> permission prompts have no deadline. Resolve on `opts.signal` abort too, or an
> interrupted turn leaks a parked promise.

**2.7 — `POST /api/prompt`**
Creates the session if none is active, otherwise pushes into the existing input stream.
Returns `202` immediately. The answer arrives over SSE — the response body is not where it
lives.

### Block 2 gate

In one terminal, `curl -N` the SSE stream. In another, POST a prompt asking Claude to edit a
file. Watch the `approval_request` arrive. POST the approval. Watch the edit land on disk.

Pass that and the hard half is finished.

---

## Block 3 — Client

**3.1 — `api.ts`** — every server call funnels through here. One file, so a workspace prefix
is later a ten-minute change.

**3.2 — `events.ts`** — a reducer over the event union. `EventSource` in, message list out.
`EventSource` reconnects and resends `Last-Event-ID` on its own; you write nothing.

**3.3 — Message list** — assistant text as prose, tool calls as one-line chips
("Read src/api/routes.ts"). Skimmable with a thumb. Not expandable JSON.

**3.4 — Diff card** — `Edit` hands you `old_string` and `new_string` directly, so no diff
library. Only whole-file `Write` needs real line-diffing. **Unified, not side-by-side** —
two columns at 390px is unreadable. Approve and Reject POST to `/api/approvals/:id`.

**3.5 — Prompt box + mobile layout**
Use `dvh` units and the VisualViewport API, never `100vh` — it's wrong whenever the virtual
keyboard is up. Respect safe-area insets.

*Done when:* the whole loop works in your desktop browser against `localhost`.

---

## Block 4 — Container and tailnet

**4.1 — Dockerfile**
`node:22-bookworm-slim`, plus `git`, `gh`, `ripgrep`. Volumes: `/projects`, `/data`,
`/config`.

> **Gotcha:** `better-sqlite3` is a native module. The slim image has no build toolchain. It
> normally resolves via prebuilt binaries — but if your box is an architecture without a
> prebuild, you'll need `build-essential` and `python3` at build time. Same story for
> `node-pty` in Phase 4.

> **Gotcha:** container/host uid mismatch on the `/projects` volume will leave you with
> root-owned files you can't edit from the host. Decide now whether the container runs as
> your uid.

**4.2 — `tailscale serve`**
Host runs Tailscale; container ports bind to the host.
`https://box.ts.net → localhost:3000`. Nothing publicly exposed, no certificate to manage.

**4.3 — Add to home screen** on your phone.

---

## Acceptance test

> From your phone, on **cellular** — not your home wifi — send a prompt to Claude in a real
> repo, watch it stream, approve a diff, and see the change land on disk. Then lock the
> phone mid-run, wait four minutes, and come back. Nothing is lost.

Test that last clause with airplane mode. It is the acceptance criterion, not a nice-to-have
— it's the one thing that distinguishes this from a desktop app.

---

## The two hard parts

Everything else is plumbing. Budget your patience for these.

**The approval bridge (2.6).** A hook returns a promise that an unrelated inbound HTTP
request resolves. It's an odd shape and the failure modes are quiet: a promise nobody
resolves hangs the agent forever with no error.

**Tailscale HTTPS (4.2).** Not hard, but the admin-console toggles are undiscoverable and
the failure mode is a certificate error that looks like your code.

---

## What's deliberately absent

No preview tab — have Claude start the dev server, `tailscale serve` its port, bookmark it.
No terminal — Claude has Bash. No git UI — "commit this on a branch and open a PR." No
editor — you said you're directing, not typing; find out whether that's true by not building
one. No project picker — a project is a directory and an env var.

No push notifications, and you will want them within a day. That's Phase 1, and shipping
without them first means you'll be solving a problem you've actually felt.
