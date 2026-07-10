# Architecture

Rationale for these choices lives in [DECISIONS.md](DECISIONS.md). This document describes
the system as designed. Wire format is in [PROTOCOL.md](PROTOCOL.md).

---

## Two planes

```
┌──────────────────────────────────────────────────────────────┐
│  CLIENT — installed PWA                                       │
│                                                               │
│   EventSource ──► reducer ──► message list                    │
│                               ├─ assistant text               │
│                               ├─ tool chips                   │
│                               └─ approval cards ─► POST       │
│   prompt box ─────────────────────────────────────► POST      │
└──────────────────────────────────────────────────────────────┘
                    │  HTTPS · Tailscale · one origin
                    ▼
┌──────────────────────────────────────────────────────────────┐
│  WORKSPACE SERVER — Node + Fastify, inside the container      │
│                                                               │
│   ┌── static ──────────► serves the PWA build                 │
│   ├── GET  /api/events ─► SSE, honors Last-Event-ID           │
│   ├── POST /api/prompt ─► feeds AgentSession input stream     │
│   ├── POST /api/approvals/:id ─► resolves a pending hook      │
│   └── (later) FS + exec RPC, WS terminal                      │
│                                                               │
│   AgentSession ──► @anthropic-ai/claude-agent-sdk query()     │
│        │                    │                                 │
│        │                    └── PreToolUse hook               │
│        │                                                      │
│        └──► EventLog (SQLite, append-only, global seq)        │
│                    │                                          │
│                    └──► fan-out to connected SSE clients      │
└──────────────────────────────────────────────────────────────┘
     /projects        /data              /config
     repos, dev       events.db          secrets, 0600
     servers
```

There is no control plane. There is no auth service. There is no database server. The
container is the unit of everything, and Tailscale membership is authentication.

The workspace server **also serves the PWA's static assets**. Same origin, one hostname,
no CORS, no mixed content, no token passed between services. This single decision removes
an entire category of problems.

---

## Components

### Workspace server

A Fastify app. Long-lived, one per container, owns everything durable.

Responsibilities, in order of importance:

1. **Own the agent.** Instantiate `AgentSession` objects wrapping the SDK's `query()`.
2. **Own the log.** Every SDK message becomes a row. Nothing else is durable.
3. **Fan out.** Push newly-appended events to connected SSE clients.
4. **Broker approvals.** Bridge a `PreToolUse` hook — a promise — to an inbound HTTP POST.
5. Later: filesystem and exec RPC; a WebSocket terminal over node-pty.

Note that responsibility 5 covers the file browser, editor, terminal, git, and Vercel
surfaces all at once. They are the same operation — reach into the container's filesystem
or run a process there. The agent session is the only surface with a different shape:
long-lived, streaming, resumable.

### AgentSession

A class, instantiated once in the MVP, keyed into a `Map` later. Owns:

- one `query()` async generator, in streaming-input mode so follow-up prompts feed the
  same conversation
- its own `Map<approvalId, Deferred>` of pending approvals
- its lifecycle and its Claude `session_id`

Never module-level mutable state. This is what makes multi-session a lookup rather than a
refactor.

### Event log

One SQLite table, append-only, written by one process.

```sql
CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- global, monotonic
  session_id  TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,                   -- epoch ms
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL                       -- JSON
);
CREATE INDEX events_session ON events (session_id, seq);
```

`session_id` and `project_id` hold a constant value for months. They cost nothing and are
irritating to backfill.

`seq` is **global**, not per-session. A single writer means a total order, which is exactly
what SSE's `Last-Event-ID` resume contract wants. Multi-session replay stays
`WHERE seq > ? AND session_id = ?`.

**The log is the only server state.** Claude's `session_id` is recovered by reading the last
`session_started` event. Restarting the server is therefore always safe — which matters,
because you'll restart it constantly.

Secrets never enter the log. Redact on the way in. The log is what you dump to debug at
1am; it should never be what leaks a token.

### Client

