import type {
  ChangedFile,
  GitBranchesResponse,
  GitRefreshResponse,
  GitStashEntry,
  GitStatusResponse,
  GitUpstream,
} from '@mce/protocol'
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  FileDiff,
  GitBranch,
  Loader,
  Minus,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  checkoutBranch,
  commitFiles,
  discardFiles,
  fetchBranches,
  fetchFileDiff,
  fetchGitStatus,
  fetchStashes,
  refreshBranch,
  stashOp,
} from '../api.ts'
import { DiffView } from './DiffView.tsx'
import { RowMenu } from './RowMenu.tsx'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx'

interface Props {
  projectId: string
  /** Open a file in the editor's file view (the per-row "View file" action). */
  onOpenFile: (path: string) => void
  /** Fired after a git op that can change the project's branch/commit state, so the
   *  header + drawer branch subtitle (read from the project list) refetch. */
  onGitChange?: () => void
}

type SectionId = 'changes' | 'branches' | 'stash'

/**
 * Source control, organized as three accordions — Changes, Branches, Stash.
 * Changes is the commit-review surface (each file gets a checkbox; a Commit
 * button gated on reviewing every file runs a local `git commit`); Branches
 * switches/creates; Stash saves/pops. Everything is local-only: nothing here
 * reaches a remote, so no operation needs credentials.
 */
