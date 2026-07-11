# Phase 2.5 — Threads

Per-project conversation history. Select a project → see its recent **threads** → open one
to continue where you left off, or start a fresh one. Today each project has exactly one
conversation and "New conversation" abandons it; this makes conversations first-class and
keeps them.

Builds on Phase 2 ([PHASE-2.md](PHASE-2.md)). Resume design confirmed as **option C**
(native resume, log recap fallback) with the user.

---

## Concept

A **thread** is a conversation inside a project. Every conversation event carries a
`threadId` we assign (UUID). A project has many threads; the client has one active thread at
a time. The thread list, titles, and "continue where you left off" all derive from the event
log — which already holds every message of every thread.

Identity, precisely:
- `threadId` — our stable conversation id, on every event. Groups messages across resumes
  and restarts.
- `sessionId` — one per server-side `AgentSession` instance (unchanged). Many share a thread.
- `claudeSessionId` — Claude's own conversation id, for native `resume`. Recorded per
  `session_started`, but **not durable across a Fly redeploy** (see below).

---

## The resume model — option C

Continuing thread T tries the high-fidelity path first, falls back to the always-works one:

1. **Native resume.** Start the agent with `resume: <T's latest claudeSessionId>`. If Claude
   still has that session's transcript on disk, it reloads verbatim — true "start where you
   left off."
2. **Log recap (fallback).** Claude's session files live in the container filesystem, **not**
   on the `/data` volume — so after a redeploy they're gone and native resume can't work.
   When it can't, we build a recap from **our** event log (which has the whole thread) and
   seed the fresh session with it: *"Here's what we were doing in this thread: … continue
   from there."* Lossy for long threads, but it always works.

**How we choose.** We can't perfectly predict whether Claude's session survived, so:
- If the thread was last active in **this** server process (its `AgentSession` is still in
  memory, or the container fs is the same run), native resume is used.
- Otherwise (cold thread, post-restart), the recap path is used.
- A cheap disk check for the session transcript, if we can locate the SDK's session dir,
  sharpens this. **Verify during Block 2** what the SDK does on a resume of a missing session
  (errors? starts fresh with a new id?) — the fallback trigger depends on it, same way
  `canUseTool`'s null semantics had to be checked in Phase 0.

**Recap contents.** Built from the log, no extra LLM call: the thread's user prompts and
assistant replies, truncated per-message and capped overall (last ~N exchanges for a long
thread), formatted as a single priming message sent before the user's next prompt.

---

## Schema change (migration #3)

A `thread_id` column, auto-applied on boot by the existing migration runner — additive, so
nothing manual to run:

```sql
ALTER TABLE events ADD COLUMN thread_id TEXT;
CREATE INDEX events_thread ON events (project_id, thread_id, seq);
```

**Legacy events** (pre-Phase-2.5) have `thread_id = NULL`. They surface as a single
"Earlier conversation" thread per project — grouped, openable, recap-able — rather than
being backfilled. New threads carry real ids going forward.

---

## Blocks

### Block 1 — Data model: `thread_id` + protocol
- Migration #3 (column + index).
- `threadId` on the event envelope; `append` writes the column; `toEvent` reads it.
- `Thread` type: `{ id, projectId, title, lastActivity, messageCount }`.
- Log queries: `threadsOf(projectId)`, `latestClaudeSessionIdOfThread(threadId)`, and the
  thread's message range for the recap.

### Block 2 — Thread lifecycle + resume/recap (server)
- `SessionManager`: sessions keyed by `(projectId, threadId)`. `newThread(projectId)` mints a
  threadId; `prompt(projectId, threadId, text)` routes to that thread.
- Native-resume-then-recap logic, and the recap builder from the log.
- **Verify the SDK's missing-session resume behavior here** and wire the fallback trigger.

### Block 3 — Routes
- `GET /api/projects/:id/threads` — the list.
- `POST /api/projects/:id/threads` — new thread → `{ threadId }`.
- `prompt` / `conversations` carry `threadId`.

### Block 4 — Client core
- Reducer views keyed by thread (`byThread[threadId]`), selected by `(activeProject,
  activeThread)`. New `threadId`s appearing in the stream refresh the thread list.
- `api.ts`: fetch threads, create thread; `sendPrompt` gains `threadId`.
- Active thread persisted per project in `localStorage`.

### Block 5 — Client UI + navigation
- Selecting a project opens its **thread list** (recent first, with title + preview + "New
  thread"). Selecting a thread opens the conversation. A back affordance returns to the list.
- The header shows project › thread.

### Block 6 — Verify + docs
- Unit tests: thread listing/grouping (incl. the NULL legacy thread), per-thread session
  isolation with the fake `query`, recap building, reducer thread-routing. Live curl.
  Then the on-device test.

---

## Deferred

Rename/delete threads, cross-thread search, and an LLM-generated (vs log-built) summary.
Verbatim native-resume across redeploys would require persisting Claude's session dir onto
`/data` — a possible later optimization, not needed for C.

---

## Acceptance test

> In a project, hold two separate threads — say a refactor and a bug hunt. Leave, come back,
> open the project: both are listed. Tap the refactor; it recaps and continues on-topic. Tap
> New; you get a blank thread. Switch back to the bug hunt; it's intact, not the refactor.
> Redeploy the box and the threads — and their recaps — survive, because they live in the log.
