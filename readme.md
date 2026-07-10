# mobileCodeEditor

A phone-first coding environment. You direct Claude Code from your pocket; it runs in a
container that holds your repos, runs your dev servers, and does the typing.

This is **not** a mobile port of VS Code. On a phone you aren't writing code, you're
directing an agent and reviewing what it did. So the primary surface is a conversation
with inline diffs you approve with your thumb — not an editor.

## Status

**Phase 0 is built.** Event log, SSE with resume, the approval bridge, and the client are
in and tested. Not yet run against a real repo with a real token — that's your move.

## Quickstart

```bash
pnpm install
cp .env.example .env          # set PROJECT_PATH; add CLAUDE_CODE_OAUTH_TOKEN
pnpm dev                      # workspace server on :3000

# in another terminal
cd apps/web && VITE_API_BASE=http://localhost:3000 pnpm dev
```

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

React + Vite PWA · CodeMirror 6 · xterm.js · Fastify · `@anthropic-ai/claude-agent-sdk` ·
better-sqlite3 · node-pty · ripgrep · `gh` · Docker · Tailscale

## Scope

Single tenant, by design. One user, many projects, many devices. See
[DECISIONS.md](docs/DECISIONS.md) for why multi-tenancy is a different product rather
than a later phase of this one.
