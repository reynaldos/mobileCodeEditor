# mobileCodeEditor

A phone-first coding environment. You direct Claude Code from your pocket; it runs in a
container that holds your repos, runs your dev servers, and does the typing.

This is **not** a mobile port of VS Code. On a phone you aren't writing code, you're
directing an agent and reviewing what it did. So the primary surface is a conversation
with inline diffs you approve with your thumb — not an editor.

## Status

**Phase 0 is done.** The acceptance criterion is met: a prompt sent from a phone over
Tailscale, a diff approved with a thumb, the change landed on disk — then Safari backgrounded,
the app closed, and the session picked up exactly where it left off. `Last-Event-ID` did the
work; nothing was lost.

Installed to the home screen, which is also the context iOS requires for Phase 1's web push.

**Phase 1 is done.** Web push works end to end: the installed PWA subscribes, and when Claude
hits an approval the phone buzzes even with Safari backgrounded and the screen locked. Tapping
the notification opens straight to the pending card. Verified on-device over Tailscale.

Not done, and deliberately so: the container. `docker build` has never once been run. Docker
buys durability, not the answer these phases existed to ask.

Next: the file browser and a real editor (Phase 3), or the terminal — whatever you reach for
first. See [ROADMAP.md](docs/ROADMAP.md).

## Quickstart

```bash
pnpm install
cp .env.example .env          # set PROJECT_PATH; add CLAUDE_CODE_OAUTH_TOKEN
```

Two terminals, both in the repo root:

```bash
pnpm dev        # terminal 1 — workspace server + agent, :3000
pnpm dev:web    # terminal 2 — client with hot reload,   :5173
```

Open **`localhost:5173`**. The API base is set in `apps/web/.env.development`, so nothing
needs exporting.

Only the first terminal matters in production: the workspace server serves the built client
from its own origin, there is no Vite, no second port, and no CORS.

Mint the token with `claude setup-token` on a machine where you can finish the browser
OAuth flow. It rides your existing subscription — no API billing.

The server starts happily **without** a token: the log, the SSE stream, and the debug
injector all work, and only `POST /api/prompt` returns a 503. That's deliberate, so you can
verify the whole transport before spending anything:

```bash
curl -N localhost:3000/api/events &
curl -X POST localhost:3000/api/_debug/event -H 'content-type: application/json' \
  -d '{"type":"assistant_text","text":"hello from the void"}'

# reconnect from a cursor — this is exactly what your phone does after a lock screen
curl -N -H 'Last-Event-ID: 1' localhost:3000/api/events
```

`pnpm -r test` runs 25 tests covering replay semantics, boot recovery, redaction, the
reducer, and the diff.

## Shape

```
  iPhone / iPad / laptop browser
            │
            │  HTTPS over Tailscale (no public exposure)
            ▼
  ┌─────────────────────────────────────┐
  │  workspace server  (Node, Fastify)  │   ← serves the PWA, too
  │                                     │
  │   • Claude Agent SDK, in-process    │
  │   • SQLite event log                │
  │   • FS + exec RPC                   │
  │   • node-pty                        │
  ├─────────────────────────────────────┤
  │  /projects   /data   /config        │
  │  git  gh  ripgrep  node             │
  └─────────────────────────────────────┘
            container (one, yours)
```

Two planes, not three. No control plane, no auth service, no database server. The
container is the unit of everything, and Tailscale membership is authentication.

## Docs

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data model, session lifecycle, security posture |
| [PROTOCOL.md](docs/PROTOCOL.md) | Event union, HTTP surface, SSE resume contract |
| [ROADMAP.md](docs/ROADMAP.md) | Phased plan from MVP outward |
| [DECISIONS.md](docs/DECISIONS.md) | Every load-bearing choice and why — read this before disagreeing with one |

Start with DECISIONS.md. Most of the architecture only makes sense once you know what it
was chosen against.

## Stack

React + Vite PWA · Tailwind 4 · CodeMirror 6 · xterm.js · Fastify · `@anthropic-ai/claude-agent-sdk` ·
better-sqlite3 · node-pty · ripgrep · `gh` · Docker · Tailscale

## Scope

Single tenant, by design. One user, many projects, many devices. See
[DECISIONS.md](docs/DECISIONS.md) for why multi-tenancy is a different product rather
than a later phase of this one.
