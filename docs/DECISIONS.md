# Decisions

Load-bearing choices, why they were made, and what would justify revisiting them.
Written before implementation, so the rationale outlives the memory of the conversation.

---

## 1. Not VS Code

The instinct is to fork VS Code or run code-server. The Claude Code extension *is*
published to Open VSX, so this would work.

It's the wrong product. VS Code's command palette, file tree, tab bar, and diff gutters
all assume a mouse and roughly 1400 horizontal pixels. On a tablet it's tolerable; on a
phone it's a demo you show once.

The reframe: on a phone you are not typing code. You are directing an agent and reviewing
its output. That's a chat pane, a diff reviewer, a terminal tail, and a preview — four
surfaces that all work at 390px, and a far smaller thing to build.

**Would change our mind:** never, for the phone. If a tablet-first mode became the
priority, code-server is a real option again.

---

## 2. The extension is a reference design, not a dependency

"All the features the Claude Code extension has" is reachable without the extension,
because the extension is itself a UI over the same `query()` event stream we consume.

Its diff-with-approve-reject is the `canUseTool` callback intercepting Edit/Write before it
lands. Plan review mode is a message rendered as markdown. Parallel conversation tabs are
multiple sessions. `@`-mentions are a file picker injecting paths into the prompt.

Treat it as a very good spec, written by people who already made the mistakes.

---

## 3. Installed PWA, not native

The three hardest surfaces — editor, terminal, preview — are all fundamentally web.
CodeMirror and xterm.js are web components; the preview is a browser rendering a dev
server. A React Native app would be native chrome around three WebViews: a better tab bar
in exchange for a bridge across every interaction that matters.

The usual native advantages don't apply. Background execution is unnecessary because the
agent runs server-side. iOS has supported web push from home-screen-installed PWAs since
16.4, which covers "your agent needs approval." App Store distribution is pure cost for a
personal tool — signing, a developer account, TestFlight builds expiring every 90 days.

A web client is needed for desktop regardless. One codebase.

**Known weakness:** iOS Safari suspends backgrounded pages, killing the SSE connection.
This is precisely what the event log and `Last-Event-ID` resume are for — see #5 and #6.

**Reversible:** Capacitor wraps the same PWA for native push in roughly a day.

---

## 4. The agent runs inside the container

Claude Code's tools — Read, Edit, Bash — are local filesystem operations. Co-locating the
agent process with the repo makes them work by construction.

The alternative, a control-plane server that shells into a remote box, means
reimplementing a filesystem over RPC. The project would become that, instead of an editor.

So the container holds the repo, the dev server, *and* the Node process hosting the Agent
SDK.

---

## 5. The event log is the source of truth

Every message from the SDK is appended to an append-only SQLite table with a monotonic
`seq`. Nothing else on the server is durable.

This is the decision the rest of the architecture hangs from:

- **Reconnect is free.** The client is a view over a log with a cursor, not a WebSocket
  peer. Phone backgrounding stops being an error case.
- **Restart is always safe**, so restarting the server during development costs nothing.
- **Every future table is a projection.** Sessions list, projects list, "what changed
  Tuesday" — all reads over the log. You never migrate data, you write a new query.

That last property is what makes "MVP and build up" honest rather than a euphemism for a
rewrite in three months.

**One writer, and it is now enforced.** The global monotonic `seq`, the boot recovery that
closes open sessions as `interrupted`, and `pendingApprovals()` meaning "promises *this*
process lost" all assume exactly one server owns the log. That assumption was unenforced,
and `node --watch` broke it immediately: the replacement process booted before the old one
finished dying, ran boot recovery, and expired an approval that was still live in the
predecessor. The log ended up with an `approval_expired` and a contradictory
`approval_decision` for the same id, and one session ended twice.

SQLite's WAL kept the file intact through that. It did not keep the meaning intact.
`lock.ts` now takes an exclusive `O_EXCL` lock beside the database before anything reads
it, waits out a dying predecessor, and reclaims the lock if the holder's pid is gone.

**Corollary:** Claude's own `session_id` and our event log are *two different histories*.
Claude's is its conversation context, used for `resume`. Ours is the render log for the
UI, a superset holding approvals, file opens, and terminal output. Conflating them means
reconstructing UI state from an LLM transcript.

---

