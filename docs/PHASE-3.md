# Phase 3 — Files and editor

File browser with ripgrep-backed search. CodeMirror 6, read-only first, then editable. This is
where the FS/exec RPC surface gets built — the same surface Terminal (Phase 4) and Git UI
(Phase 6) sit on top of.

This doc is a workshop draft. Nothing is built yet. Branch: `phase-3/file-browser-editor`.

**Status.** UX shape being worked out below — one open question (drawer vs. full-screen panel)
now has a recommendation; several others are still genuinely open. No server or client code
written.

---

## The starting idea

> A button on the project card and in the nav bar actions, labeled "Explorer" with a files
> icon. A second button, "Source control," opens a git-style view of file changes. The explorer
> looks like VS Code's sidebar — an accordion of files and folders you scroll through. Header:
> back arrow or close (top-left, depending on which UI shape we land on), project title
> (center), a vertical-dot action button (right) opening a popup of future actions. Not yet
> decided: full-screen slide-in-from-the-right, or a drawer that slides up and can be hidden.
> After that, the file viewer/editor — maybe its own drawer, maybe several hidden drawers along
> the bottom acting like tabs, only one open at a time.

The reference screenshot is VS Code's Explorer sidebar: a nested, collapsible file/folder tree,
folders sorted before files, colored file-type glyphs, no line-count or size noise per row —
just the name.

---

## Design calls (proposed — confirm before building)

### 1. Bottom drawer, not a right-side slide-in panel

**Recommendation: bottom drawer.** Every secondary surface already in this app — Env editor,
Clone/Create forms, Preview — is a `vaul` bottom sheet: rounded top corners, a drag handle,
swipe-down to dismiss, snap points for partial/full height. There is no slide-from-the-right
panel anywhere in the codebase today. Introducing one for Explorer specifically would mean:

- A second, one-off animation/gesture system to build and maintain (vaul gives drag-to-dismiss
  and snap points for free; a right-panel slide needs its own transition and its own dismiss
  gesture, hand-rolled).
- A control in the hardest one-handed reach zone on a phone — top-left, on a screen you're
  already holding to thumb-approve diffs. [DECISIONS #11](DECISIONS.md) chose CodeMirror over
  Monaco specifically because of touch/thumb ergonomics; a top-left-anchored close control cuts
  against that same thesis.
- A visual pattern (full-screen panel sliding in from the edge) that reads as "pushed a new
  screen," which invites an edge-swipe-back gesture — but this is a PWA with no OS back-swipe,
  so you'd be building a gesture users expect from muscle memory that doesn't actually exist
  here.

Using the drawer buys the stuff already solved elsewhere in this app: keyboard-safe-area
handling, the `88vh`/`0.95`-snap-point convention (`ui/drawer.tsx`, `PreviewDrawer.tsx`),
drag-to-dismiss, and a header pattern everyone's eyes are already trained on.

**One difference from Preview's drawer:** Preview is **non-modal** and **peekable** because a
dev server keeps running underneath and you want the thread reachable while it's alive.
Explorer isn't running anything in the background — closing it and reopening it costs nothing.
Propose the **modal** `Drawer` (the one `EnvDrawer`/Clone/Create already use), opened straight
to a tall snap point, no peek state. Simpler, and it matches the surface it's most like
(Env editor: browse/edit something on disk, then leave).

### 2. Header: confirms your shape, with one addition

Your header sketch — back/close (left), project title (center), kebab (right) — maps directly
onto stuff that exists:

- **Right kebab → reuse `ActionsMenu` verbatim.** It's already exactly "one vertical-dot button
  that opens a small popup of labeled actions" (`components/ActionsMenu.tsx`), already used in
  the nav bar today. No new component.
- **Left control: back arrow vs. close, resolved by depth, not by drawer shape.** At the file
  **tree** (top of the stack), left = **X**, fully closes the drawer. Once you've drilled into a
  **file** (tree → open file), left = **back arrow**, returns to the tree — same drawer, same
  open/close state, just an internal view change (mirrors how `PreviewDrawer`'s left control
  toggles raise/peek without unmounting anything). The physical drag-handle-and-swipe-down stays
  the primary dismiss gesture either way, per the vaul convention already established; the header
  control is there for anyone not gesturing.
- **Center title: changes with depth too.** Project name at the tree root (as you said); once a
  file's open, the **filename** (truncated, with an unsaved-changes dot) — you can already see
  which project you're in from the main nav underneath, so the filename is the more useful thing
  to show once you're inside one. **Decided 2026-07-14.**

### 3. Entry points: two menu items, not two new buttons

**Nav bar actions** (`App.tsx`'s `ActionsMenu`, next to Previous threads / New thread / Env /
Preview): add `Explorer` (files icon) and `Source control` (branch/diff icon). Same
`{ key, label, icon, onClick }` shape already used for the other four — trivial addition, opens
the drawer scoped to the active project.

**Project card:** `RowMenu` on each row in `ProjectPicker` already takes the same action-array
shape. Adding `Explorer` there lets you jump straight into a project's files *without* switching
into its thread first — different from the nav-bar entry, which acts on the project you're
already in. **Decided 2026-07-14: browse-without-switching.** The drawer scopes its RPC calls to
the row's `projectId` directly, independent of `activeProjectId` — the same way `RowMenu`'s
existing "Install dependencies" and "Remove" actions already operate on a row's project without
touching whichever one is currently active.

### 4. Explorer and Source control: one drawer, two internal views — not two drawers

VS Code's own sidebar is one panel with a switchable activity (Explorer / Search / Source
Control / …). Propose the same shape here rather than two separate drawer components: a small
two-icon view-switcher under the header (Files / Source control), one `ExplorerDrawer` owning
`view: 'tree' | 'file' | 'source-control'`. Keeps one open/close state, one place the FS-RPC
client lives, and avoids "which drawer is open" bookkeeping in `App.tsx`.