export function SourceControlView({ projectId, onOpenFile, onGitChange }: Props): React.JSX.Element {
  const [status, setStatus] = useState<GitStatusResponse | null>(null)
  const [error, setError] = useState(false)
  const [branches, setBranches] = useState<GitBranchesResponse | null>(null)
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  // One section open at a time; Changes is the default (the primary surface).
  const [open, setOpen] = useState<SectionId | null>('changes')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [message, setMessage] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [opError, setOpError] = useState<string | null>(null)
  // Paths pending a discard confirmation, or null when the modal is closed.
  const [discardPending, setDiscardPending] = useState<string[] | null>(null)

  const loadStatus = useCallback(
    () =>
      fetchGitStatus(projectId)
        .then((r) => {
          setStatus(r)
          // Drop selections for files that are no longer changed (e.g. after a commit).
          const live = new Set(r.files.map((f) => f.path))
          setSelected((cur) => new Set([...cur].filter((p) => live.has(p))))
        })
        .catch(() => setError(true)),
    [projectId],
  )
  const loadBranches = useCallback(() => fetchBranches(projectId).then(setBranches).catch(() => undefined), [projectId])
  const loadStashes = useCallback(
    () => fetchStashes(projectId).then((r) => setStashes(r.stashes)).catch(() => undefined),
    [projectId],
  )

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    setError(false)
    setExpanded(new Set())
    setSelected(new Set())
    setMessage('')
    setNotice(null)
    setOpError(null)
    void fetchGitStatus(projectId)
      .then((r) => !cancelled && setStatus(r))
      .catch(() => !cancelled && setError(true))
    void fetchBranches(projectId).then((r) => !cancelled && setBranches(r)).catch(() => undefined)
    void fetchStashes(projectId).then((r) => !cancelled && setStashes(r.stashes)).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [projectId])

  const files = status?.files ?? []
  const dirty = files.length > 0
  const allSelected = dirty && selected.size === files.length
  const canCommit = dirty && allSelected && message.trim().length > 0 && !busy

  function toggleSection(id: SectionId): void {
    setOpen((cur) => (cur === id ? null : id))
  }

  function toggleSelect(path: string): void {
    setOpError(null)
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function toggleAll(): void {
    setOpError(null)
    setSelected((cur) => (cur.size === files.length ? new Set() : new Set(files.map((f) => f.path))))
  }

  /** Run a git write op, then reload the views it can affect. Surfaces `ok:false` errors inline. */
  async function runOp(op: () => Promise<{ ok: boolean; error?: string }>, after: () => Promise<void>): Promise<boolean> {
    setBusy(true)
    setOpError(null)
    try {
      const r = await op()
      if (!r.ok) {
        setOpError(r.error ?? 'That git command failed.')
        return false
      }
      await after()
      return true
    } catch {
      setOpError('Could not reach the server.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function onCommit(): Promise<void> {
    const paths = [...selected]
    const ok = await runOp(
      () => commitFiles(projectId, message.trim(), paths),
      async () => {
        setMessage('')
        await Promise.all([loadStatus(), loadBranches()])
        onGitChange?.() // ahead/behind moved — refresh the header's branch subtitle
      },
    )
    if (ok) setNotice(`Committed ${paths.length} file${paths.length === 1 ? '' : 's'}.`)
  }

  async function onCheckout(branch: string, create: boolean): Promise<void> {
    await runOp(
      () => checkoutBranch(projectId, branch, create),
      async () => {
        setExpanded(new Set())
        await Promise.all([loadStatus(), loadBranches(), loadStashes()])
        onGitChange?.() // branch changed — refresh the header + drawer subtitle
      },
    )
  }

  async function onStashSave(): Promise<void> {
    await runOp(
      () => stashOp(projectId, { action: 'save' }),
      async () => Promise.all([loadStatus(), loadStashes()]).then(() => undefined),
    )
  }

  async function onDiscard(paths: string[]): Promise<void> {
    const ok = await runOp(
      () => discardFiles(projectId, paths),
      async () => {
        setSelected((cur) => new Set([...cur].filter((p) => !paths.includes(p))))
        await loadStatus()
      },
    )
    setDiscardPending(null)
    if (ok) setNotice(`Discarded changes in ${paths.length} file${paths.length === 1 ? '' : 's'}.`)
  }

  async function onStash(action: 'pop' | 'apply' | 'drop', index: number): Promise<void> {
    await runOp(
      () => stashOp(projectId, { action, index }),
      async () => Promise.all([loadStatus(), loadStashes()]).then(() => undefined),
    )
  }

  async function onRefresh(): Promise<void> {
    setRefreshing(true)
    setNotice(null)
    try {
      const r = await refreshBranch(projectId)
      setNotice(refreshNotice(r))
      if (r.upstream) setStatus((s) => (s ? { ...s, upstream: r.upstream } : s))
      if (r.ok) await Promise.all([loadStatus(), loadBranches()])
    } catch {
      setNotice('Couldn’t reach the remote.')
    } finally {
      setRefreshing(false)
    }
  }

  if (error) return <p className="p-4 text-center text-[13px] text-del">Could not load git status.</p>
  if (!status) return <p className="p-4 text-center text-[13px] text-muted">Loading…</p>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {opError && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-line bg-del/10 px-4 py-2 text-[12px] text-del">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>{opError}</span>
        </p>
      )}

      <Section
        icon={FileDiff}
        title="Changes"
        open={open === 'changes'}
        onToggle={() => toggleSection('changes')}
        summary={
          dirty ? (
            <span className="flex items-center gap-2 text-[11px] tabular-nums">
              <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-muted">{files.length}</span>
              <span>
                <span className="text-add">+{sumFiles(files, 'additions')}</span>{' '}
                <span className="text-del">-{sumFiles(files, 'deletions')}</span>
              </span>
            </span>
          ) : (
            <span className="text-[11px] text-muted">None</span>
          )
        }
      >
        {dirty ? (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel-2/40 px-3 py-2">
              <CheckBox
                state={allSelected ? 'on' : selected.size > 0 ? 'mixed' : 'off'}
                onClick={toggleAll}
                label="Select all files"
              />
              <button className="flex-1 text-left text-[12px] text-muted" onClick={toggleAll}>
                Select all · {selected.size}/{files.length}
              </button>
              <RowMenu
                label="Bulk actions"
                actions={[
                  { key: 'stash', label: 'Stash all changes', icon: Archive, onClick: () => void onStashSave() },
                  ...(selected.size > 0
                    ? [
                        {
                          key: 'discard-selected',
                          label: `Discard ${selected.size} selected`,
                          icon: Trash2,
                          destructive: true,
                          onClick: () => setDiscardPending([...selected]),
                        },
                      ]
                    : []),
                  {
                    key: 'discard-all',
                    label: 'Discard all changes',
                    icon: Trash2,
                    destructive: true,
                    onClick: () => setDiscardPending(files.map((f) => f.path)),
                  },
                ]}
              />
            </div>

            <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {files.map((f) => (
                <ChangedFileRow
                  key={f.path}
                  projectId={projectId}
                  file={f}
                  base={status.base}
                  open={expanded.has(f.path)}
                  selected={selected.has(f.path)}
                  onSelect={() => toggleSelect(f.path)}
                  onOpenFile={() => onOpenFile(f.path)}
                  onDiscard={() => setDiscardPending([f.path])}
                  onToggle={() =>
                    setExpanded((cur) => {
                      const next = new Set(cur)
                      if (next.has(f.path)) next.delete(f.path)
                      else next.add(f.path)
                      return next
                    })
                  }
                />
              ))}
            </ul>

            <div className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
              <textarea
                className="min-h-16 w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
                placeholder="Commit message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-accent bg-accent font-semibold text-[#06101f] disabled:cursor-not-allowed disabled:border-line disabled:bg-panel-2 disabled:text-muted"
                disabled={!canCommit}
                onClick={() => void onCommit()}
              >
                {busy ? <Loader className="size-4 animate-spin" /> : null}
                {allSelected ? `Commit ${files.length} file${files.length === 1 ? '' : 's'}` : 'Review every file to commit'}
              </button>
              <p className="text-center text-[11px] text-muted">Commits locally — push isn’t wired yet.</p>
            </div>
          </>
        ) : (
          <p className="flex flex-1 items-center justify-center px-4 py-4 text-center text-[13px] text-muted">
            {notice ?? 'No changes.'}
          </p>
        )}
      </Section>

      <Section
        icon={GitBranch}
        title="Branches"
        open={open === 'branches'}
        onToggle={() => toggleSection('branches')}
        summaryClassName="max-w-[50%]"
        summary={<span className="truncate font-mono text-[12px] text-fg">{branches?.current ?? '…'}</span>}
      >
        <BranchList branches={branches} busy={busy} onCheckout={(b, create) => void onCheckout(b, create)} />
        {status.upstream && (
          <BranchSync
            upstream={status.upstream}
            dirty={dirty}
            refreshing={refreshing}
            notice={notice}
            onRefresh={() => void onRefresh()}
          />
        )}
      </Section>

      <Section
        icon={Archive}
        title="Stash"
        open={open === 'stash'}
        onToggle={() => toggleSection('stash')}
        summary={
          stashes.length > 0 ? (
            <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">{stashes.length}</span>
          ) : null
        }
      >
        <StashBody stashes={stashes} onAction={(a, i) => void onStash(a, i)} />
      </Section>

      <DiscardConfirm
        paths={discardPending}
        busy={busy}
        onCancel={() => setDiscardPending(null)}
        onConfirm={() => discardPending && void onDiscard(discardPending)}
      />
    </div>
  )
}