## 6. SSE for the agent stream, WebSocket only for the terminal

The reflex is WebSockets everywhere. It's wrong here.

The agent stream is server-to-client only — prompts go up as ordinary POSTs. That's what
Server-Sent Events are for. And SSE has a feature that maps onto the event log exactly:
on a dropped connection the browser reconnects on its own, sending `Last-Event-ID` with
the last event it saw. If event IDs *are* the log's `seq`, reconnect-and-replay is solved
by the platform. You write `WHERE seq > ?` once.

The terminal genuinely needs bidirectional bytes. That one's a WebSocket to node-pty.

**Built (Phase 4).** The terminal WebSocket is live (`routes/terminal.ts`). One wrinkle the
sketch didn't anticipate: the preview reverse-proxy (`@fastify/http-proxy`) installs a *single
shared* `upgrade` listener that 404s anything it doesn't recognize, and Node fires upgrade
listeners synchronously — so a second raw listener loses the race. The terminal takes over the
server's upgrade handling in an `onReady` hook (after every plugin has installed its own),
claims its path, and delegates everything else back to the proxy. See #24 for the security shape.

---

## 7. Do not log token deltas

Log complete assistant messages. The typing-effect is worth roughly nothing on a phone,
and streaming deltas into the log would multiply its size and make replay-from-`seq`
strange to reason about.

If the effect is wanted later: SSE permits events without an `id:`, which stream through
without advancing `Last-Event-ID`. Deltas ride that channel; durable events ride the
numbered one. Clean separation, but a v2 concern.

---

## 8. Approval prompts are the review surface

Auto-approve Read, Grep, and Glob. Prompt on everything else, including Bash. The mechanism
is the SDK's `canUseTool` option, which returns a promise — see ARCHITECTURE.md.

We also pass `settingSources: []`, so no user or project settings load inside the container.
A stray pre-approval rule in someone's `~/.claude` would silently bypass the approval card,
which is the one thing this project cannot allow to happen quietly.

`bypassPermissions` is tempting for an "isolated environment" and would be defensible on
security grounds — the container is disposable and git is the safety net. But it would
turn off the feature being built. The approval card *is* the review UI.

**Correction, from the first real session.** We predicted this would prompt on `ls`, and it
does not — because our `canUseTool` is the *second* filter, not the first. Claude Code's own
permission engine classifies tool calls before any reach us: under `permissionMode: 'default'`
it allows read-only operations silently and escalates the rest.

Verified rather than assumed. In one session `pwd && ls`, `grep -ril`, and `grep -n` all ran
with no card. A probe against a scratch directory confirmed the other half: `touch probe.txt`
raised an approval card and the file was never created.

So the allowlist we planned to derive from a week of rubber-stamping already exists, is
maintained upstream, and is better than the one we'd have written. `AUTO_APPROVED` stays as
belt-and-braces for Read/Grep/Glob. What survives from the original reasoning is the part
that mattered: the card is a review surface, so never reach for `bypassPermissions`.

A mutating Bash command stops and asks; a read-only one doesn't. That is the behavior you
want — a card for every `ls` would bury the cards that matter.

**Two later refinements to the allowlist.** `AUTO_APPROVED` grew a sibling, `PLANNING_TOOLS`
(`TodoWrite`, `TaskCreate`/`TaskUpdate`/`TaskList`): side-effect-free bookkeeping that drives the
live task-list card. Gating those behind a card was a real bug — every checklist update raised a
"Claude wants to use TodoWrite" prompt, so the model reverted to prose plans and the card rarely
rendered. And the opposite move at the other end: `git commit` / `git push` are now **denied**
outright, ahead of the allowlist, because committing is the user's job now (see #23).

---

## 9. Approval cards live inline in the conversation

Not in a separate diff tab. The conversation *is* the review: you scroll, read what Claude
intends, see the diff in place, tap approve, keep scrolling.

Render unified diffs, not side-by-side. Two columns at 390px is unreadable.

Note that `Edit` tool calls hand you `old_string` and `new_string` directly — you already
have both sides and need no diff library. Only whole-file `Write` needs real line-diffing.

---

## 10. SQLite, not Postgres

One writer, one reader, no concurrency story, and durability satisfied by copying a file.
Postgres here is ops work in exchange for nothing.

