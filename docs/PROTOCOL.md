# Protocol

The contract between `apps/web` and `apps/workspace-server`. Lives in
`packages/protocol` as TypeScript.

---

## Events

Ten types in the MVP. Every one is appended to the log and streamed over SSE. `seq`
doubles as the SSE event `id`.

The canonical definition lives in `packages/protocol/src/index.ts`. This is the
explanation; that is the truth.

```ts
type Event = {
  seq: number          // global, monotonic — also the SSE id
  sessionId: string
  projectId: string
  ts: number           // epoch ms
} & EventBody

type EventBody =
  | { type: 'session_started';   claudeSessionId: string; model: string }
  | { type: 'user_prompt';       text: string }
  | { type: 'assistant_text';    text: string }
  | { type: 'tool_use';          toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result';       toolUseId: string; ok: boolean; summary: string }
  | { type: 'approval_request';  approvalId: string; toolUseId: string
                                 tool: string; input: unknown
                                 title?: string        // "Claude wants to edit foo.ts"
                                 displayName?: string  // "Edit file"
                                 description?: string }
  | { type: 'approval_decision'; approvalId: string; allow: boolean; reason?: string }
  | { type: 'approval_expired';  approvalId: string }
  | { type: 'turn_complete';     costUsd?: number; numTurns?: number }
  | { type: 'session_ended';     reason: 'complete' | 'error' | 'interrupted'
                                 costUsd?: number; message?: string }
```

### Notes

**`turn_complete` was added during implementation.** The design assumed a session and a
turn ended together. They don't: in streaming-input mode the SDK emits a `result` message
per assistant turn while the generator stays alive awaiting the next prompt. Without this
event the client has no way to stop its spinner, and Phase 1's "your agent finished" push
notification has nothing to fire on. `session_ended` now means only what it says — the
generator returned.

**`approval_request` carries SDK-rendered text.** `canUseTool` hands us `title`,
`displayName`, and `description` already phrased for a human. Prefer them over
reconstructing a sentence from `tool` and `input`; fall back only when absent.

**No token deltas.** `assistant_text` carries a complete message. Streaming deltas into the
log would multiply its size and make replay-from-`seq` strange. If the typing effect is
wanted later, SSE permits events without an `id:` field — those stream through without
advancing `Last-Event-ID`. Deltas ride that channel; durable events ride the numbered one.

**`tool_result.summary` is for humans.** One line, rendered as a chip. Don't put a 40KB file
read in the log.

**`approval_expired`** is appended on server restart for any `approval_request` with no
matching decision. The promise the hook was awaiting died with the process.

**Secrets are redacted before append**, not before render.

---

## HTTP surface

Four routes in the MVP.

### `GET /api/events`

Server-Sent Events. The only way the client learns anything.

```
GET /api/events
Last-Event-ID: 412        (optional; sent automatically by EventSource on reconnect)

id: 413
event: message
data: {"seq":413,"type":"assistant_text","text":"...", ...}

id: 414
event: message
data: {"seq":414,"type":"approval_request", ...}
```

On connect, the server replays `SELECT * FROM events WHERE seq > ? ORDER BY seq` and then
attaches the connection to the live fan-out. With no `Last-Event-ID`, replay from 0.

This is the entire reconnect story. `EventSource` reconnects and sends the header on its
own; the server does one query. Locking your phone mid-run is not an error case.

Send an SSE comment (`: ping\n\n`) every ~20s to keep intermediaries from idling the
connection out.

### `POST /api/prompt`

```ts
Request:  { text: string }
Response: { sessionId: string }   // 202 Accepted
```

Creates the session if none is active, otherwise feeds the existing `query()` input stream.
Returns immediately. Everything that happens next arrives over SSE — the response body is
not where the answer lives.

### `POST /api/approvals/:approvalId`

```ts
Request:  { allow: boolean, reason?: string }
Response: 204 No Content
```

Resolves the deferred promise the `PreToolUse` hook is awaiting. Idempotent: a decision for
an already-decided or expired approval returns `409 Conflict`.

### `GET /*`

Static assets for the PWA. Same origin as the API, which is why there is no CORS
configuration anywhere in this project.

---

## Tool handling

Claude Code's permission engine runs **before** ours. Under `permissionMode: 'default'` it
allows read-only operations without asking, and only escalates the rest to `canUseTool`.
What we see, and what we do with it:

| Tool | Behavior |
|---|---|
| `Read`, `Grep`, `Glob` | auto-approve, emit `tool_use` chip |
| `Bash`, read-only (`ls`, `grep`, `pwd`) | never reaches us — runs, emits a chip |
| `Bash`, mutating (`touch`, `rm`, `git push`) | `approval_request` → command card |
| `Edit`, `Write` | `approval_request` → diff card |
| everything else | `approval_request` |

Verified, not assumed: in a real session `pwd && ls` and two `grep`s ran with no card, while
a probe confirmed `touch probe.txt` raised one and left the file uncreated.

A tool call that fails validation errors *before* the permission check — an `Edit` on a file
Claude hasn't read yet returns `tool_result ok=false` with no `approval_request`. That is not
a missing card.

### Rendering diffs

`Edit` tool input carries `old_string` and `new_string` directly. You already have both
sides; no diff library needed. Only whole-file `Write` requires real line-diffing.

Render **unified**, not side-by-side. Two columns at 390px is unreadable.

---

## Later additions

Sketched so the event union is designed to accept them, not built yet.

```ts
  | { type: 'file_opened';    path: string }
  | { type: 'file_saved';     path: string }
  | { type: 'terminal_spawn'; ptyId: string; cwd: string }
  | { type: 'git_op';         command: string; ok: boolean }
  | { type: 'preview_up';     projectId: string; port: number }
```

Terminal *bytes* do not go in the log — that's a WebSocket to node-pty, ephemeral by
nature. Only the fact that a terminal was spawned is worth remembering.

Filesystem and exec RPC (the file browser, editor, git, Vercel) are ordinary
request/response and need no events at all, beyond the audit-trail entries above.
