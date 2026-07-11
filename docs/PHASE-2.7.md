# Phase 2.7 — Control & editor enhancements (backlog + gameplan)

Five enhancements captured for tracking. Not started. Each has: the ask, where the code stands
today, a proposed approach (server / client / protocol), the open decisions, and rough size.
Ordering/priority is at the bottom.

Nothing here is committed to yet — this is the map, not the build.

---

## 1. Structured question UI (`AskUserQuestion`)

**Ask.** When Claude asks a multiple-choice question (the `AskUserQuestion` tool — the same
shape this repo's own questions use: `{ question, header, options:[{label,description}],
multiSelect }`), render it as an interactive card in the chat (segmented per-question, radio/
checkbox options with descriptions, Submit) instead of raw JSON. The answer goes back to the
agent.

**Today.** `AgentSession.#canUseTool` ([session.ts](../apps/workspace-server/src/session.ts))
treats every non-auto tool identically: it appends one `approval_request` and parks an
allow/deny promise. An `AskUserQuestion` call would show up as a generic approval card with the
questions JSON in a `<pre>` — allow/deny, no way to actually answer.

**Spike result (done — the plan changed).** It is **not** `canUseTool`. The SDK
(`@anthropic-ai/claude-agent-sdk@0.3.206`) routes blocking user dialogs, `AskUserQuestion`
included, through a dedicated callback:

- `options.onUserDialog?: (request, { signal }) => Promise<UserDialogResult>` handles
  `request_user_dialog` control requests. `UserDialogRequest = { dialogKind: string; payload:
  Record<string,unknown>; toolUseID? }`; `UserDialogResult = { behavior:'completed'; result:
  unknown } | { behavior:'cancelled' }`.
- `options.supportedDialogKinds?: string[]` **gates it**: the CLI fails closed and only emits a
  `dialogKind` you've declared — undeclared kinds degrade to their no-dialog default
  (auto-continue/cancel) and never reach the host. So we must declare the right kind.
- The question schema (`AskUserQuestionInput`) is exactly this repo's `AskUserQuestion` shape:
  `{ questions: [{ question, header, options:[{label,description,preview?}], multiSelect }] }`
  (1–4 questions, 2–4 options). The result (`AskUserQuestionOutput`) is `{ questions, answers:
  { <questionText>: <answerLabel, comma-joined if multi> }, response?, annotations? }`.
- Config knobs: `askUserQuestionTimeout` (default `'never'` → parks indefinitely, good — no
  spurious auto-resolve) and `toolConfig.askUserQuestion.previewFormat: 'markdown' | 'html'`
  (use `'html'` for a web UI if we ever render option previews).

**One unknown left — the exact `dialogKind` string** (the type is an open union; only
`'refusal_fallback_prompt'` is named). Resolve it the Phase-0 way: wire `onUserDialog` to **log
every incoming `dialogKind` + payload**, declare a small candidate set in `supportedDialogKinds`,
run one real question on-device, then lock the string in.

