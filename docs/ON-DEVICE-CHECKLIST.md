# On-device checklist — Phase 2 through the UX polish pass

Four phases plus a UX overhaul have shipped since the last on-device acceptance test (Phase 1,
push notifications). Everything below is built, committed, and passes `typecheck` + the test
suite, but has only been verified locally or via curl. This is the backlog of "does it actually
feel right on a phone" checks before picking the next phase off [ROADMAP.md](ROADMAP.md).

Work top to bottom — later sections assume earlier ones pass. Check off as you go; if something
fails, note the repro under it rather than stopping the whole pass (most of these are
independent).

---

## Result — 2026-07-12

Full pass, on-device, over Tailscale. **Everything passed except two known UI bugs**, both
deferred rather than chased now (see below) to avoid an open-ended polish loop:

1. The `dvh` black-strip fix (`c8c89f1`) **did not hold** — the dead strip still appears below
   the app on cold launch in at least one real-device case the local/simulator check missed.
2. **PromptBox** still stutters/glitches at the 1→2 line transition while typing — a visible
   hitch, then it self-corrects and renders normally. Not blocking, just rough.

Both are logged as known issues rather than fixed inline. Everything else below — Phase 2,
2.5, 2.6, all five Phase 2.7 items, and the rest of the UX pass — **passed on-device**.

---

## 0. Baseline sanity

- [x] App loads over Tailscale on cellular (not just wifi/couch).
- [x] PWA is installed to the home screen and launches full-screen, no browser chrome.
- [ ] No dead black strip below the app on cold launch (the stale-`dvh` fix — `c8c89f1`).
      **→ KNOWN ISSUE, deferred.** Still reproduces on-device; the earlier fix didn't fully
      hold. See "Known issues" at the bottom.

---

## 1. Phase 2 — Projects ([PHASE-2.md](PHASE-2.md)) — ✅ passed on-device

- [x] Clone a **second** repo from the picker (search your GitHub repos, or paste a URL).
- [x] Switch to it — header/nav shows the new project as active.
- [x] Prompt each project once.
- [x] Switch back to the first project — its conversation history is intact, **not** bled
      together with the second's.
- [x] Create a brand-new repo from scratch (Create tab) — private/public toggle, name
      availability check — and confirm it's pushable (`git push` works from a prompt).

## 2. Phase 2.5 — Threads ([PHASE-2.5.md](PHASE-2.5.md)) — ✅ passed on-device

- [x] Inside one project, start a second thread ("New thread") — first thread's history still
      opens correctly from the thread list.
- [x] Force a resume: leave a thread mid-conversation, navigate away, come back — continues
      via native resume (or recap, if the container restarted) without losing the thread.
- [x] A legacy/no-thread-id conversation (if any exist) surfaces as a single "Earlier
      conversation" bucket, openable.

## 3. Phase 2.6 — Visible project setup ([PHASE-2.6.md](PHASE-2.6.md)) — ✅ passed on-device

- [x] Clone a repo and **watch the build panel**: phase label (Cloning… → Installing…),
      indeterminate bar, "Show terminal" expands to live output.
- [x] Cancel a build mid-clone — directory is cleaned up, you land back on the picker.
- [x] Let a build finish while the app is backgrounded — push notification "Project ready"
      arrives.
- [x] Make an install fail on purpose (e.g. a repo with a broken `package.json`) — clone is
      kept, panel finishes "ready with a warning," not deleted.
- [x] Switch to a different project while a build is running — build panel stays tied to the
      building project and picks back up when you return to it.

## 4. Phase 2.7 — Control & editor enhancements ([PHASE-2.7.md](PHASE-2.7.md)) — ✅ passed on-device

- [x] **#1 Questions UI** — get Claude to call `AskUserQuestion` (e.g. ask it to use the tool
      to clarify something ambiguous). Confirm it renders as the real picker (segmented,
      one-at-a-time with a tab strip, radio/checkbox + descriptions), not raw JSON, and the
      answer actually reaches the agent.
- [x] **#2 Always-approve allowlist** — approve a Bash command with "Always approve," then
      trigger the same command again and confirm it auto-approves with no prompt. Confirm the
      rule is scoped to *this* project (a different project still prompts).