**Would change our mind:** multiple workspace containers writing one log. At which point
the answer is probably a log *per workspace* rather than a bigger database — see #13.

---

## 11. CodeMirror 6, not Monaco

The load-bearing library choice. Monaco *is* VS Code's editor, and its touch handling is
an afterthought: text selection, the virtual keyboard, and the scroll container fight each
other on a phone. CodeMirror 6 is about a tenth the weight, handles touch and soft
keyboards properly, and gets syntax highlighting from Lezer.

---

## 12. Tailscale is the authentication story

Put the box on your tailnet and membership *is* authentication. Don't build a login screen
for a service only you can reach.

This also collapses TLS: `tailscale serve` terminates HTTPS on a `*.ts.net` hostname, so
there's no certificate management and nothing is publicly exposed.

---

## 13. Single tenant, and multi-tenancy would live *in front*

The workspace server handles exactly one user's container. It has no concept of accounts,
authenticates nobody, and doesn't know other users exist.

That is true today because there is one user, and it stays true in any multi-tenant future
because each user would get their own instance of it. **Multi-tenancy is added in front of
the workspace server, never through it.** A control plane authenticates, picks a container,
and proxies. The workspace server never changes.

So the single-tenant server *is* the multi-tenant one. Nothing needs preparing.

Adding auth to the MVP would give the *feeling* of having prepared while addressing none of
the real cost. What actually changes when a second person appears is that **the container
stops being a convenience and becomes a security boundary**:

- Containers can't be shared — Claude has Bash, so one user could read another's repos and
  tokens. Per-user workspace lifecycle, and therefore a control plane.
- Docker isolation is not generally considered sufficient against hostile code. You'd want
  Firecracker or gVisor, or rent that from Fly / E2B.
- You'd be executing strangers' code and serving it from your domain. Egress filtering and
  an abuse story, because someone will mine crypto or host a phishing page.
- Preview goes from `tailscale serve` on a port to wildcard DNS, a wildcard cert, and auth
  in front of it, since a dev server can contain data.
- **Anthropic forbids third parties offering claude.ai login.** Your subscription cannot
  cover other users. Each brings an `ANTHROPIC_API_KEY`, which means encrypted per-user
  secret storage, rotation, cost accounting — and an onboarding flow whose first step is
  "go create an Anthropic API key."

Two to three months, almost none of it the editor. And the last item has no technical
answer: it turns a delightful personal tool into a product with a hostile first five
minutes.

**Scales along:** more projects, more devices. **Does not scale along:** more users. That's
not a bigger version of this project; it's a different one sharing a UI.

---

## 14. Cheap insurance we *are* buying now

Free today, irritating to retrofit:

- **`session_id` and `project_id` on the events table from the first migration**, even
  though both hold one value for months. Two unread columns cost nothing; a log without
  them needs backfilling.
- **`seq` is a global autoincrement, not per-session.** A single writer means a total order,
  and SSE's resume contract wants exactly that. Replay stays
  `WHERE seq > ? AND session_id = ?` when multi-session arrives.
- **`AgentSession` is a class**, instantiated once. Not module-level globals. Multi-session
  then becomes `Map<sessionId, AgentSession>` rather than untangling state.
- **One `api.ts` on the client.** The day URLs gain a workspace prefix it's a ten-minute
  change, not an afternoon of grep.
- **Credentials read from one config module.** `CLAUDE_CODE_OAUTH_TOKEN` today; a
  container provisioned for someone else would get `ANTHROPIC_API_KEY`. Config change, not
  a hunt.
- **The workspace server is incurious about its host.** No absolute paths outside
  `/projects`, no reaching into host environment, all configuration injected. This is what
  makes it safe to run N copies of.

---

## 15. One container, many projects — until toolchains conflict

`/projects/<name>`, with `project_id` on the log. A picker screen. No architectural change.

The thing that eventually forces container-per-project is conflicting toolchains: two Node
majors, or a Python project beside a Rust one. You'll know. Until then, one image with a
few runtimes covers most personal work.

---

## 16. Preview: one HTTPS port per project

Path-based proxying (`/preview/myproject/`) looks tidy and breaks, because Vite emits
absolute asset paths like `/assets/index.js` that 404 one directory up. Fixing it means
rewriting HTML and JS in flight.

