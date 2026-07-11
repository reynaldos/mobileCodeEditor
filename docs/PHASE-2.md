# Phase 2 — Projects

Multiple repos: a picker, clone-from-GitHub, create-from-scratch, and switching between
them, each keeping its own conversation. Design rationale in [DECISIONS.md](DECISIONS.md);
the roadmap slot is [ROADMAP.md](ROADMAP.md#phase-2--projects--recommended-next).

Until now `fitnessTracker` was hardcoded via `PROJECT_REPO`. After this, adding a project is
a button.

---

## The three design calls (confirmed before building)

1. **Source of truth for existence = the filesystem.** A project is a directory under
   `projectsRoot` (`/data/projects` on Fly, `/projects` on a VM). `list()` scans it. The log
   records `project_created` for the "cloned from / when" the picker shows, but nothing is a
   table that can drift from disk. **No schema change** — `project_id` has been on the events
   table since migration #1.

2. **SSE stays global; the client filters by active project.** The log is one global stream
   keyed by `project_id`. Rather than complicate the SSE route and its `Last-Event-ID` resume
   contract, the client keeps a per-project view (`byProject[id]`) and renders the active one.
   Server SSE is untouched.

3. **One agent session per project, lazily created.** `SessionManager` becomes a `Map` keyed
   by `projectId` — the class was built for this ([DECISIONS #14](DECISIONS.md)). Prompts and
   resets carry a `projectId`; each project resumes its own Claude conversation because the log
   already keys by `project_id` + `session_id`. Approvals don't need a `projectId` — an
   `approvalId` is globally unique, and the manager finds its owning session.

---

## Blocks

### Block 1 — Protocol + registry (server)  ✅
- `Project`, `project_created` / `project_create_failed` events, `projectId` on `PromptRequest`,
  the projects request/response types.
- `config.projectsRoot` (parent of `projectPath`).
- `ProjectStore`: `list()` (scan + git metadata), `pathOf()` (traversal guard), `create()`
  (clone/init in the background, emitting the outcome to the log).
- `log.projectCreations()` — reads existing events, no schema change.

### Block 2 — Create + clone routes (server)  ✅
- `GET /api/projects`, `POST /api/projects` (`{repoUrl}` → clone, `{name}` → init), 202 +
  event-driven completion.

### Block 3 — Per-project sessions (server)  ✅
- `AgentSession` takes an explicit project (id + path), not the single global config.
- `SessionManager` keyed by `projectId`; `prompt(projectId, …)`, `newConversation(projectId)`.
- `log` resume/reset queries gained a `projectId` filter — WHERE clauses, no schema change.

### Blocks 4 + 5 — Client + picker  ✅ (inseparable on the client, one commit)
- `api.ts` project methods; `sendPrompt`/`startNewConversation` take `projectId`.
- Reducer is `byProject`; active project is React state persisted in `localStorage`.
- Overlay picker (not a router), a "+ New" form (clone URL or fresh name) with a spinner
  driven by the event, and a header that shows/switches the active project.

### Block 6 — Verify  ✅
- 90 tests (67 server, 23 web): projects registry (sanitize, traversal guard, failed-clone
  cleanup), two-project session isolation with the fake `query`, reducer project-filtering,
  routes. Typecheck + build clean.
- Live end-to-end against a scratch DB: `projectCount` 2, prompt routing (404 unknown / 400
  no id / 503 real-no-token), the global SSE carrying per-project events, a route-created
  project appearing in the list.
- **Remaining: the on-device acceptance test** (below) — needs a phone and a token.

---

## Deferred deliberately

Delete/rename (destructive — `rm` on the box meanwhile), a settings page (Phase 5/6, where
preview ports live), and any preview wiring (Phase 5 — and note preview is trickier on Fly:
the dev server needs its own `tailscale serve` mapping).

---

## Acceptance test

> From your phone, clone a **second** repo, switch to it, prompt each project, and confirm
> each keeps its own conversation — switching back to the first shows its history intact, not
> the second's.