- [x] **#3 Changes accordion** — after a turn that edits files, confirm the end-of-turn
      accordion lists changed files with +/− counts, and each expands to its diff.
- [x] **#4 Git identity** — make a commit, then `git log -1 --format='%an <%ae>'` (or check the
      boot log) and confirm it reads your `reynaldos` GitHub identity, **not** `mco@local`.
      This was the one item the docs explicitly flagged as needing this exact confirmation —
      confirmed.
- [x] **#5 `.env` editor** — open a project's env editor, scaffold from `.env.example`, edit a
      value, save, and confirm the project's actual `.env` file on disk changed.

## 5. UX polish pass (undocumented as a phase — this is the work from the last 24h)

- [ ] **PromptBox** — type a multi-line prompt; box grows without DOM-churn glitches or
      losing textarea focus. Expand to the drawer via the top-right icon for a long prompt.
      **→ KNOWN ISSUE, deferred.** A visible stutter/glitch at the 1→2 line transition while
      typing — it self-corrects and renders normally after, but the hitch is real. See "Known
      issues" at the bottom.
- [x] **Image attach** — attach a photo to a prompt; confirm it reaches Claude as multimodal
      input (ask it to describe the image).
- [x] **Notifications** — background the app, send a prompt needing approval from another
      device/session if possible; confirm it does **not** buzz a screen that's already open
      and looking at the conversation, but does buzz one that isn't.
- [x] **Assistant replies** — confirm markdown renders properly (lists, bold, etc.) and fenced
      code blocks show as real code panels, not broken inline spans (today's last commit,
      `e83056c`).
- [x] **Tool-call bursts** — a turn with several tool calls collapses into a "Worked Xm Ys" row
      instead of listing every call inline; expand it and confirm the detail is still there.
- [x] **Header** — connection status reads cleanly (dot/label decluttered) and the branch name
      shows under the repo name.
- [x] No stray bubble styling left on assistant messages (visual check).

## 6. Regression / always re-check — ✅ passed on-device

- [x] **Reconnect.** Lock the phone mid-turn, wait, unlock — nothing lost, stream picks back
      up (the Phase 0 acceptance clause; re-verify it still holds after all the client
      changes above).
- [x] Airplane mode mid-turn, then back on — same as above.
- [x] Approve/reject a plain diff (the original Phase 0 flow) still works end to end.

---

## Known issues (deferred, not fixed)

Both found during this pass. Deliberately tabled rather than chased immediately — this UX
polish stretch was already open-ended, and debugging CSS/layout glitches by feel invites going
in circles. Revisit as their own small, scoped fix — ideally with a repro nailed down first
(device/OS/browser, orientation, whether it's reproducible every time or intermittent) so the
fix is a fix and not another round of poking at it.

1. **`dvh` black strip still appears on cold launch**, despite `c8c89f1`. That commit fixed the
   case it targeted but not this one — likely a different trigger (e.g. a specific
   backgrounded→foregrounded transition, or a viewport resize path the original fix didn't
   cover). Needs its own repro before the next attempt, not a second guess at the same fix.
2. **PromptBox stutters at the 1→2 line transition.** Self-corrects, so not data-losing or
   blocking — just a visible hitch while typing. Likely the same family of DOM-churn issue
   `114de23`/`80fec84` addressed for other transitions, just not this specific one. Worth a
   profiler pass (React re-render / layout thrash at that exact height change) rather than
   another blind CSS tweak.

## If something breaks

Log it here or as a fresh doc (see the `PHASE-0.md` write-up style — what broke, why the design
didn't predict it, the fix) rather than silently patching. That's the pattern this repo's docs
already follow, and it's what makes the next roadmap update accurate instead of optimistic.

## Status

**This pass is done.** Update [ROADMAP.md](ROADMAP.md)'s "Where we are" table — mark Phase 2 /
2.5 / 2.6 / 2.7 on-device-verified (with the two known issues above noted, not blocking), add
the missing 2.6/2.7 rows, and drop the stale "CI/CD not yet wired to a GitHub repo" line (PRs
are already merging through it). Then pick Phase 3 (files/editor) vs Phase 5 (preview) per the
roadmap's own advice: let what you actually reached for during this pass decide it.