**Scope boundary worth being explicit about:** the roadmap already splits this — [Phase 3 is
file browser + editor], [**Phase 6 is Git UI**](ROADMAP.md#phase-6--convenience) (stage,
commit, push, buttons over commands Claude can already run). Adding a "Source control" *button*
now is pulling forward a **read-only** slice: a list of changed files (`git status
--porcelain`), each expandable into a diff. **Propose no stage/commit/push here** — those stay
Phase 6, on top of the same RPC surface once it exists. Flagging this so the phase boundary
moves on purpose, not by accident because a button sounded good.

`DiffView` (`components/DiffView.tsx`) already renders exactly this — unified, git-style,
sigil-and-color rows — for `Edit`-tool diffs in the message stream ([DECISIONS
#9](DECISIONS.md)). Source control reuses it as-is, fed `git diff -- <path>` output per file
instead of a tool call's `old_string`/`new_string`.

### 5. File tree: lazy, accordion, ripgrep search on top

Match the screenshot: folders before files, one level fetched at a time (expand a folder →
fetch its children), not the whole tree up front — a real repo's `node_modules`/`.git` would
make an eager walk slow and huge. Collapsed state can live in local component state, keyed by
path; no need to persist it across drawer closes for v1.

A search box above the tree hits ripgrep server-side (per the roadmap's own phrasing, "ripgrep-
backed search") and returns matches as a flat list, replacing the tree view while a query is
active — same "type to search, browse when empty" shape `ProjectPicker`'s repo search already
uses.

**Icon set, decided 2026-07-14: minimal, no new dependency.** Not the screenshot's per-language
colored glyph set — that needs a dedicated icon library this repo doesn't have. Instead, a small
extension-category map (code / json / markdown / image / generic) onto icons `lucide-react`
already ships (`FileCode`, `FileJson`, `FileText`, `Image`, `File`), plus `Folder`/`FolderOpen`.
Same instinct as the rest of this codebase's dependency choices — reach for what's already in
the tree before adding a package for a cosmetic win.

### 6. Editor: tabs, one mounted at a time, none unmounted while open

Your "hidden drawers along the bottom, like tabs" instinct is right in spirit but the mechanism
already exists in this codebase in a simpler form: `PreviewDrawer`'s iframe and its
terminal-output panel are never unmounted between states, only hidden via CSS, so scroll
position and live connections survive. Propose the same trick for open files: a slim horizontal
tab strip under the drawer header (filename + unsaved dot + × per tab), all open files' editor
state held in a `Map<path, EditorState>`, only the active tab's CodeMirror instance visible —
the rest hidden, not destroyed, so switching tabs doesn't lose scroll position or undo history.
Many tabs open → the strip scrolls horizontally, page itself never does (same rule `DiffView`
already states for wide diff rows).

**Tab cap, decided 2026-07-14: 8 open tabs.** Unlike a hidden DOM node, a hidden-but-mounted
CodeMirror instance still costs real memory on a phone browser tab, so unbounded isn't free the
way it would be for, say, hidden `<div>`s. A 9th tab opening evicts the least-recently-viewed
tab. Once editing ships (design call 7's second pass), the evictor skips any tab holding unsaved
changes — nothing gets silently dropped; you can still close it by hand from the strip.

### 7. Read-only first, then editable — sequencing, not two features

The roadmap already calls this: ship the tree + a read-only file view first, editing second.
Concretely: v1 opens a file in CodeMirror with `editable: false`; a second pass flips it on plus
a Save action (kebab, or a footer button) and a `file_saved` event ([PROTOCOL.md, "Later
additions"](PROTOCOL.md)) once it writes. This also buys a natural stopping point to actually
use the tree/viewer for a while — the same "does this thesis hold" check every prior phase has
built in — before committing to save/conflict/dirty-state handling.

### 8. FS/exec RPC surface — the part underneath the UI

Per [ARCHITECTURE.md](ARCHITECTURE.md) responsibility 5 and [PROTOCOL.md](PROTOCOL.md), this is
plain request/response, no new event types for the operations themselves:

- `GET /api/projects/:id/fs/tree?path=` — one level of children (name, type, maybe a git status
  badge later), not a recursive walk.
- `GET /api/projects/:id/fs/file?path=` — file contents (v1: read-only consumer).
- `PUT /api/projects/:id/fs/file` — write (second pass, once editing ships).
- `GET /api/projects/:id/fs/search?q=` — ripgrep, results capped and paginated like the repo
  search in `ProjectPicker`.
- `GET /api/projects/:id/git/status` — changed-files list for Source control.
- `GET /api/projects/:id/git/diff?path=` — unified diff text for one file, fed straight to
  `DiffView`.

**Non-negotiable, called out in the roadmap itself:** every one of these resolves `path` against
the project root and asserts the result is still under it, in one shared helper — not
reimplemented per route. The workspace server "must stay incurious about its host." This is the
single most important thing to get right before anything else here, since it's the one mistake
that turns a file browser into a container escape.

---

## Sketch of the work

**Server**
- One path-guard helper (`resolveProjectPath(projectId, path)` or similar) — everything below
  goes through it.
- `routes/fs.ts`: tree, file read, file write (behind the read-only-first flag/sequencing),
  ripgrep search.
- `routes/git.ts` (or folded into `fs.ts`): status, per-file diff.
- No new protocol event types for v1 (plain REST); `file_opened`/`file_saved` land when editing
  ships, per the "Later additions" sketch already in `PROTOCOL.md`.

**Client**
- `ExplorerDrawer.tsx` — modal `Drawer`, `view: 'tree' | 'file' | 'source-control'`, header per
  design call 2, view-switcher per design call 4.
- `FileTree.tsx` — lazy accordion, folder-then-file sort, file-type icon map.
- `FileSearch.tsx` — ripgrep-backed, same debounced-query shape as `ProjectPicker`'s repo search.
- `FileEditor.tsx` — CodeMirror 6, read-only in v1, tab strip per design call 6.
- `SourceControlView.tsx` — changed-file list, each row expanding into `DiffView` fed by
  `git/diff`.
- Two new entries in `App.tsx`'s `ActionsMenu`; optionally one new entry in `ProjectPicker`'s
  `RowMenu` (design call 3).

---

## Decisions made (workshopped 2026-07-14)

| Question | Decision |
|---|---|
| Drawer vs. full-screen slide-in-from-right | Bottom drawer (`vaul`), modal, no peek — consistent with every other secondary surface in the app |
| Header kebab | Reuse `ActionsMenu` as-is, no new component |
| Explorer + Source control | One drawer, two internal views, not two drawers |
| Source control scope | Read-only changes/diff list only; stage/commit/push stays Phase 6 |
| Open files | Tab strip, one CodeMirror instance visible, others hidden-not-unmounted |
| Editing | Read-only first (matches roadmap wording), Save/write as a second pass |
| Left-header control at depth | X at the tree root, back arrow once a file's open |
| Center title at depth | Project name at the tree root, filename once a file's open |
| Project-card entry point | Browse-without-switching, scoped to the row's project |
| File-type icon set | Minimal — `lucide-react` icons by extension category, no new dependency |
| Tab cap | 8 open tabs, LRU eviction (skips tabs with unsaved changes once editing ships) |

## Still open

1. ~~Left-header control at depth~~ — **resolved, see design call 2.**
2. ~~Center title at depth~~ — **resolved, see design call 2.**
3. ~~Project-card entry point~~ — **resolved, see design call 3.**
4. ~~File-type icon set~~ — **resolved, see design call 5.**
5. ~~Tab cap~~ — **resolved, see design call 6.**

Nothing left open from this pass. Next thing to pin down, whenever you're ready to start
building: the exact `fs/tree` response shape (what per-entry metadata beyond name/type is worth
returning up front vs. fetched lazily).

## Deferred deliberately

Editing beyond a single-file Save (multi-file rename/move/delete from the explorer), any git
write operation (stage, commit, push, discard — Phase 6), non-ripgrep-backed symbol/definition
search, and diff-apply/revert from the Source control view. All of these are real, but they're
Phase 6-shaped or beyond — the roadmap's own "do this only if you've missed it" caveat on this
whole phase applies double to anything past read-only browse + basic edit + basic save.

## Acceptance test (draft)

> From your phone, open a project, tap Explorer in the nav-bar actions. A drawer rises showing
> the file tree — folders collapsed, tap to expand one level at a time. Search for a filename;
> the tree gives way to a flat ripgrep-backed result list. Tap a file — the drawer's header
> swaps to a back arrow and the filename, CodeMirror shows the contents read-only. Open a second
> file from a back-navigation to the tree; both show as tabs, switching between them doesn't
> lose scroll position. Swipe the drawer down to dismiss; reopen — starts back at the tree.
>
> Tap Source control instead — a list of changed files appears; tapping one expands a unified,
> git-style diff (the same rendering as an `Edit` tool call in the thread). No stage/commit/push
> control exists yet — that's Phase 6.
