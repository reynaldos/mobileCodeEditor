import CodeMirror from '@uiw/react-codemirror'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import type { Extension } from '@codemirror/state'
import { Check, Loader, Save, X } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { fetchFileContent, saveFileContent } from '../api.ts'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx'

// The markdown preview pulls in the react-markdown + remark/rehype stack; keep
// it code-split so a source-only session never loads it.
const MarkdownPreview = lazy(() => import('./MarkdownPreview.tsx').then((m) => ({ default: m.MarkdownPreview })))

// A rendered markdown preview rides in the same tab strip as source files, but
// as its own tab keyed `preview:<path>` — so a file's source and its preview can
// be open side by side without colliding. These helpers are the one place that
// scheme is encoded/decoded.
const PREVIEW_PREFIX = 'preview:'
export function previewTabId(path: string): string {
  return PREVIEW_PREFIX + path
}
export function isPreviewTab(id: string): boolean {
  return id.startsWith(PREVIEW_PREFIX)
}
/** The real file path behind a tab id (identity for a source tab, prefix-stripped for a preview tab). */
export function tabFilePath(id: string): string {
  return isPreviewTab(id) ? id.slice(PREVIEW_PREFIX.length) : id
}
/** Tab-strip / header label: bare file name for a source tab, `(Preview) name` for a preview tab. */
export function tabLabel(id: string): string {
  const path = tabFilePath(id)
  const name = path.split('/').pop() ?? path
  return isPreviewTab(id) ? `(Preview) ${name}` : name
}

/** Open-tab cap (PHASE-3.md design call 6). A hidden-but-mounted CodeMirror instance still costs real memory on a phone, so this can't be unbounded. */
const MAX_TABS = 8

export interface OpenFilesState {
  /** Stable insertion order — the tab strip's left-to-right position never reshuffles as you switch tabs. */
  order: string[]
  active: string | null
  /** Open a file: adds a tab if new (evicting the least-recently-viewed tab past the cap) and makes it active. */
  open: (path: string) => void
  /** Open a file's rendered markdown preview as its own `(Preview)` tab. */
  openPreview: (path: string) => void
  /** Switch to an already-open tab. */
  select: (path: string) => void
  close: (path: string) => void
  /** Tab ids with unsaved edits — drives the dirty dot and the close guards. */
  dirty: Set<string>
  /** The editor reports which tabs are dirty, so eviction skips them and closing can warn. */
  setDirty: (id: string, isDirty: boolean) => void
}

/**
 * Owns the open-file tab list: order, active tab, and the 8-tab LRU eviction
 * (PHASE-3.md design call 6). Recency is tracked separately from `order` so
 * the visible tab strip position stays stable — only eviction cares which
 * tab was viewed longest ago.
 */
