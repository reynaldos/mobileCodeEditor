# mobileCodeEditor

A phone-first coding environment. You direct Claude Code from your pocket; it runs in a
container that holds your repos, runs your dev servers, and does the typing.

This is **not** a mobile port of VS Code. On a phone you aren't writing code, you're
directing an agent and reviewing what it did. So the primary surface is a conversation
with inline diffs you approve with your thumb — not an editor.

## Status — running in production

It works, on-device, off the laptop. You direct Claude from your phone, approve diffs with
your thumb, get pushed when it needs you, and it commits and pushes to GitHub **as you** —
against a container on Fly.io that never sleeps.

Shipped: Phase 0 (the one-screen MVP, on-device acceptance passed), Phase 1 (web push,
on-device), the Tailwind 4 migration, containerization, the Fly deploy (Tailscale
in-container, nothing public, no server auth), CI/CD (push to main → test → deploy),
**Phase 2 — projects** (multi-repo clone/create/switch), and **Phase 2.5 — threads**
(per-project conversation history with native-resume/recap). The last two are built and
verified locally; on-device test pending. 104 tests pass.

**Next:** the on-device test of Phase 2 + 2.5 (clone a second repo and hold two threads from
the phone), then Phase 3 (files + editor) or Phase 5 (preview). The full picture, milestones,
and reasoning are in **[docs/ROADMAP.md](docs/ROADMAP.md)**.

Deploy runbooks: **[docs/DEPLOY-FLY.md](docs/DEPLOY-FLY.md)** (what's running) and
[docs/DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md) (the free-tier alternative we tried first).

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

`pnpm -r test` runs 85 tests covering replay semantics, boot recovery, redaction, the agent
session and approval bridge, resume/reset, the notifier and push fan-out, the reducer, and
the diff.

To run the whole thing the way it runs in production — one container, one origin, no Vite:

```bash
cp .env.example config/.env   # secrets only; see docs/DEPLOY-FLY.md
docker compose up --build     # localhost:3000, reachable over `tailscale serve`
```

Deploying it to an always-on box is [docs/DEPLOY-FLY.md](docs/DEPLOY-FLY.md).

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
| [ROADMAP.md](docs/ROADMAP.md) | **Where we are**, what shipped, recommended next steps |
| [DECISIONS.md](docs/DECISIONS.md) | Every load-bearing choice and why — read this before disagreeing with one |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data model, session lifecycle, security posture |
| [PROTOCOL.md](docs/PROTOCOL.md) | Event union, HTTP surface, SSE resume contract |
| [PHASE-0.md](docs/PHASE-0.md) · [PHASE-1.md](docs/PHASE-1.md) | Build logs for the MVP and push notifications, incl. what real use turned up |
| [DEPLOY-FLY.md](docs/DEPLOY-FLY.md) | The production deploy (what's running) |
| [DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md) | The free-tier alternative we tried first |

Start with ROADMAP.md for where things stand, then DECISIONS.md — most of the architecture
only makes sense once you know what it was chosen against.

## Stack

React + Vite PWA · Tailwind 4 · CodeMirror 6 · xterm.js · Fastify · `@anthropic-ai/claude-agent-sdk` ·
better-sqlite3 · node-pty · ripgrep · `gh` · Docker · Tailscale

## Scope

Single tenant, by design. One user, many projects, many devices. See
[DECISIONS.md](docs/DECISIONS.md) for why multi-tenancy is a different product rather
than a later phase of this one.
