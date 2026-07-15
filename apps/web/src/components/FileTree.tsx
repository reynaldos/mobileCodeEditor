import type { FsEntry, FsSearchMatch } from '@mce/protocol'
import {
  Check,
  ChevronRight,
  ClipboardCopy,
  Eye,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  ListChecks,
  Loader,
  Search,
  X,
} from 'lucide-react'
import { createContext, useContext, useEffect, useState } from 'react'
import { fetchFileTree, searchProjectFiles } from '../api.ts'
import { useDebounced } from '../useDebounced.ts'
import { RowMenu, type RowMenuAction } from './RowMenu.tsx'

/**
 * Multi-select state, shared down the tree via context so the deeply-recursive
 * `TreeNode` (and the flat search list) can read it without threading props
 * through every level. `active` is "select mode is on"; the only bulk action is
 * copying the selected paths (the ask for this feature).
 */
interface Selection {
  active: boolean
  has: (path: string) => boolean
  toggle: (path: string) => void
}
const SelectionCtx = createContext<Selection>({ active: false, has: () => false, toggle: () => undefined })

/** The leading checkbox on a selectable file row (shown only in select mode). */
function RowCheck({ checked }: { checked: boolean }): React.JSX.Element {
  return (
    <span
      className={`flex size-4 shrink-0 items-center justify-center rounded border ${
        checked ? 'border-accent bg-accent/20 text-accent' : 'border-line text-transparent'
      }`}
    >
      <Check className="size-3" />
    </span>
  )
}

interface Props {
  projectId: string
  onOpenFile: (path: string) => void
  /** Open the compiled markdown preview for a `.md`/`.mdx` file (the per-row kebab action). */
  onPreview: (path: string) => void
}

/**
 * Copies the path as an `@`-reference (e.g. `@src/app/layout.tsx`) — the "Copy
 * path" action every file row's kebab carries. Copying the `@` form means a
 * paste straight into the prompt box is recognized as a file reference (see
 * `HighlightedInput`) with no need to type the `@` first.
 */
function copyPath(path: string): void {
  void navigator.clipboard?.writeText(`@${path}`).catch(() => {})
}

/** The per-file kebab actions: every file can copy its path; markdown files also get a rendered preview. */
function fileMenuActions(path: string, onPreview: (path: string) => void): RowMenuAction[] {
  const actions: RowMenuAction[] = []
  if (isMarkdown(path)) actions.push({ key: 'preview', label: 'Open preview', icon: Eye, onClick: () => onPreview(path) })
  actions.push({ key: 'copy', label: 'Copy path', icon: ClipboardCopy, onClick: () => copyPath(path) })
  return actions
}

/**
 * VS Code-style file/folder accordion (PHASE-3.md design call 5): one level
 * fetched per expand, never a full recursive walk. A search box above swaps
 * the tree for a flat ripgrep-backed match list while a query is active —
 * same "browse when empty, search when typing" shape `ProjectPicker`'s repo
 * search already uses.
 */