React + Vite, built to static files the server hosts. An `EventSource` feeds a reducer over
the event union; the reducer's output is the message list.

All server calls go through a single `api.ts`. When URLs eventually gain a workspace prefix,
that's one file.

Mobile specifics that will bite otherwise: use `dvh` units and the VisualViewport API rather
than `100vh`, which is wrong whenever the virtual keyboard is up. Respect safe-area insets.

---

## Data model

Three tables eventually; **one** in the MVP.

| Table | When | Columns |
|---|---|---|
| `events` | MVP | as above |
| `projects` | Phase 2 | `id`, `name`, `path`, `preview_port`, `settings` JSON |
| `sessions` | Phase 2 | `id`, `project_id`, `claude_session_id`, `status`, `created_at` |

`projects` and `sessions` are **projections of the log**, not independent sources of truth.
They exist for cheap listing and can be rebuilt by replaying events. This is the property
that makes later phases additive rather than migrations.

Secrets live in a `0600` env file under `/config`. Not in SQLite.

---

## Session lifecycle

```
                  POST /api/prompt
                        │
                        ▼
                   ┌─────────┐
                   │starting │  query() spawned, no init event yet
                   └────┬────┘
                        │ session_started
                        ▼
       ┌──────────►┌─────────┐
       │           │thinking │  generator producing, no pending approval
       │           └────┬────┘
       │                │ approval_request
       │                ▼
       │        ┌────────────────┐
       └────────┤awaiting_approval│  ≥1 approval pending
   approval_    └────────┬────────┘
   decision              │
                         │ turn completes
                         ▼
                  ┌──────────────┐   POST /api/prompt
                  │awaiting_input│──────────────────► thinking
                  └──────┬───────┘
                         │ generator returns
                         ▼
                    ┌─────────┐
                    │  ended  │      terminal
                    └─────────┘

   any state ──► error         (terminal)
   any state ──► interrupted   (process died; generator lost, log intact)
```

`interrupted` is the interesting one. The log still holds everything the UI needs to redraw.
Claude's `session_id` is what you pass to `resume` to restart the agent where it left off.
Two histories, kept separate — that separation is what makes crash recovery tractable.

---

## Approval flow

The one genuinely odd shape in the system: a hook returns a promise that a later,
unrelated HTTP request resolves.

```
 SDK                    server                     phone
  │                       │                          │
  ├─ canUseTool(Edit) ───►│                          │
  │                       ├─ id = uuid()             │
  │                       ├─ append approval_request │
  │                       ├─ pending.set(id, deferred)
  │                       ├─ SSE ────────────────────►│  renders diff card
  │   ...awaits...        │                          │
  │                       │◄─ POST /api/approvals/:id ┤  tap Approve
  │                       ├─ append approval_decision │
  │◄─ resolve(allow) ─────┤                          │
  ├─ tool executes        │                          │
```

The mechanism is the SDK's `canUseTool` option, not a `PreToolUse` hook — it exists
precisely to ask a human, and it returns a promise:

```ts
type CanUseTool = (toolName, input, opts) => Promise<PermissionResult | null>
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny';  message: string; interrupt?: boolean }
```

Auto-approve `Read`, `Grep`, `Glob`. Prompt on everything else, Bash included.

> **Never return `null`.** The SDK reads it as "the consumer already answered out of band"
> and writes no control response. The tool then blocks **indefinitely** — permission
> prompts have no deadline. A parked promise is a hung agent with no error to look at.

`opts` also carries `title`, `displayName`, and `description`, already phrased for a human
("Claude wants to edit foo.ts"). Use them rather than reconstructing a sentence.

Two places a promise could leak, both handled in `session.ts`. If the turn aborts while
parked, `opts.signal` fires and we resolve with a deny. On shutdown, every pending approval
is denied before the abort.

On server restart, any `approval_request` with no matching `approval_decision` gets an
`approval_expired` appended, and the session moves to `interrupted`. The pending promise
died with the process; there's nothing to resolve.

---

## Networking

