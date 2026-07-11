import type { GithubRepo, NameCheckResponse, Visibility } from '@mce/protocol'
import type { Project } from '@mce/protocol'
import { useEffect, useMemo, useState } from 'react'
import { ApiError, checkProjectName, createProject, fetchGithubRepos } from '../api.ts'
import { useDebounced } from '../useDebounced.ts'

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
 * picker". Tap a project to switch; add one via the Clone or Create tab below.
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
                <div className="flex items-center justify-between">
                  <span className="truncate font-medium">{p.name}</span>
                  <span className="text-[11px] text-muted">threads ›</span>
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted">
                  {p.repoUrl ?? 'local'} {p.branch ? `· ${p.branch}` : ''}
                </div>
                {failed[p.name] && <div className="mt-1 text-[12px] text-del">{failed[p.name]}</div>}
              </button>
            </li>
          ))}
          {projects.length === 0 && (
            <li className="py-6 text-center text-muted">No projects yet. Add one below.</li>
          )}
        </ul>

        <AddProject projects={projects} failed={failed} />
      </div>
    </div>
  )
}

type Mode = 'clone' | 'create'

const TAB = 'flex-1 rounded-lg border py-2 text-[13px] font-medium'

function AddProject({ projects, failed }: { projects: Project[]; failed: Record<string, string> }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('clone')

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="mb-3 flex gap-2">
        <button
          className={`${TAB} ${mode === 'clone' ? 'border-accent bg-panel text-fg' : 'border-line bg-panel-2 text-muted'}`}
          onClick={() => setMode('clone')}
        >
          Clone repo
        </button>
        <button
          className={`${TAB} ${mode === 'create' ? 'border-accent bg-panel text-fg' : 'border-line bg-panel-2 text-muted'}`}
          onClick={() => setMode('create')}
        >
          Create repo
        </button>
      </div>

      {mode === 'clone' ? <CloneForm projects={projects} failed={failed} /> : <CreateForm failed={failed} />}
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

/**
 * Type to search your repos (owned first), tap the chevron to browse the ones you
 * haven't added yet, or paste any git URL. A clone returns 202; the project
 * appears in the list above when its `project_created` lands.
 */
function CloneForm({ projects, failed }: { projects: Project[]; failed: Record<string, string> }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState<GithubRepo[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const debounced = useDebounced(query, 300)

  // Repos already cloned as projects, by owner/repo and by id — so browse and
  // search only ever offer things you don't have yet.
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

  // One effect drives suggestions: a typed query searches; an open chevron with
  // no query browses everything; a pasted URL shows nothing.
  useEffect(() => {
    let cancelled = false
    const q = debounced.trim()
    if (isGitUrl(q)) {
      setRepos([])
      return
    }
    if (!q && !browsing) {
      setRepos([])
      return
    }
    setLoading(true)
    void fetchGithubRepos(q)
      .then((r) => !cancelled && setRepos(r))
      .catch(() => !cancelled && setRepos([]))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [debounced, browsing])

  const pendingError = pending ? failed[pending] : undefined
  const suggestions = repos.filter((r) => !isAdded(r))
  const isUrl = isGitUrl(query.trim())

  async function clone(repoUrl: string): Promise<void> {
    setError(undefined)
    try {
      const { projectId } = await createProject({ repoUrl })
      setPending(projectId)
      setQuery('')
      setRepos([])
      setBrowsing(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          className={INPUT}
          value={query}
          placeholder="search your repos, or paste a git URL"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && isUrl && void clone(query.trim())}
        />
        {isUrl ? (
          <button
            className="min-h-11 shrink-0 rounded-xl border border-accent bg-accent px-4 font-semibold text-[#06101f]"
            onClick={() => void clone(query.trim())}
          >
            Clone
          </button>
        ) : (
          // Browse the repos you haven't added yet.
          <button
            className="min-h-11 w-11 shrink-0 rounded-xl border border-line bg-panel-2 text-muted"
            title="Browse your repos"
            aria-label="Browse your repos"
            onClick={() => setBrowsing((b) => !b)}
          >
            <span className={`inline-block transition-transform ${browsing ? 'rotate-180' : ''}`}>▾</span>
          </button>
        )}
      </div>

      {suggestions.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {suggestions.map((r) => (
            <li key={r.nameWithOwner}>
              <button
                className="flex w-full items-center justify-between rounded-lg border border-line bg-panel-2 px-3 py-2 text-left"
                onClick={() => void clone(r.cloneUrl)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px]">{r.nameWithOwner}</span>
                  {r.description && <span className="block truncate text-[12px] text-muted">{r.description}</span>}
                </span>
                <span className="ml-2 shrink-0 text-[11px] text-muted">
                  {r.isOwn ? 'yours' : ''} {r.private ? '· private' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {loading && suggestions.length === 0 && <p className="mt-2 text-[13px] text-muted">loading…</p>}
      {browsing && !loading && suggestions.length === 0 && (
        <p className="mt-2 text-[13px] text-muted">
          {repos.length === 0 ? 'No repos found (is GitHub configured?).' : 'You&rsquo;ve already added your recent repos — search for more.'}
        </p>
      )}

      {pending && !pendingError && <p className="mt-2 text-[13px] text-accent">Cloning {pending}…</p>}
      {pendingError && <p className="mt-2 text-[13px] text-del">{pending}: {pendingError}</p>}
      {error && <p className="mt-2 text-[13px] text-del">{error}</p>}
    </div>
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
  // With GitHub off, check is null — allow create (it becomes a local init server-side).
  const canCreate = Boolean(name.trim()) && (check === null || check.available)

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
    <div>
      <input
        className={INPUT}
        value={name}
        placeholder="new-repo-name"
        onChange={(e) => setName(e.target.value)}
      />

      <div className="mt-1 min-h-[18px] text-[12px]">
        {checking && <span className="text-muted">checking…</span>}
        {!checking && check?.available && <span className="text-add">available — {check.owner}/{check.name}</span>}
        {!checking && check && !check.available && (
          <span className="text-del">
            {check.reason === 'exists-remote'
              ? `${check.owner}/${check.name} already exists on GitHub`
              : check.reason === 'exists-local'
                ? 'a project with that name already exists here'
                : 'not a valid name'}
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-line">
          {(['private', 'public'] as const).map((v) => (
            <button
              key={v}
              className={`px-3 py-2 text-[13px] ${visibility === v ? 'bg-accent text-[#06101f]' : 'bg-panel-2 text-muted'}`}
              onClick={() => setVisibility(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <button
          className="min-h-11 flex-1 rounded-xl border border-accent bg-accent font-semibold text-[#06101f] disabled:opacity-50"
          disabled={!canCreate}
          onClick={() => void create()}
        >
          Create
        </button>
      </div>

      {pending && !pendingError && <p className="mt-2 text-[13px] text-accent">Creating {pending}…</p>}
      {pendingError && <p className="mt-2 text-[13px] text-del">{pending}: {pendingError}</p>}
      {error && <p className="mt-2 text-[13px] text-del">{error}</p>}
    </div>
  )
}