export function FileTree({ projectId, onOpenFile, onPreview }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 300)
  const [results, setResults] = useState<FsSearchMatch[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [copied, setCopied] = useState(false)

  const selection: Selection = {
    active: selectMode,
    has: (p) => selected.has(p),
    toggle: (p) =>
      setSelected((cur) => {
        const next = new Set(cur)
        if (next.has(p)) next.delete(p)
        else next.add(p)
        return next
      }),
  }

  function exitSelect(): void {
    setSelectMode(false)
    setSelected(new Set())
    setCopied(false)
  }

  function copySelected(): void {
    if (selected.size === 0) return
    // `@`-prefixed, one per line — same reference form as the single-row "Copy
    // path", so pasting the block into the prompt reads as file references.
    const text = [...selected].sort().map((p) => `@${p}`).join('\n')
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  useEffect(() => {
    const q = debounced.trim()
    if (!q) {
      setResults([])
      setTruncated(false)
      return
    }
    let cancelled = false
    setSearching(true)
    void searchProjectFiles(projectId, q)
      .then((r) => {
        if (cancelled) return
        setResults(r.matches)
        setTruncated(r.truncated)
      })
      .catch(() => !cancelled && setResults([]))
      .finally(() => !cancelled && setSearching(false))
    return () => {
      cancelled = true
    }
  }, [projectId, debounced])

  return (
    <SelectionCtx.Provider value={selection}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative shrink-0 px-3 pt-3">
          <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            className="min-h-10 w-full rounded-lg border border-line bg-panel-2 pl-9 pr-9 text-[15px] text-fg outline-none focus:border-accent"
            value={query}
            placeholder="Search file contents"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching ? (
            <Loader className="absolute right-5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted" />
          ) : query ? (
            <button
              className="absolute right-4 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-line"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-1.5">
          {selectMode ? (
            <>
              <span className="text-[12px] text-muted">{selected.size} selected</span>
              <div className="flex items-center gap-1.5">
                <button
                  className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-panel-2 disabled:opacity-50"
                  disabled={selected.size === 0}
                  onClick={copySelected}
                >
                  {copied ? <Check className="size-3.5 text-add" /> : <ClipboardCopy className="size-3.5" />}
                  {copied ? 'Copied' : 'Copy paths'}
                </button>
                <button className="rounded-lg px-2 py-1 text-[12px] text-muted hover:text-fg" onClick={exitSelect}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <button
              className="ml-auto flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-panel-2"
              onClick={() => setSelectMode(true)}
            >
              <ListChecks className="size-3.5" /> Select
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          {query.trim() ? (
            <SearchResults
              results={results}
              truncated={truncated}
              searching={searching}
              onOpenFile={onOpenFile}
              onPreview={onPreview}
            />
          ) : (
            <RootTree projectId={projectId} onOpenFile={onOpenFile} onPreview={onPreview} />
          )}
        </div>
      </div>
    </SelectionCtx.Provider>
  )
}

function SearchResults({
  results,
  truncated,
  searching,
  onOpenFile,
  onPreview,
}: {
  results: FsSearchMatch[]
  truncated: boolean
  searching: boolean
  onOpenFile: (path: string) => void
  onPreview: (path: string) => void
}): React.JSX.Element {
  const selection = useContext(SelectionCtx)
  if (searching && results.length === 0) {
    return <p className="px-2.5 py-8 text-center text-[13px] text-muted">Searching…</p>
  }
  if (results.length === 0) {
    return <p className="px-2.5 py-8 text-center text-[13px] text-muted">No matches.</p>
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {results.map((m, i) => (
        <li key={`${m.path}:${m.line}:${i}`} className="group flex items-center rounded-lg hover:bg-panel-2">
          {selection.active && (
            <span className="pl-2.5">
              <RowCheck checked={selection.has(m.path)} />
            </span>
          )}
          <button
            className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2.5 py-2 text-left"
            onClick={() => (selection.active ? selection.toggle(m.path) : onOpenFile(m.path))}
          >
            <span className="flex w-full items-center gap-1.5 text-[12px] text-muted">
              <FileIcon name={m.path} className="size-3.5 shrink-0" />
              <span className="truncate">{m.path}</span>
              <span className="shrink-0">:{m.line}</span>
            </span>
            <span className="w-full truncate font-mono text-[12px] text-fg">{m.text}</span>
          </button>
          {!selection.active && (
            <span className="shrink-0 pr-1.5">
              <RowMenu label={`Actions for ${m.path}`} actions={fileMenuActions(m.path, onPreview)} />
            </span>
          )}
        </li>
      ))}
      {truncated && (
        <li className="px-2.5 py-2 text-center text-[11px] text-muted">More matches than shown — narrow your search.</li>
      )}
    </ul>
  )
}

function RootTree({
  projectId,
  onOpenFile,
  onPreview,
}: {
  projectId: string
  onOpenFile: (path: string) => void
  onPreview: (path: string) => void
}): React.JSX.Element {
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    setError(false)
    void fetchFileTree(projectId, '')
      .then((r) => !cancelled && setEntries(r.entries))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [projectId])

  if (error) return <p className="px-2.5 py-8 text-center text-[13px] text-del">Could not load files.</p>
  if (!entries) return <TreeSkeleton />
  if (entries.length === 0) return <p className="px-2.5 py-8 text-center text-[13px] text-muted">Empty project.</p>

  return (
    <ul className="flex flex-col gap-0.5">
      {entries.map((e) => (
        <TreeNode key={e.path} projectId={projectId} entry={e} depth={0} onOpenFile={onOpenFile} onPreview={onPreview} />
      ))}
    </ul>
  )
}

/**
 * One row, recursive for directories. Each directory owns its own
 * expanded/children/loading state and fetches its children only on first
 * expand — the lazy-accordion mechanics design call 5 asks for.
 */
function TreeNode({
  projectId,
  entry,
  depth,
  onOpenFile,
  onPreview,
}: {
  projectId: string
  entry: FsEntry
  depth: number
  onOpenFile: (path: string) => void
  onPreview: (path: string) => void
}): React.JSX.Element {
  const selection = useContext(SelectionCtx)
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FsEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const indent = 12 + depth * 16

  function toggle(): void {
    // In select mode, tapping a file toggles its selection instead of opening it.
    // Folders still expand (you navigate to reach the files you want).
    if (entry.type === 'file') {
      if (selection.active) selection.toggle(entry.path)
      else onOpenFile(entry.path)
      return
    }
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (children !== null) return // already fetched — expanding again is free
    setLoading(true)
    void fetchFileTree(projectId, entry.path)
      .then((r) => setChildren(r.entries))
      .catch(() => setChildren([]))
      .finally(() => setLoading(false))
  }

  return (
    <li>
      <div className="group flex items-center rounded-lg hover:bg-panel-2">
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left"
          style={{ paddingLeft: indent }}
          onClick={toggle}
        >
          {entry.type === 'dir' ? (
            <>
              <ChevronRight className={`size-3.5 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
              {open ? <FolderOpen className="size-4 shrink-0 text-accent" /> : <Folder className="size-4 shrink-0 text-accent" />}
            </>
          ) : (
            <>
              {selection.active ? (
                <RowCheck checked={selection.has(entry.path)} />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <FileIcon name={entry.name} className="size-4 shrink-0" />
            </>
          )}
          <span className="truncate text-[14px] text-fg">{entry.name}</span>
        </button>
        {entry.type === 'file' && !selection.active && (
          <span className="shrink-0 pr-1.5">
            <RowMenu label={`Actions for ${entry.name}`} actions={fileMenuActions(entry.path, onPreview)} />
          </span>
        )}
      </div>

      {entry.type === 'dir' && open && (
        <ul className="flex flex-col gap-0.5">
          {loading && (
            <li style={{ paddingLeft: indent + 20 }} className="py-1 text-[12px] text-muted">
              loading…
            </li>
          )}
          {!loading && children?.length === 0 && (
            <li style={{ paddingLeft: indent + 20 }} className="py-1 text-[12px] text-muted">
              empty
            </li>
          )}
          {!loading &&
            children?.map((c) => (
              <TreeNode
                key={c.path}
                projectId={projectId}
                entry={c}
                depth={depth + 1}
                onOpenFile={onOpenFile}
                onPreview={onPreview}
              />
            ))}
        </ul>
      )}
    </li>
  )
}

function TreeSkeleton(): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-2 px-3 py-1.5">
      {[60, 45, 70, 50, 65, 40].map((w, i) => (
        <li key={i} className="h-4 animate-pulse rounded bg-panel-2" style={{ width: `${w}%` }} />
      ))}
    </ul>
  )
}

// --- File-type icons: minimal, lucide-only (PHASE-3.md design call 5 — no
// per-language colored glyph set, no new dependency). -----------------------

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'rb', 'php', 'sh', 'bash', 'yml', 'yaml', 'toml', 'sql',
])
const JSON_EXT = new Set(['json', 'jsonc'])
const MARKDOWN_EXT = new Set(['md', 'mdx'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])

/** Whether a name/path is a markdown file — gates the per-row "Open preview" kebab. */
function isMarkdown(name: string): boolean {
  return MARKDOWN_EXT.has(name.split('.').pop()?.toLowerCase() ?? '')
}

function FileIcon({ name, className }: { name: string; className: string }): React.JSX.Element {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const skin = `${className} text-muted`
  if (JSON_EXT.has(ext)) return <FileJson className={skin} />
  if (MARKDOWN_EXT.has(ext)) return <FileText className={skin} />
  if (IMAGE_EXT.has(ext)) return <ImageIcon className={skin} />
  if (CODE_EXT.has(ext)) return <FileCode className={skin} />
  return <File className={skin} />
}