export function useOpenFiles(): OpenFilesState {
  const [order, setOrder] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const recency = useRef<Map<string, number>>(new Map())
  const tick = useRef(0)
  // Tabs with unsaved edits. Kept as state (so the dirty dot + close guards
  // react) plus a ref mirror (so the evictor, which runs inside `open`'s
  // callback, can read the current set without a stale closure). A dirty tab is
  // skipped by the evictor so unsaved work is never silently dropped.
  const [dirty, setDirtyState] = useState<Set<string>>(() => new Set())
  const dirtyRef = useRef<Set<string>>(new Set())

  const setDirty = useCallback((id: string, isDirty: boolean) => {
    if (dirtyRef.current.has(id) === isDirty) return
    const next = new Set(dirtyRef.current)
    if (isDirty) next.add(id)
    else next.delete(id)
    dirtyRef.current = next
    setDirtyState(next)
  }, [])

  const touch = useCallback((path: string) => {
    recency.current.set(path, tick.current++)
  }, [])

  const leastRecentlyViewed = useCallback((paths: string[]): string | undefined => {
    const candidates = paths.filter((p) => !dirtyRef.current.has(p))
    const pool = candidates.length > 0 ? candidates : paths
    return pool.reduce((a, b) => ((recency.current.get(a) ?? -1) <= (recency.current.get(b) ?? -1) ? a : b))
  }, [])

  const open = useCallback(
    (path: string) => {
      touch(path)
      setActive(path)
      setOrder((prev) => {
        if (prev.includes(path)) return prev
        let next = [...prev, path]
        if (next.length > MAX_TABS) {
          const evict = leastRecentlyViewed(next)
          if (evict) {
            next = next.filter((p) => p !== evict)
            recency.current.delete(evict)
          }
        }
        return next
      })
    },
    [touch, leastRecentlyViewed],
  )

  const openPreview = useCallback((path: string) => open(previewTabId(path)), [open])

  const select = useCallback(
    (path: string) => {
      touch(path)
      setActive(path)
    },
    [touch],
  )

  const close = useCallback((path: string) => {
    recency.current.delete(path)
    setDirty(path, false)
    setOrder((prev) => {
      const next = prev.filter((p) => p !== path)
      setActive((cur) => {
        if (cur !== path) return cur
        if (next.length === 0) return null
        return next.reduce((a, b) => ((recency.current.get(a) ?? -1) >= (recency.current.get(b) ?? -1) ? a : b))
      })
      return next
    })
  }, [])

  return { order, active, open, openPreview, select, close, dirty, setDirty }
}

interface FileState {
  /** Last-persisted content; null while loading or on load error. */
  saved: string | null
  /** Current editor content (diverges from `saved` when edited). */
  value: string
  error: string | null
  saving: boolean
  saveError: string | null
}

/** A tab is dirty once its editor buffer diverges from what's on disk. */
function isDirty(s: FileState | undefined): boolean {
  return !!s && s.saved !== null && s.value !== s.saved
}

interface Props {
  projectId: string
  tabs: OpenFilesState
  /** Hidden-not-unmounted (matches `PreviewDrawer`'s iframe trick) — switching back to the tree keeps every open tab's scroll position and content cached. */
  hidden: boolean
}

/**
 * The tab strip + editable CodeMirror 6 editor (PHASE-3.md design calls 6 and 7,
 * now with the deferred write pass). Every open tab's `<CodeMirror>` stays
 * mounted; only the active one is visible — that's what makes switching tabs free
 * of any reload or lost scroll position. Edits are buffered per tab; **Save**
 * (`PUT /fs/file`) writes the whole file, and closing a dirty tab confirms first.
 */
