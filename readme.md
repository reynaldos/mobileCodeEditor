# mobileCodeEditor

A phone-first coding environment. You direct Claude Code from your pocket; it runs in a
container that holds your repos, runs your dev servers, and does the typing.

This is **not** a mobile port of VS Code. On a phone you aren't writing code, you're
directing an agent and reviewing what it did. So the primary surface is a conversation
with inline diffs you approve with your thumb — not an editor.

## Status

Pre-implementation. Design is settled; nothing is built.

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
