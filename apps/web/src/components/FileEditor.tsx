import CodeMirror from '@uiw/react-codemirror'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import type { Extension } from '@codemirror/state'
import { Loader, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchFileContent } from '../api.ts'

/** Open-tab cap (PHASE-3.md design call 6). A hidden-but-mounted CodeMirror instance still costs real memory on a phone, so this can't be unbounded. */
const MAX_TABS = 8

export interface OpenFilesState {
  /** Stable insertion order — the tab strip's left-to-right position never reshuffles as you switch tabs. */
  order: string[]
  active: string | null
  /** Open a file: adds a tab if new (evicting the least-recently-viewed tab past the cap) and makes it active. */
  open: (path: string) => void
  /** Switch to an already-open tab. */
  select: (path: string) => void
  close: (path: string) => void
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
  // Reserved for once editing ships: a tab in here is skipped by the
  // evictor so unsaved work is never silently dropped. Always empty in v1
  // (read-only), so eviction currently considers every open tab.
  const dirty = useRef<Set<string>>(new Set())

  const touch = useCallback((path: string) => {
    recency.current.set(path, tick.current++)
  }, [])

  const leastRecentlyViewed = useCallback((paths: string[]): string | undefined => {
    const candidates = paths.filter((p) => !dirty.current.has(p))
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

  const select = useCallback(
    (path: string) => {
      touch(path)
      setActive(path)
    },
    [touch],
  )

  const close = useCallback((path: string) => {
    recency.current.delete(path)
    dirty.current.delete(path)
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

  return { order, active, open, select, close }
}

interface FileState {
  content: string | null
  error: string | null
}

interface Props {
  projectId: string
  tabs: OpenFilesState
  /** Hidden-not-unmounted (matches `PreviewDrawer`'s iframe trick) — switching back to the tree keeps every open tab's scroll position and content cached. */
  hidden: boolean
}

/**
 * The tab strip + read-only CodeMirror 6 viewer (PHASE-3.md design calls 6
 * and 7). Every open tab's `<CodeMirror>` stays mounted; only the active
 * one is visible — that's what makes switching tabs free of any reload or
 * lost scroll position.
 */
export function FileEditor({ projectId, tabs, hidden }: Props): React.JSX.Element {
  const [cache, setCache] = useState<Map<string, FileState>>(new Map())

  // Fetch content for any newly-opened tab, once.
  useEffect(() => {
    for (const path of tabs.order) {
      if (cache.has(path)) continue
      setCache((prev) => new Map(prev).set(path, { content: null, error: null }))
      void fetchFileContent(projectId, path)
        .then((r) => setCache((prev) => new Map(prev).set(path, { content: r.content, error: null })))
        .catch(() => setCache((prev) => new Map(prev).set(path, { content: null, error: "Couldn't load this file." })))
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

  if (tabs.order.length === 0) {
    return <div className={hidden ? 'hidden' : 'flex flex-1 items-center justify-center text-[13px] text-muted'}>No file open.</div>
  }

  return (
    <div className={hidden ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
      <div className="scroll-cap flex shrink-0 items-stretch gap-px overflow-x-auto border-b border-line bg-panel-2">
        {tabs.order.map((path) => (
          <Tab key={path} path={path} active={path === tabs.active} onSelect={() => tabs.select(path)} onClose={() => tabs.close(path)} />
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {tabs.order.map((path) => (
          <div key={path} className={path === tabs.active ? 'h-full' : 'hidden'}>
            <FileContent state={cache.get(path)} path={path} />
          </div>
        ))}
      </div>
    </div>
  )
}

function Tab({
  path,
  active,
  onSelect,
  onClose,
}: {
  path: string
  active: boolean
  onSelect: () => void
  onClose: () => void
}): React.JSX.Element {
  const name = path.split('/').pop() ?? path
  return (
    <div
      className={`flex shrink-0 items-center gap-1.5 border-r border-line px-3 py-2 text-[13px] ${
        active ? 'bg-panel text-fg' : 'text-muted'
      }`}
    >
      <button className="max-w-32 truncate" title={path} onClick={onSelect}>
        {name}
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

function FileContent({ state, path }: { state: FileState | undefined; path: string }): React.JSX.Element {
  if (!state || state.content === null) {
    if (state?.error) return <p className="p-4 text-center text-[13px] text-del">{state.error}</p>
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Loader className="size-4 animate-spin" />
        <span className="text-[13px]">Loading…</span>
      </div>
    )
  }
  return (
    <CodeMirror
      value={state.content}
      editable={false}
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