Instead let `tailscale serve` TLS-terminate a port per project: app on `https://box.ts.net`,
dev server on `https://box.ts.net:5173`. Each preview sits at an origin root, so absolute
paths resolve, and both sides are HTTPS so there's no mixed-content block when framed.
Cross-origin framing is fine — we never need JS access into the frame.

Assign the port in project settings. Detecting which port a dev server grabbed is more
annoying than it sounds.

**Always ship an "open in new tab" button.** Any app setting `X-Frame-Options` refuses to
frame at all, and Vite's HMR websocket needs to be told what host it's behind or the page
loads and then silently stops updating.

---

## 17. `gh`, not a git library

`gh auth login` once inside the container and GitHub authentication is done — clone, push,
PRs. Pass arguments as an argv array; never build shell strings.

A GitHub App is multi-tenant machinery. Not this project.

---

## 18. Half the feature list is convenience, not capability

Git push/pull/branch, Vercel deploy, scaffolding a project, searching the filesystem —
Claude does all of these through Bash on day one. A git UI adds no capability; it adds a
button for something you could type. Vercel "integration" is `vercel deploy` with a token
in the environment.

Genuine capability — things that don't exist unless built — is short: the agent session
and its log, the diff review UI, an editor that works under a thumb, the preview, and
project open/clone.

This matters for ordering. The convenience features feel most concrete and will eat the
first three weekends if allowed to.

---

## 19. React + Vite, not Next.js

Considered seriously, since Next is the more familiar stack here. Rejected for the client,
and rejected emphatically for the server.

**Next's value proposition doesn't apply.** File-based routing, server components, server
actions, SSR, middleware, ISR — the MVP is one screen with no server rendering, no SEO, no
static content, and every byte behind Tailscale. It's an `EventSource`, a reducer, and three
components. The React is character-for-character identical either way, so the familiarity
advantage is close to zero.

**Next as the client, via `output: 'export'`,** would have worked. Fastify still serves the
build, every other decision holds. But static export disables route handlers, server
actions, middleware, and SSR — which is to say it disables the parts of Next you'd be
familiar with, leaving file-based routing for about six routes. Paid for with a fiddlier
service worker (Phase 1 is web push, and `vite-plugin-pwa` is the more direct path), a
heavier dev loop, a larger image, and CORS in dev but not prod. Defensible; not chosen.

**Next as the whole server** was the real trap, and it breaks at the three points this
project leans on hardest:

- **`next dev` reloads server modules on save**, destroying live `query()` generators and
  pending approval promises. You'd kill Claude mid-refactor to adjust a button's padding.
  Stashing state on `globalThis` mitigates it, but generators holding promises across module
  reloads is fragile ground.
- **App Router route handlers cannot upgrade to WebSocket.** Phase 4's terminal would force a
  custom Next server — precisely where Next's benefits stop.
- **`node-pty` and `better-sqlite3` are native modules** needing bundler config to stay
  external.

More fundamentally: Next's request model assumes short-lived, stateless handlers. The
workspace server is long-lived, stateful, and single-writer. Working against that grain to
ship a rendering framework into a container whose job is running an agent is a bad trade.

