# Phase 4 — Terminal

A real shell on the phone: xterm.js in a drawer, over a WebSocket, to a `node-pty` PTY running
in the project directory. The thing you drop to when the agent isn't the right tool — run a
migration, poke at a process, tail a log, `git` something the UI doesn't cover.

Branch: `phase-4/file-editing-and-terminal` (this branch also shipped Phase 3's deferred **file
editing** — write + Save; that's documented in [PHASE-3.md](PHASE-3.md), not here).

**Status — ✅ built, on-device verification pending.** Server round-trips are verified end-to-end
(a WebSocket client driving a real PTY through the framing, coexisting with the preview proxy);
the browser-side xterm rendering is the piece still wanting a device pass.

---

## Shape

- **Server** — [`routes/terminal.ts`](../apps/workspace-server/src/routes/terminal.ts) owns a
  WebSocket at `GET /api/projects/:id/terminal`. On connect it spawns a login shell
  (`$SHELL` or `bash`) in the project's directory and pipes it to the socket. The wire protocol
  ([`terminal.ts`](../apps/workspace-server/src/terminal.ts)) is: **client→server** framed JSON
  (`{type:'input',data}` / `{type:'resize',cols,rows}`) so keystrokes and resizes are unambiguous;
  **server→client** raw bytes, straight into xterm.
- **Client** — [`Terminal.tsx`](../apps/web/src/components/Terminal.tsx) is xterm.js + the fit
  addon, wired to the socket, in a lazy-loaded [`TerminalDrawer`](../apps/web/src/components/TerminalDrawer.tsx)
  (xterm is ~90 KB gzipped — its own chunk, loaded on first open). A **soft-key row** supplies what
  a phone keyboard can't: a sticky **Ctrl** (folds the next key into its control code — Ctrl then
  `c` → `\x03`), **Esc**, **Tab**, arrows, and `| ~ / -`. Nav → **Terminal** opens it; **Restart**
  remounts for a fresh shell.

Bytes never touch the event log — an interactive shell is ephemeral by nature (see
[PROTOCOL.md](PROTOCOL.md) "Later additions"). We don't even record that a terminal was spawned.

## The two things that bit

**1. `upgrade` sequencing vs. the preview proxy.** The preview reverse-proxy
(`@fastify/http-proxy`, Phase 5) installs a *single shared* `upgrade` listener that routes via
Fastify and **404s any path it doesn't recognize**. Node fires all `upgrade` listeners
synchronously — so a second, raw listener of ours *loses the race*: the proxy's 404 is written to
the socket before our async handshake completes (this is exactly why the terminal first appeared to
"connect but not accept typing" — it never connected at all). The fix: don't add a competing
listener. In an **`onReady` hook** (which runs after every plugin has installed its own upgrade
handler) the terminal **takes over** the server's single upgrade handler — claiming its own path
and **delegating everything else** back to whatever was already there (the proxy). One router, no
race. Verified with a probe that registers the proxy *and* the terminal, then drives a shell.

**2. `node-pty` is a native module with no Linux prebuild.** It ships prebuilt binaries for
darwin/win32 only, so on Linux it must compile from source — and pnpm v10 **blocks dependency build
scripts by default**. Two consequences, two fixes:
- It's imported **lazily** (`await import('node-pty')` inside the connection handler), so the
  server and the *entire test suite* load fine on a host where the binary is absent — only actually
  opening a terminal needs it, and a missing binary yields a readable error on the socket instead of
  a crash. (`server.test.ts` imports `buildServer`, so a top-level `node-pty` import took the whole
  suite down on CI.)
- `node-pty` is allowlisted in root `package.json` `pnpm.onlyBuiltDependencies`, so it compiles
  from source where there's no prebuild. CI's ubuntu runner and the Docker build stage already have
  `python3`/`make`/`g++` (they were there for better-sqlite3).

*(macOS local-dev footnote: node-pty's prebuilt `spawn-helper` can extract without the exec bit —
`posix_spawnp failed`. One-time `chmod +x` on `.../prebuilds/darwin-*/spawn-helper`. Linux is
unaffected.)*

## Security

The terminal is an **unrestricted shell** — on purpose. It bypasses the agent's `canUseTool`
approval flow and the `resolveSafe` path guard, exactly like the terminal on your laptop. That is
the correct call **single-tenant** and it rests on the container boundary (Fly Firecracker microVM,
non-root) plus Tailscale as the perimeter — not on the shell being tame. It is a hard blocker for
multi-user, where the answer is a container *per user*, not a login over a shared box. The full
reasoning, and the cheap single-tenant hardening still on the table (scrub secret env vars from the
shell, `ulimit` the PTY), is [DECISIONS #24](DECISIONS.md).

## Deferred

- **Persistence across close.** Closing the drawer ends the shell (the socket drops, the server
  kills the PTY); reopening gives a fresh one. Keeping the PTY alive server-side for reconnect is a
  later nicety.
- **Keyboard-inset polish.** The soft-key row sits at the bottom of the drawer; fully reconciling it
  with the on-screen keyboard's viewport resize is an on-device tuning pass.
- **Scrollback / copy affordances** beyond xterm's defaults.