/** A warning modal before an irreversible discard of working-tree changes. */
function DiscardConfirm({
  paths,
  busy,
  onCancel,
  onConfirm,
}: {
  paths: string[] | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const count = paths?.length ?? 0
  return (
    <Dialog open={paths !== null} onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent showClose={!busy}>
        <DialogHeader>
          <DialogTitle>Discard changes?</DialogTitle>
          <DialogDescription>
            This permanently drops uncommitted changes in {count} file{count === 1 ? '' : 's'}, restoring{' '}
            {count === 1 ? 'it' : 'them'} to the last commit. This can’t be undone.
          </DialogDescription>
        </DialogHeader>

        {paths && (
          <ul className="max-h-40 overflow-y-auto rounded-lg border border-line bg-panel-2 px-3 py-2">
            {paths.map((p) => (
              <li key={p} className="truncate font-mono text-[12px] text-fg">
                {p}
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <button
              className="min-h-11 flex-1 rounded-xl border border-line bg-panel-2 text-[14px] font-medium text-fg disabled:opacity-50"
              disabled={busy}
            >
              Cancel
            </button>
          </DialogClose>
          <button
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-del bg-del/90 text-[14px] font-semibold text-white disabled:opacity-50"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? <Loader className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Discard {count} file{count === 1 ? '' : 's'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One collapsible section: an icon + title + right-aligned summary head, and a body shown when open. */
function Section({
  icon: Icon,
  title,
  summary,
  summaryClassName,
  open,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  summary?: React.ReactNode
  /** Extra classes on the summary wrapper — e.g. a width cap so a long branch name truncates. */
  summaryClassName?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // Open: grow to fill and let the body scroll internally (min-h-0 flex-1).
    // Closed: just the head, at its natural height.
    <div className={`flex flex-col border-b border-line ${open ? 'min-h-0 flex-1' : 'shrink-0'}`}>
      <button className="flex w-full shrink-0 items-center gap-2 px-3 py-2.5 text-left hover:bg-panel-2" onClick={onToggle}>
        <ChevronRight className={`size-3.5 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon className="size-4 shrink-0 text-muted" />
        <span className="shrink-0 text-[13px] font-semibold text-fg">{title}</span>
        {summary != null && (
          <span className={`ml-auto flex min-w-0 items-center justify-end ${summaryClassName ?? ''}`}>{summary}</span>
        )}
      </button>
      {open && <div className="flex min-h-0 flex-1 flex-col">{children}</div>}
    </div>
  )
}

/** A tri-state checkbox: off, on (Check), or mixed/indeterminate (Minus). */
function CheckBox({ state, onClick, label }: { state: 'on' | 'off' | 'mixed'; onClick: () => void; label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
      aria-label={label}
      onClick={onClick}
      className={`flex size-5 shrink-0 items-center justify-center rounded border ${
        state === 'off' ? 'border-line text-transparent' : 'border-accent bg-accent/20 text-accent'
      }`}
    >
      {state === 'mixed' ? <Minus className="size-3.5" /> : <Check className="size-3.5" />}
    </button>
  )
}

/** The branch list: each branch a distinct row (current one highlighted), then a separated "New branch" action. */
function BranchList({
  branches,
  busy,
  onCheckout,
}: {
  branches: GitBranchesResponse | null
  busy: boolean
  onCheckout: (branch: string, create: boolean) => void
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  function create(): void {
    const n = name.trim()
    if (!n) return
    onCheckout(n, true)
    setName('')
    setCreating(false)
  }

  if (!branches) return <p className="px-4 py-3 text-[12px] text-muted">Loading branches…</p>

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      <ul className="flex flex-col gap-1">
        {branches.branches.map((b) => {
          const current = b === branches.current
          return (
            <li key={b}>
              <button
                disabled={current || busy}
                onClick={() => onCheckout(b, false)}
                className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[13px] ${
                  current
                    ? 'border-accent/60 bg-accent/10 text-fg'
                    : 'border-transparent text-muted hover:border-line hover:bg-panel-2 hover:text-fg'
                }`}
              >
                {current ? (
                  <Check className="size-3.5 shrink-0 text-accent" />
                ) : (
                  <GitBranch className="size-3.5 shrink-0 opacity-60" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono">{b}</span>
                {current && (
                  <span className="shrink-0 rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                    current
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <div className="mt-1 border-t border-line pt-2">
        {creating ? (
          <div className="flex items-center gap-1.5">
            <input
              className="min-h-9 w-0 flex-1 rounded-lg border border-line bg-panel-2 px-2.5 font-mono text-[13px] text-fg outline-none focus:border-accent"
              placeholder="new-branch-name"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              autoFocus
            />
            <button
              className="rounded-lg border border-accent bg-accent px-3 py-1.5 text-[13px] font-semibold text-[#06101f] disabled:opacity-50"
              disabled={!name.trim() || busy}
              onClick={create}
            >
              Create
            </button>
            <button className="px-1.5 py-1.5 text-[13px] text-muted hover:text-fg" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-2 text-left text-[13px] text-muted hover:text-fg"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-3.5 shrink-0" /> New branch…
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Stash body: manage the stack (pop/apply/drop per entry). Creating a stash lives
 * in the Changes section's bulk-actions kebab ("Stash all changes"), since that's
 * where the working-tree changes it captures are shown.
 */
function StashBody({
  stashes,
  onAction,
}: {
  stashes: GitStashEntry[]
  onAction: (action: 'pop' | 'apply' | 'drop', index: number) => void
}): React.JSX.Element {
  if (stashes.length === 0) {
    return (
      <p className="flex flex-1 items-center justify-center px-3 py-3 text-center text-[12px] text-muted">
        No stashes. Stash changes from the Changes menu.
      </p>
    )
  }
  return (
    <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
      {stashes.map((s) => (
        <li key={s.ref} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-panel-2">
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{s.message}</span>
          <RowMenu
            label={`Actions for ${s.ref}`}
            actions={[
              { key: 'pop', label: 'Pop (apply + drop)', icon: Archive, onClick: () => onAction('pop', s.index) },
              { key: 'apply', label: 'Apply (keep)', icon: Check, onClick: () => onAction('apply', s.index) },
              { key: 'drop', label: 'Drop', icon: Minus, destructive: true, onClick: () => onAction('drop', s.index) },
            ]}
          />
        </li>
      ))}
    </ul>
  )
}

/** Turns a refresh result into a one-line status message for the sync row. */
function refreshNotice(r: GitRefreshResponse): string {
  if (r.ok) return 'Branch is up to date with the remote.'
  switch (r.reason) {
    case 'dirty':
      return 'You have uncommitted changes — commit or stash them before refreshing.'
    case 'diverged':
      return 'Your branch and the remote have both moved — this needs a manual merge or rebase (full source control is coming later).'
    case 'no-upstream':
      return 'This branch doesn’t track a remote.'
    default:
      return r.error ?? 'Couldn’t reach the remote.'
  }
}

/**
 * The branch-sync row (inside the Branches section): how the local branch sits
 * against its remote, and a Refresh (fetch + fast-forward) button. Refresh is
 * blocked while the tree is dirty — fast-forwarding over uncommitted work is
 * exactly the "breaking" case to avoid, so it asks you to commit or stash first.
 */
function BranchSync({
  upstream,
  dirty,
  refreshing,
  notice,
  onRefresh,
}: {
  upstream: GitUpstream
  dirty: boolean
  refreshing: boolean
  notice: string | null
  onRefresh: () => void
}): React.JSX.Element {
  const behind = upstream.behind
  const summary =
    behind > 0
      ? `${behind} commit${behind === 1 ? '' : 's'} behind ${upstream.name}`
      : upstream.ahead > 0
        ? `Up to date with ${upstream.name} · ${upstream.ahead} ahead`
        : `Up to date with ${upstream.name}`

  return (
    <div className="shrink-0 border-t border-line px-3 py-2.5">
      <div className="flex items-center gap-2">
        <RotateCw className={`size-3.5 shrink-0 text-muted ${refreshing ? 'animate-spin' : ''}`} />
        <span className={`min-w-0 flex-1 truncate text-[12px] ${behind > 0 ? 'text-warn' : 'text-muted'}`}>{summary}</span>
        <button
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-panel-2 disabled:opacity-50"
          disabled={dirty || refreshing}
          onClick={onRefresh}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {dirty && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>Commit or stash your changes before refreshing the branch.</span>
        </p>
      )}
      {notice && !dirty && <p className="mt-2 text-[11px] text-muted">{notice}</p>}
    </div>
  )
}

const STATUS_LABEL: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }
const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-add',
  modified: 'text-accent',
  deleted: 'text-del',
  renamed: 'text-muted',
}

const sumFiles = (files: ChangedFile[], key: 'additions' | 'deletions'): number => files.reduce((n, f) => n + f[key], 0)

function ChangedFileRow({
  projectId,
  file,
  base,
  open,
  selected,
  onToggle,
  onSelect,
  onOpenFile,
  onDiscard,
}: {
  projectId: string
  file: ChangedFile
  base: string | undefined
  open: boolean
  selected: boolean
  onToggle: () => void
  onSelect: () => void
  onOpenFile: () => void
  onDiscard: () => void
}): React.JSX.Element {
  const [diff, setDiff] = useState<{ before: string; after: string } | null>(null)

  useEffect(() => {
    if (!open || diff || !base) return
    void fetchFileDiff(projectId, base, file.path)
      .then((r) => setDiff(r))
      .catch(() => setDiff({ before: '', after: '' }))
  }, [open, diff, base, projectId, file.path])

  // A deleted file has nothing to open in the viewer, so skip its "View file" action.
  const actions = [
    ...(file.status === 'deleted' ? [] : [{ key: 'view', label: 'View file', icon: FileCode, onClick: onOpenFile }]),
    { key: 'discard', label: 'Discard changes', icon: Trash2, destructive: true, onClick: onDiscard },
  ]

  return (
    <li className="border-b border-line last:border-b-0">
      <div className="group flex items-center gap-2 px-3 py-2.5 hover:bg-panel-2">
        <CheckBox state={selected ? 'on' : 'off'} onClick={onSelect} label={`Select ${file.path}`} />
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle}>
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted" />
          )}
          <span className={`w-4 shrink-0 text-center text-[11px] font-semibold ${STATUS_COLOR[file.status]}`}>
            {STATUS_LABEL[file.status]}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{file.path}</span>
          <span className="shrink-0 text-[11px] tabular-nums">
            <span className="text-add">+{file.additions}</span> <span className="text-del">-{file.deletions}</span>
          </span>
        </button>
        <RowMenu label={`Actions for ${file.path}`} actions={actions} />
      </div>
      {open &&
        (diff ? (
          <DiffView subject={{ filePath: file.path, before: diff.before, after: diff.after }} />
        ) : (
          <p className="px-4 pb-3 text-[12px] text-muted">Loading diff…</p>
        ))}
    </li>
  )
}