export function FileEditor({ projectId, tabs, hidden }: Props): React.JSX.Element {
  const [cache, setCache] = useState<Map<string, FileState>>(new Map())
  // Tab id pending an unsaved-changes confirmation on close, or null.
  const [confirmClose, setConfirmClose] = useState<string | null>(null)

  // Fetch content for any newly-opened tab, once. Preview tabs render markdown
  // via their own component, which fetches independently — skip them here.
  useEffect(() => {
    for (const path of tabs.order) {
      if (isPreviewTab(path) || cache.has(path)) continue
      setCache((prev) => new Map(prev).set(path, { saved: null, value: '', error: null, saving: false, saveError: null }))
      void fetchFileContent(projectId, path)
        .then((r) =>
          setCache((prev) => new Map(prev).set(path, { saved: r.content, value: r.content, error: null, saving: false, saveError: null })),
        )
        .catch(() =>
          setCache((prev) => new Map(prev).set(path, { saved: null, value: '', error: "Couldn't load this file.", saving: false, saveError: null })),
        )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tabs.order])

  // Drop cached content for tabs that were closed, so a long session doesn't grow unbounded.
  useEffect(() => {
    setCache((prev) => {
      const stale = [...prev.keys()].filter((p) => !tabs.order.includes(p))
      if (stale.length === 0) return prev
      const next = new Map(prev)
      stale.forEach((p) => next.delete(p))
      return next
    })
  }, [tabs.order])

  // Keep the tab list's dirty set in step with the editor buffers, so the LRU
  // evictor skips unsaved tabs and the drawer knows when to warn on close.
  useEffect(() => {
    for (const [id, s] of cache) tabs.setDirty(id, isDirty(s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache])

  // Closing the drawer keeps tabs mounted (edits survive), but a full page
  // reload/close would drop the in-memory buffers — so warn while any are dirty.
  useEffect(() => {
    if (![...cache.values()].some(isDirty)) return
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [cache])

  function onChange(id: string, value: string): void {
    setCache((prev) => {
      const s = prev.get(id)
      if (!s || s.value === value) return prev
      return new Map(prev).set(id, { ...s, value })
    })
  }

  /** Persist a tab's buffer. Resolves true when the tab is clean afterward. */
  async function save(id: string): Promise<boolean> {
    const s = cache.get(id)
    if (!s || s.saved === null) return false
    if (!isDirty(s)) return true // nothing to do
    if (s.saving) return false
    const value = s.value
    setCache((prev) => {
      const c = prev.get(id)
      return c ? new Map(prev).set(id, { ...c, saving: true, saveError: null }) : prev
    })
    try {
      await saveFileContent(projectId, tabFilePath(id), value)
      setCache((prev) => {
        const c = prev.get(id)
        return c ? new Map(prev).set(id, { ...c, saved: value, saving: false }) : prev
      })
      return true
    } catch {
      setCache((prev) => {
        const c = prev.get(id)
        return c ? new Map(prev).set(id, { ...c, saving: false, saveError: 'Could not save.' }) : prev
      })
      return false
    }
  }

  function requestClose(id: string): void {
    if (isDirty(cache.get(id))) setConfirmClose(id)
    else tabs.close(id)
  }

  if (tabs.order.length === 0) {
    return <div className={hidden ? 'hidden' : 'flex flex-1 items-center justify-center text-[13px] text-muted'}>No file open.</div>
  }

  // The active source tab drives the Save bar; preview tabs have nothing to save.
  const activeSource = tabs.active && !isPreviewTab(tabs.active) ? tabs.active : null
  const activeState = activeSource ? cache.get(activeSource) : undefined

  return (
    <div className={hidden ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
      <div className="scroll-cap flex shrink-0 items-stretch gap-px overflow-x-auto border-b border-line bg-panel-2">
        {tabs.order.map((id) => (
          <Tab
            key={id}
            id={id}
            active={id === tabs.active}
            dirty={isDirty(cache.get(id))}
            onSelect={() => tabs.select(id)}
            onClose={() => requestClose(id)}
          />
        ))}
      </div>

      {activeSource && activeState && activeState.saved !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{tabFilePath(activeSource)}</span>
          {activeState.saveError && <span className="shrink-0 text-[11px] text-del">{activeState.saveError}</span>}
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-panel-2 disabled:opacity-50"
            disabled={!isDirty(activeState) || activeState.saving}
            onClick={() => void save(activeSource)}
          >
            {activeState.saving ? (
              <Loader className="size-3.5 animate-spin" />
            ) : isDirty(activeState) ? (
              <Save className="size-3.5" />
            ) : (
              <Check className="size-3.5 text-add" />
            )}
            {activeState.saving ? 'Saving…' : isDirty(activeState) ? 'Save' : 'Saved'}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {tabs.order.map((id) => (
          <div key={id} className={id === tabs.active ? 'h-full' : 'hidden'}>
            {isPreviewTab(id) ? (
              <Suspense fallback={<Loading />}>
                <MarkdownPreview projectId={projectId} path={tabFilePath(id)} />
              </Suspense>
            ) : (
              <FileContent state={cache.get(id)} path={id} onChange={(v) => onChange(id, v)} />
            )}
          </div>
        ))}
      </div>

      <UnsavedCloseDialog
        path={confirmClose}
        onCancel={() => setConfirmClose(null)}
        onDiscard={() => {
          if (confirmClose) tabs.close(confirmClose)
          setConfirmClose(null)
        }}
        onSaveClose={() => {
          const id = confirmClose
          if (!id) return
          setConfirmClose(null)
          void save(id).then((ok) => ok && tabs.close(id))
        }}
      />
    </div>
  )
}

/** The unsaved-changes confirmation shown when closing a dirty tab. */
function UnsavedCloseDialog({
  path,
  onCancel,
  onDiscard,
  onSaveClose,
}: {
  path: string | null
  onCancel: () => void
  onDiscard: () => void
  onSaveClose: () => void
}): React.JSX.Element {
  const name = path ? (tabFilePath(path).split('/').pop() ?? path) : ''
  return (
    <Dialog open={path !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-fg">{name}</span> has changes that aren’t saved. Save them before closing?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button className="min-h-11 flex-1 rounded-xl text-[14px] font-medium text-del hover:bg-panel-2" onClick={onDiscard}>
            Discard
          </button>
          <DialogClose asChild>
            <button className="min-h-11 flex-1 rounded-xl border border-line bg-panel-2 text-[14px] font-medium text-fg">Cancel</button>
          </DialogClose>
          <button
            className="min-h-11 flex-1 rounded-xl border border-accent bg-accent text-[14px] font-semibold text-[#06101f]"
            onClick={onSaveClose}
          >
            Save &amp; close
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Tab({
  id,
  active,
  dirty,
  onSelect,
  onClose,
}: {
  id: string
  active: boolean
  dirty: boolean
  onSelect: () => void
  onClose: () => void
}): React.JSX.Element {
  const path = tabFilePath(id)
  const name = path.split('/').pop() ?? path
  return (
    <div
      className={`flex shrink-0 items-center gap-1.5 border-r border-line px-3 py-2 text-[13px] ${
        active ? 'bg-panel text-fg' : 'text-muted'
      }`}
    >
      {dirty && <span className="size-1.5 shrink-0 rounded-full bg-accent" title="Unsaved changes" />}
      <button className="max-w-40 truncate" title={path} onClick={onSelect}>
        {tabLabel(id)}
      </button>
      <button
        className="flex size-4 shrink-0 items-center justify-center rounded text-muted hover:bg-line hover:text-fg"
        aria-label={`Close ${name}`}
        onClick={onClose}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/** Shared centered spinner — the preview chunk's Suspense fallback and any load-in-progress state. */
function Loading(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-muted">
      <Loader className="size-4 animate-spin" />
      <span className="text-[13px]">Loading…</span>
    </div>
  )
}

function FileContent({
  state,
  path,
  onChange,
}: {
  state: FileState | undefined
  path: string
  onChange: (value: string) => void
}): React.JSX.Element {
  if (!state || state.saved === null) {
    if (state?.error) return <p className="p-4 text-center text-[13px] text-del">{state.error}</p>
    return <Loading />
  }
  return (
    // `height="100%"` only sizes CodeMirror's inner .cm-editor/.cm-scroller; the
    // library's own wrapper stays `height:auto`, so without `h-full` here the
    // editor grows to its full content height and never scrolls inside the tab.
    <CodeMirror
      className="h-full"
      value={state.value}
      editable
      onChange={onChange}
      theme="dark"
      height="100%"
      extensions={extensionsFor(path)}
      basicSetup={{ foldGutter: true, highlightActiveLine: false }}
    />
  )
}

/** Extension by file extension — a small, deliberately non-exhaustive set covering this app's own stack plus common web-project languages. */
function extensionsFor(path: string): Extension[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return [javascript({ typescript: true })]
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })]
    case 'js':
    case 'mjs':
    case 'cjs':
      return [javascript()]
    case 'jsx':
      return [javascript({ jsx: true })]
    case 'json':
    case 'jsonc':
      return [json()]
    case 'md':
    case 'mdx':
      return [markdown()]
    case 'css':
      return [css()]
    case 'html':
    case 'htm':
      return [html()]
    default:
      return []
  }
}
