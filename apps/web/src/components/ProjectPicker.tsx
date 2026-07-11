import type { GithubRepo, NameCheckResponse, Visibility } from '@mce/protocol'
import type { Project } from '@mce/protocol'
import { Check, Globe, Loader, Lock, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, checkProjectName, createProject, fetchGithubRepos } from '../api.ts'
import { useDebounced } from '../useDebounced.ts'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from './ui/drawer.tsx'

interface Props {
  projects: Project[]
  activeId: string | null
  /** Names that failed to clone/init, keyed by name → error. From the event stream. */
  failed: Record<string, string>
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * A full-screen overlay, not a router — Phase 2's IA is still "one screen plus a
 * picker". Tap a project to switch; the two actions dock to the bottom and each
 * opens its own drawer (Clone / Create).
 */
export function ProjectPicker({ projects, activeId, failed, onSelect, onClose }: Props): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-bg/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-line px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top,0px))]">
        <span className="font-semibold">Projects</span>
        <button className="h-8 rounded-lg border border-line bg-panel-2 px-3 text-[13px] text-muted" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <ul className="flex flex-col gap-2">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                className={`w-full rounded-xl border p-3 text-left ${
                  p.id === activeId ? 'border-accent bg-panel' : 'border-line bg-panel-2'
                }`}
                onClick={() => onSelect(p.id)}
              >
                <span className="block truncate font-medium">{p.name}</span>
                <span className="mt-0.5 block truncate text-[12px] text-muted">
                  {p.repoUrl ?? 'local'} {p.branch ? `· ${p.branch}` : ''}
                </span>
                {failed[p.name] && <div className="mt-1 text-[12px] text-del">{failed[p.name]}</div>}
              </button>
            </li>
          ))}
          {projects.length === 0 && (
            <li className="py-6 text-center text-muted">No projects yet. Add one below.</li>
          )}
        </ul>
      </div>

      {/* Docked actions: each opens a drawer for its flow. */}
      <div className="flex shrink-0 gap-2 border-t border-line bg-panel/80 px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] backdrop-blur">
        <Drawer>
          <DrawerTrigger asChild>
            <button className="min-h-11 flex-1 rounded-xl border border-line bg-panel-2 text-[14px] font-medium text-fg">
              Clone repo
            </button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Clone a repo</DrawerTitle>
              <DrawerDescription>Search your GitHub repos, or paste a git URL.</DrawerDescription>
            </DrawerHeader>
            <div className="flex min-h-0 flex-1 flex-col px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
              <CloneForm projects={projects} failed={failed} />
            </div>
          </DrawerContent>
        </Drawer>

        <Drawer>
          <DrawerTrigger asChild>
            <button className="min-h-11 flex-1 rounded-xl border border-accent bg-accent text-[14px] font-semibold text-[#06101f]">
              Create repo
            </button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Create a repo</DrawerTitle>
              <DrawerDescription>Make a new GitHub repo and clone it.</DrawerDescription>
            </DrawerHeader>
            <div className="min-h-0 overflow-y-auto px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
              <CreateForm failed={failed} />
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    </div>
  )
}

/** owner/repo, lowercased, no `.git` — for matching a project's remote to a repo. */
function repoKey(url: string): string {
  return url
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .slice(-2)
    .join('/')
    .toLowerCase()
}

const INPUT =
  'min-h-11 w-full rounded-xl border border-line bg-panel-2 px-3 text-[16px] text-fg outline-none focus:border-accent'

const isGitUrl = (s: string): boolean => /^(https?:\/\/|git@|ssh:\/\/)/.test(s)

/** How many rows to reveal at a time as you scroll the results. */
const PAGE = 12

/**
 * Type to search your repos (owned first), or paste any git URL. Results stream
 * into a scrollable list that reveals more as you reach the bottom — the whole
 * matched set is fetched once (debounced), so scrolling never flickers. A clone
 * returns 202; the project appears in the list above when `project_created` lands.
 */