Tailscale runs on the **host**, not in the container. Container ports bind to the host;
`tailscale serve` terminates TLS.

```
https://box.ts.net           → localhost:3000   workspace server (app + API)
https://box.ts.net:5173      → localhost:5173   project A dev server
https://box.ts.net:5174      → localhost:5174   project B dev server
```

Nothing is publicly exposed. There is no certificate to manage. Authentication is tailnet
membership.

Preview gets a **port per project**, not a path prefix — a dev server under
`/preview/name/` breaks on absolute asset paths. Assign the port in project settings rather
than detecting it.

Always ship an "open in new tab" button next to the preview frame. `X-Frame-Options` will
defeat framing for some apps, and Vite's HMR websocket needs to know what host it's behind
or the page loads and then silently stops updating.

---

## Container

`node:22-bookworm-slim`, plus `git`, `gh`, `ripgrep`, and whatever runtimes your projects
need.

| Volume | Holds |
|---|---|
| `/projects` | repos, dev servers |
| `/data` | `events.db` |
| `/config` | secrets, `0600` |

One Node process supervises. Dev servers are spawned as children.

Claude authenticates from `CLAUDE_CODE_OAUTH_TOKEN`, minted once with `claude setup-token`
against your subscription. Read it through a single config module — the day a container is
provisioned for someone else it gets an `ANTHROPIC_API_KEY` instead, and that should be a
config change rather than a hunt.

---

## Security posture

State the assumptions plainly, because they invert the moment a second user exists.

**Today the container is a convenience, not a boundary.** It exists to keep toolchains
tidy. It protects nothing, because there is nothing to protect you from — Claude runs with
your GitHub credentials on your repos at your request. Treat the container as disposable
and let git be the safety net.

**Approval prompts are a review surface, not a security control.** They exist so you can
see diffs, not to defend against a hostile agent.

**Tailscale is the perimeter.** Nothing is exposed publicly. Losing tailnet access control
is the same as losing the machine.

**Secrets** live in `/config` at `0600`, never in the log, redacted on ingest.

The moment a second person uses this, all four statements become false at once. That is
discussed in [DECISIONS.md](DECISIONS.md#13-single-tenant-and-multi-tenancy-would-live-in-front)
and is deliberately out of scope.

---

## Scaling seams

Where the system bends, in the order you'll bend it.

| Change | Cost | Why |
|---|---|---|
| More devices | none | Tailscale |
| Git push, Vercel deploy, scaffolding | none | Claude already does these via Bash |
| Many projects, one container | small | `project_id` column exists; a picker screen |
| Many concurrent sessions | small | `AgentSession` is already a class |
| Many containers | **real** | Needs the control plane. See below. |
| Many users | different product | See DECISIONS #13 |

**Many containers** is the only genuine cliff, and it arrives when two projects want
conflicting toolchains. You run the same workspace image N times and put a router in front.
The question waiting for you there is where the log lives: one shared SQLite means multiple
writers and WAL contention for no good reason; a log per workspace means "show me all my
sessions" is a fan-out the router aggregates. Prefer the latter — it keeps each container
self-contained and independently restartable.

Because multi-tenancy would be added *in front of* the workspace server rather than through
it, the workspace server never changes. The single-tenant one is the multi-tenant one.

---

## Repo layout

```
mobileCodeEditor/
├── apps/
│   ├── web/                  React + Vite PWA
│   │   └── src/
│   │       ├── api.ts        ← every server call goes through here
│   │       ├── events.ts     reducer over the event union
│   │       └── components/
│   └── workspace-server/     Fastify + Agent SDK + SQLite
│       └── src/
│           ├── config.ts     ← every credential read goes through here
│           ├── log.ts        append + replay
│           ├── session.ts    AgentSession
│           └── routes/
├── packages/
│   └── protocol/             the event union — the contract
├── docs/
└── Dockerfile
```

pnpm workspaces. `packages/protocol` holds the event union type, shared by both halves.
That type is the contract between them, and having it in one place is what keeps the client
honest.