**Would change our mind:** the multi-tenant product (see #13), which wants a marketing site,
auth, and billing. Next is the right base for *that*. It shares a UI with this project and
almost nothing else.

---

## 20. Tailwind for everything except the rules that need a reason

Phase 0 shipped 380 lines of hand-written CSS while the stack table said Tailwind. The
divergence was never argued, just drifted into. Reconciled in favour of Tailwind 4, with a
deliberate exception.

**Why Tailwind wins here.** Not because the app is large — six components is nothing. Because
`fitnessTracker` is shadcn and Tailwind, so it's the stack you're fluent in, and this is a
tool you will keep tweaking. If changing the padding on a card means learning someone else's
class names, you stop touching the UI. That is the same argument that decided #19, pointing
the other way.

Tailwind 4 needs no config file: the theme is `@theme` in `styles.css`, and
`@tailwindcss/vite` scans sources automatically.

**Why some CSS stays.** A handful of rules exist *only* because of the paragraph above them:

- `.messages > * { flex-shrink: 0 }` — an overflowing flex column shrinks items toward their
  automatic minimum size, and `overflow: hidden` makes that minimum zero, so the approval card
  collapses to a hairline. This happened. It cost an evening.
- `.approval-pending { position: sticky }` — a pending approval blocks the agent, and
  permission prompts have no deadline. A card that scrolls out of reach hangs the agent.
- `.app { height: 100dvh; padding-bottom: var(--keyboard-inset) }` — `100vh` is a lie whenever
  the virtual keyboard is open.
- `.prompt-input { font-size: 16px }` — anything smaller makes iOS Safari zoom on focus and
  never zoom back.

Expressed as `[&>*]:shrink-0` in JSX, those comments would live next to the markup they don't
describe, or not at all — and the next person deletes them. Four rules, four paragraphs, one
file.

**A hazard worth knowing.** A misspelled utility emits nothing and fails silently. We shipped
`overflow-wrap-anywhere` (not a real class) and caught it only by grepping the built CSS.
Nothing in the toolchain will tell you. When a style mysteriously doesn't apply, check the
generated stylesheet before you debug anything else.

---

## 21. Deploy on Fly, with Tailscale inside the container

Where the always-on box lives, decided after the fact (Phase 0's docs assumed a VM). The
container was always the portable unit ([#13](#13-single-tenant-and-multi-tenancy-would-live-in-front)),
so this is a deploy-target choice, not an architecture change.

**Free was the goal; free lost to capacity.** Oracle Cloud's Always Free A1 (arm) is the only
free tier with enough RAM. We built the whole VM runbook ([DEPLOY-ORACLE.md](DEPLOY-ORACLE.md))
and hit "Out of host capacity" across every availability domain — the well-known Oracle
free-arm lottery. Free A1 is home-region-only and the home region is fixed, so switching
regions doesn't escape it. The honest options were: fight the lottery with an auto-retry
script, or pay. We paid.

**Fly over a plain VPS** (Hetzner would also have worked, cheaper) because Fly is the one that
grows into the multi-tenant future: a Machine *is* a per-user workspace container, Firecracker
gives the isolation [#13](#13-single-tenant-and-multi-tenancy-would-live-in-front) said you'd
need, and `fly deploy` builds the image fresh for the target arch — so the arm-vs-amd concern
that haunted the VM path simply vanished. Cost: ~$5–10/mo. Fly has **no free tier** (retired
2024); "free" and "Fly" don't coexist, and that was named before committing.

**Tailscale moved inside the container.** On a VM, `tailscale serve` ran on the host. Fly has
no host — the container is the unit — so the image carries `tailscaled` and brings it up in
userspace mode (no `/dev/net/tun`, no root), gated on `TS_AUTHKEY` so local and VM runs are
untouched. This *preserves* the security model exactly: nothing on `*.fly.dev`, no auth on the
server, Tailscale is the perimeter. It was the one piece untestable before deploy; it came up
clean and `mce` joined the tailnet beside the phone and Mac.

**Not Vercel for the frontend**, though it comes up naturally. The frontend isn't a separate
deployable — it's static files the workspace server serves, same-origin, which is what deleted
CORS, the SSE-CORS special case, mixed content, and push/service-worker scope. Hosting it on
Vercel would force the backend public (exposing an unauthenticated agent), reinstate CORS, and
buy nothing. Vercel's real fit is the *far-future multi-tenant front door* — marketing, auth,
billing — never the workspace containers. See [#19](#19-react--vite-not-nextjs).

**One volume, everything under `/data`.** Fly Machines allow exactly one volume per machine.
The event log, the projects (`/data/projects`), and Tailscale state (`/data/tailscale`)
all live under it. `PROJECTS_ROOT` points the server there; the VM/local default of
`/projects` still holds. An empty volume just boots to an empty picker — projects are
added through the app, not seeded. (An earlier `PROJECT_PATH=/data/projects/app` +
`PROJECT_REPO` auto-clone re-created a project named "app" on every deploy, fighting
anyone who deleted it, and was removed.)

**Would change our mind:** going truly multi-tenant re-opens all of this — per-user Machines,
a control plane in front, and the Tailscale-per-container model gives way to a real ingress.
That's [#13](#13-single-tenant-and-multi-tenancy-would-live-in-front), still a different product.

---

## 22. No emoji in the UI — lucide-react icons

A rule, set after emoji had crept into the header and buttons (🔔, 🕘) and glyph
chevrons (▾ ‹ ›) stood in for icons.

**Never use emoji, or unicode symbol glyphs, as UI** — buttons, labels, status,
affordances. Emoji render differently on every platform and font, can't take a
color/size/stroke to match the design, and read as unfinished. Reach for
[lucide-react](https://lucide.dev) instead: consistent SVG icons that inherit
`currentColor` and size cleanly (`className="size-4"`).

```tsx
import { Bell, History, ChevronDown } from 'lucide-react'
<Bell className="size-4" />
```

**Fine to keep:** typographic ellipses (`…`) for truncation and the diff gap
marker — those are text, not icons. The rule is about icon/affordance glyphs.

**Would change our mind:** nothing foreseeable. If an icon is missing from lucide,
add an inline SVG that follows the same `currentColor` + size conventions.

---

## 23. The agent does not commit — the user commits from the app

The agent is **denied `git commit` and `git push`** (in `#canUseTool`, ahead of every allowlist
and standing rule, so it can't be bypassed). It's told to leave its work in the working tree.
Committing and pushing happen in the app's **Source control tab**: you review each changed file
with a checkbox, the Commit & push button unlocks only once every file is reviewed, and pressing
it runs `git commit` then a best-effort `git push` server-side (`routes/git-ops.ts`).

This is the same instinct as #8 — *the review surface is the UI, not a rubber stamp* — carried
one step further. An approval card for a `git commit` reviews the **command**; it can't show you
the actual per-file diff you're about to enshrine in history. The Source control review does,
and it makes "what gets committed" an explicit, file-by-file decision instead of a wall of text
in a Bash card. Pushing is the user's call for the same reason it always was — it's outward-facing
and hard to reverse, so it should be a deliberate button press, never a thing the agent does mid-turn.

After a successful commit the app sends the thread a short summary prompt ("[Source control] I
committed and pushed N files…"), so the agent knows the work landed and continues from a clean
tree rather than trying to commit again. Push stays best-effort: no upstream → local-only; a push
failure leaves the commit in place and says so, both in the UI and in the note to the agent.

**Would change our mind:** if a genuinely headless flow needs the agent to commit (a scheduled
job with no human at the review surface), this would need a scoped, per-project opt-out. Nothing
in the interactive product wants it.

---

## 24. The terminal is an unrestricted shell — safe because we're single-tenant

Phase 4's terminal (`routes/terminal.ts`) spawns a real shell in the project directory over a
WebSocket. It is **deliberately unrestricted**: unlike the agent, it does *not* go through
`canUseTool`, and unlike the file endpoints it does *not* go through `resolveSafe`. It's your
shell — the same thing the terminal on your laptop is. `cd /`, `rm -rf`, `curl`, whatever.

That's the right call **for a single tenant**, and it rests on two things that are actually
load-bearing, not the shell itself:

- **The container boundary protects the host.** On Fly each Machine is a Firecracker microVM,
  and the process runs **non-root** (`USER node`, no capabilities). Escaping to the host/other
  tenants means escaping Firecracker — a very high bar. So a shell user can trash *this* container
  (delete `/projects`, delete `/data/events.db`, exhaust RAM/CPU) but the blast radius is one
  disposable, redeployable box.
- **Tailscale is the perimeter** (#12). Nothing is publicly reachable; only your tailnet can open
  a socket at all.

**The line this must not cross: multi-user.** The architecture is single-tenant (#13), and a
login screen would be a *false* fix — every user would still share one filesystem, one OS user,
one shell, and one set of secrets (the terminal inherits `process.env`, so `env` prints the
`CLAUDE_CODE_OAUTH_TOKEN`). User A could read and delete User B's work and steal the shared token.
So multi-user is **a container (Fly Machine) per user**, not shared-with-auth: each user gets their
own microVM, their own secrets (they bring their own token), and their own resource quota. The
terminal stays "trusted" because the box only holds that user's stuff. This is exactly what #13
means by "multi-tenancy would live *in front*."

**Cheap single-tenant hardening, if wanted (not yet done):** scrub the secret env vars from the
shell (the agent process keeps them; the shell rarely needs them), and set `ulimit`s on the PTY to
blunt fork bombs / disk fill. Neither changes the boundary above; they just shrink the footgun.

**Would change our mind:** nothing about the single-tenant model. The day this goes multi-user,
none of the above is optional — isolation comes first, features second.