function CloneForm({ projects, failed }: { projects: Project[]; failed: Record<string, string> }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState<GithubRepo[]>([])
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(PAGE)
  const [pending, setPending] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const debounced = useDebounced(query, 300)
  const scroller = useRef<HTMLDivElement>(null)

  // Repos already cloned as projects, by owner/repo and by id — so search only
  // ever offers things you don't have yet.
  const added = useMemo(() => {
    const s = new Set<string>()
    for (const p of projects) {
      s.add(p.id.toLowerCase())
      if (p.repoUrl) s.add(repoKey(p.repoUrl))
    }
    return s
  }, [projects])
  const isAdded = (r: GithubRepo): boolean =>
    added.has(r.nameWithOwner.toLowerCase()) || added.has((r.nameWithOwner.split('/')[1] ?? '').toLowerCase())

  const isUrl = isGitUrl(query.trim())

  // One fetch per debounced query (empty query browses everything). A pasted URL
  // shows no suggestions — you clone it directly.
  useEffect(() => {
    let cancelled = false
    const q = debounced.trim()
    if (isGitUrl(q)) {
      setRepos([])
      return
    }
    setLoading(true)
    void fetchGithubRepos(q)
      .then((r) => {
        if (cancelled) return
        setRepos(r)
        setVisible(PAGE)
        scroller.current?.scrollTo({ top: 0 })
      })
      .catch(() => !cancelled && setRepos([]))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [debounced])

  const pendingError = pending ? failed[pending] : undefined
  const suggestions = repos.filter((r) => !isAdded(r))
  const shown = suggestions.slice(0, visible)

  function onScroll(e: React.UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120 && visible < suggestions.length) {
      setVisible((v) => v + PAGE)
    }
  }

  async function clone(repoUrl: string): Promise<void> {
    setError(undefined)
    try {
      const { projectId } = await createProject({ repoUrl })
      setPending(projectId)
      setQuery('')
      setRepos([])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input
          className="min-h-11 w-full rounded-xl border border-line bg-panel-2 pl-9 pr-10 text-[16px] text-fg outline-none focus:border-accent"
          value={query}
          placeholder="Search your repos, or paste a git URL"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && isUrl && void clone(query.trim())}
        />
        {loading ? (
          <Loader className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted" />
        ) : query ? (
          <button
            className="absolute right-2.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-line"
            title="Clear"
            aria-label="Clear"
            onClick={() => setQuery('')}
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {isUrl && (
        <button
          className="mt-3 min-h-11 shrink-0 rounded-xl border border-accent bg-accent px-4 font-semibold text-[#06101f]"
          onClick={() => void clone(query.trim())}
        >
          Clone this URL
        </button>
      )}

      <div ref={scroller} onScroll={onScroll} className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1">
        {shown.length > 0 && (
          <ul className="flex flex-col gap-1">
            {shown.map((r) => (
              <li key={r.nameWithOwner}>
                <button
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-panel-2"
                  onClick={() => void clone(r.cloneUrl)}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted">
                    {r.private ? <Lock className="size-4" /> : <Globe className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[14px] text-fg">{r.nameWithOwner}</span>
                      {r.isOwn && (
                        <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-muted">yours</span>
                      )}
                    </span>
                    {r.description && <span className="block truncate text-[12px] text-muted">{r.description}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {loading && suggestions.length === 0 && <SkeletonRows />}
        {!loading && !isUrl && suggestions.length === 0 && (
          <p className="px-2 py-8 text-center text-[13px] text-muted">
            {repos.length === 0 ? 'No repos found — is GitHub configured?' : 'Nothing left to add here.'}
          </p>
        )}
      </div>

      {pending && !pendingError && <p className="mt-2 shrink-0 text-[13px] text-accent">Cloning {pending}…</p>}
      {pendingError && <p className="mt-2 shrink-0 text-[13px] text-del">{pending}: {pendingError}</p>}
      {error && <p className="mt-2 shrink-0 text-[13px] text-del">{error}</p>}
    </div>
  )
}

/** Placeholder rows while the first fetch is in flight — no layout jump. */
function SkeletonRows(): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="flex items-center gap-3 px-2 py-2">
          <span className="size-9 shrink-0 animate-pulse rounded-lg bg-panel-2" />
          <span className="flex-1">
            <span className="block h-3.5 w-1/2 animate-pulse rounded bg-panel-2" />
            <span className="mt-1.5 block h-3 w-3/4 animate-pulse rounded bg-panel-2" />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Name a new repo; we check availability (locally + on GitHub) as you type and
 * let you pick visibility. Create makes the GitHub repo and clones it.
 */
function CreateForm({ failed }: { failed: Record<string, string> }): React.JSX.Element {
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [check, setCheck] = useState<NameCheckResponse | null>(null)
  const [checking, setChecking] = useState(false)
  const [pending, setPending] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const debounced = useDebounced(name, 400)

  useEffect(() => {
    let cancelled = false
    const n = debounced.trim()
    setCheck(null)
    if (!n) return
    setChecking(true)
    void checkProjectName(n)
      .then((res) => !cancelled && setCheck(res))
      .catch(() => !cancelled && setCheck(null))
      .finally(() => !cancelled && setChecking(false))
    return () => {
      cancelled = true
    }
  }, [debounced])

  const pendingError = pending ? failed[pending] : undefined
  const taken = !checking && check !== null && !check.available
  // With GitHub off, check is null — allow create (it becomes a local init server-side).
  const canCreate = Boolean(name.trim()) && (check === null || check.available) && !pending

  async function create(): Promise<void> {
    setError(undefined)
    try {
      const { projectId } = await createProject({ name: name.trim(), visibility })
      setPending(projectId)
      setName('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-[12px] font-medium text-muted">Repository name</label>
        <div
          className={`flex items-center rounded-xl border bg-panel-2 ${
            taken ? 'border-del' : 'border-line focus-within:border-accent'
          }`}
        >
          {check?.owner && <span className="whitespace-nowrap pl-3 text-[15px] text-muted">{check.owner}/</span>}
          <input
            className="min-h-11 w-full bg-transparent px-3 text-[16px] text-fg outline-none"
            value={name}
            placeholder="new-repo-name"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
          {checking && <Loader className="mr-3 size-4 shrink-0 animate-spin text-muted" />}
          {!checking && check?.available && <Check className="mr-3 size-4 shrink-0 text-add" />}
          {taken && <X className="mr-3 size-4 shrink-0 text-del" />}
        </div>
        <div className="mt-1.5 min-h-[16px] text-[12px]">
          {check?.available && <span className="text-add">Available</span>}
          {taken && (
            <span className="text-del">
              {check.reason === 'exists-remote'
                ? 'Already exists on GitHub'
                : check.reason === 'exists-local'
                  ? 'A project with that name already exists here'
                  : 'Not a valid name'}
            </span>
          )}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[12px] font-medium text-muted">Visibility</label>
        <div className="grid grid-cols-2 gap-2">
          {([
            ['private', Lock, 'Only you'],
            ['public', Globe, 'Anyone'],
          ] as const).map(([v, Icon, sub]) => (
            <button
              key={v}
              className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left ${
                visibility === v ? 'border-accent bg-accent/10' : 'border-line bg-panel-2'
              }`}
              onClick={() => setVisibility(v)}
            >
              <Icon className={`size-4 shrink-0 ${visibility === v ? 'text-accent' : 'text-muted'}`} />
              <span className="min-w-0">
                <span className="block text-[14px] capitalize text-fg">{v}</span>
                <span className="block text-[11px] text-muted">{sub}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <button
        className="min-h-12 shrink-0 rounded-xl border border-accent bg-accent text-[15px] font-semibold text-[#06101f] disabled:opacity-50"
        disabled={!canCreate}
        onClick={() => void create()}
      >
        {pending ? 'Creating…' : 'Create repository'}
      </button>

      {pendingError && <p className="text-[13px] text-del">{pending}: {pendingError}</p>}
      {error && <p className="text-[13px] text-del">{error}</p>}
    </div>
  )
}