**Approach (revised).**
- *Server*: set `onUserDialog` + `supportedDialogKinds` in the `query()` options
  ([session.ts](../apps/workspace-server/src/session.ts)). The handler appends a
  `question_request { requestId, toolUseId, questions }` event and parks a promise (mirrors the
  approval bridge's `#pending`/`resolveApproval`). `POST /api/questions/:id { answers }` resolves
  to `{ behavior:'completed', result:{ answers } }`; abort/shutdown resolves `{ behavior:'cancelled' }`.
- *Protocol*: `question_request` / `question_answered` events; `Question`/`QuestionOption` types.
- *Client*: a `question` item kind + `QuestionCard` (segmented like the native card, options with
  descriptions, single/multi select, Submit); `api.answerQuestion(id, answers)`.

**Size.** M–L. Build it discovery-friendly (log the dialogKind) so the one live unknown resolves
on first use rather than blocking the build.

---

## 2. Growing tool allowlist — Decline / Approve / Always approve

**Ask.** Stop prompting for every little thing. The approval card should offer a third action,
**Always approve**, that remembers this command so future matching calls auto-approve. The list
grows over time.

**Today.** `AUTO_APPROVED = new Set(['Read','Grep','Glob'])` is hardcoded in
[session.ts](../apps/workspace-server/src/session.ts). The card
([ApprovalCard.tsx](../apps/web/src/components/ApprovalCard.tsx)) has Reject / Approve only.
Nothing persists — `settingSources: []` deliberately loads no pre-approvals.

**Approach.**
- *Rule granularity* (the main design call): per-**tool** is too broad for Bash, per-exact-command
  too narrow. Propose rules = `{ tool, match? }` where non-Bash tools (Edit/Write) can be
  allowed by tool, and Bash is matched on the command's first token(s) — the button says exactly
  what it'll allow (e.g. *Always allow `pnpm install`* vs *Always allow all `git …`*). May offer
  a small scope choice on "Always".
- *Persistence*: store rules as `rule_allowed` events in the log and project them (fits the
  append-only model, DECISIONS #5) — no new table. **Per-project** to start (a repo's safe
  commands aren't universal); global tier later.
- *Server*: `#canUseTool` consults the project's rules (plus `AUTO_APPROVED`) before parking.
  `resolveApproval` gains a `scope: 'once' | 'always'`; `always` appends a `rule_allowed` event.
- *Protocol*: `rule_allowed { tool, match? }`; approval decision carries `scope`.
- *Client*: third button in `ApprovalCard`; `decideApproval(id, allow, { always })`. A later
  settings screen can list/revoke rules.

**Open.** Bash match granularity (first word vs first two vs full). Whether Edit/Write "always"
means all files or per-directory. Recommend: first-word for Bash, per-tool for Edit/Write, shown
verbatim on the button so there's no surprise.

**Size.** M. (Shares the approval bridge with #1 — sequence them together.)

---

## 3. Post-task file-changes accordion (GitHub-style)

**Ask.** When a task finishes, show the list of files changed with +/− counts, each expandable
to its diff — an accordion like GitHub's file list.

**Today.** [DiffView.tsx](../apps/web/src/components/DiffView.tsx) already renders a unified
per-file diff (used inside approval cards). There's no summary of *all* changes at end of turn.
`turn_complete` fires at [session.ts](../apps/workspace-server/src/session.ts) `#onMessage`.

**Approach.**
- *What "this turn changed"*: snapshot `git rev-parse HEAD` when a turn starts; at
  `turn_complete`, diff `startHEAD → working tree` (covers both uncommitted edits and mid-turn
  commits). Keep the snapshot on the `AgentSession`.
- *Server*: emit a lightweight `turn_changes { files: [{ path, additions, deletions, status }] }`
  event (names + counts only — bounded, safe for the log). Full per-file diff bodies are fetched
  on expand via `GET /api/projects/:id/changes?base=<sha>&path=<file>` (diffs stay **out** of the
  log, like build output).
- *Client*: a `changes` item rendered at turn end as an accordion; reuse `DiffView` per file on
  expand. `api.fetchFileDiff(...)`.

**Open.** Defining the base robustly if Claude rebases/amends. The HEAD-at-turn-start snapshot
handles the common cases; note the edge. Also: show working-tree changes only, or include
staged/committed (recommend: everything since the snapshot).

**Size.** M.

---

## 4. Correct git identity (should be `reynaldos`, not `mco@local`)

**Ask.** Commits/pushes are attributed to `mco@local` instead of the user's GitHub identity.

**Today.** [docker-entrypoint.sh](../docker-entrypoint.sh) sets `git config --global user.name/
user.email` **only if** `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` are set; `.env` and `fly.toml` set
them to `rey sanchez` / `rey.sanchez.dev@gmail.com`. Seeing `mco@local` means those env vars
aren't reaching git on the running box (git then auto-derives `user@host`). Separately, GitHub
attributes commits by **email**, and the configured gmail is not the `reynaldos` login.

**Approach.**
1. *Diagnose*: on the box, `git config --global --list` and confirm whether `GIT_AUTHOR_*` are in
   the entrypoint's environment (Fly `[env]` should inject them; a VM/local run needs them in the
   sourced `/config/.env`).
2. *Robust fix*: in the entrypoint, when `GIT_AUTHOR_*` are unset **and** `GH_TOKEN` is present,
   derive identity from `gh api /user`: `name = .name || .login`, and use the GitHub **noreply**
   email `"${id}+${login}@users.noreply.github.com"` so GitHub reliably attributes to `reynaldos`
   without exposing a real address. Falls back to the env vars when explicitly set.
3. Ensure no per-repo `user.*` override in cloned projects shadows the global.

**Open.** Whether to prefer the explicit env identity or always gh-derive (recommend: env wins if
set, else gh-derive). Ties into #5 — the env editor could expose these too, but identity is a
container/global concern and belongs in the entrypoint.

**Size.** S (once diagnosed).

---

## 5. Per-project `.env` editor

**Ask.** A UI to manage a project's `.env` (in the project directory). Scaffold it from
`.env.example` (keys, empty values) or empty; edit values; add/remove keys. **Save writes
directly to the file** — the UI is a view over the file, not an abstraction stored elsewhere.

**Today.** None. (Server *secrets* live at `/config/.env`, redacted from the log via `redact.ts`
— that's separate from a project's own `.env`.)

**Approach.**
- *Server* (all guarded by `ProjectStore.pathOf`, project's own file only, no traversal):
  - `GET /api/projects/:id/env` → parse `.env` into `{ entries:[{key,value}], hasExample }`.
  - `PUT /api/projects/:id/env` → serialize `entries` back to `KEY=value` lines and write.
  - `POST /api/projects/:id/env/init` → scaffold from `.env.example` (keys, blank values) or empty.
- *Client*: a project settings drawer with a key-value editor (add/remove rows, reveal-toggle on
  values, Save → PUT).
- *Protocol*: `EnvFile { entries, hasExample }`.

**Open / care.**
- These are secrets. Reading/writing is acceptable inside the Tailscale perimeter (single-user,
  private), but the values must **never** enter the event log — the file write is off-log by
  design; just don't emit their contents in any event.
- v1 won't preserve comments and will quote values containing spaces; note as a limitation
  (round-tripping arbitrary `.env` faithfully is a rabbit hole).

**Size.** M.

---

## Suggested order

1. **#4 git identity** — small, high daily value, unblocks correct attribution. Start with the
   one-line diagnostic on the box.
2. **#1 SDK answer spike** — cheap to run, de-risks the biggest item; do it early even if the UI
   comes later.
3. **#3 file-changes accordion** — standalone, high value after every task.
4. **#2 allowlist** then **#1 questions UI** — both rework the approval bridge; do the simpler
   allowlist first, then layer questions on the same machinery.
5. **#5 .env editor** — standalone; slot in anywhere.

Dependencies: #1 and #2 share `#canUseTool` / `resolveApproval` / the approval protocol — plan
them as one stretch. #3, #4, #5 are independent.
