import type { Project } from '@mce/protocol'
import { ChevronDown, ChevronUp, Loader, Power, RotateCw, Terminal, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Drawer as Vaul } from 'vaul'
import { previewUrl } from '../api.ts'
import type { Preview } from '../usePreview.ts'
import { usePreviewStream } from '../usePreviewStream.ts'
import { ActionsMenu } from './ActionsMenu.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx'

/**
 * Peeked-strip height: just the drag handle + title row and the raise/close
 * controls. A fixed px value (not a viewport fraction) so App can lift the
 * prompt box by *exactly* this much — otherwise the peeked bar sits on top of
 * it. Exported for that reason; the padding lives in styles.css `.app`.
 */
export const PREVIEW_PEEK = '72px'
/** Full: nearly the whole viewport. */
const FULL = 0.95

interface Props {
  preview: Preview
  projects: Project[]
}

/**
 * A peekable drawer with a persistent iframe (PHASE-5.md): tapping the nav
 * button starts the project's dev server and this rises to show it. Lowering
 * to the peek strip keeps the server (and the iframe — never unmounted, only
 * hidden via CSS, so HMR/scroll survive) alive so the thread stays reachable;
 * only a full close — drag-dismiss or the peeked bar's × — stops the server.
 *
 * Non-modal (no backdrop): peeking is meant to let you keep using the thread
 * underneath, not merely glimpse it behind a dimmed overlay.
 */
export function PreviewDrawer({ preview, projects }: Props): React.JSX.Element {
  const { projectId, raised, startError, conflictWith, confirmEvict, cancelConflict, raise, peek, close } = preview
  const stream = usePreviewStream(projectId)
  const [ready, setReady] = useState(false)
  // The dev server being up (`ready`) is not the page being painted: the iframe
  // still has to fetch and render, and until it does it's a white rectangle.
  // Hold the spinner over it until `onLoad` fires so there's no white flash.
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  // The iframe's live location, shown in the URL box so it tracks where the user
  // navigates. Null until the first read → the box falls back to the base URL.
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // A fresh projectId is a fresh preview instance — nothing carries over.
  useEffect(() => {
    setReady(false)
    setIframeLoaded(false)
    setShowTerminal(false)
    setCurrentUrl(null)
  }, [projectId])

  useEffect(() => {
    if (stream.phase === 'running') setReady(true)
  }, [stream.phase])

  // Reflect where the user has navigated. The preview is same-origin, so reading
  // the iframe's location just works. `onLoad` catches full navigations (our
  // in-preview redirects included); the poll catches SPA pushState, which fires
  // no load event. Runs only while the preview is up and raised.
  const syncUrl = useCallback(() => {
    try {
      const href = iframeRef.current?.contentWindow?.location?.href
      if (href && href !== 'about:blank') setCurrentUrl(href)
    } catch {
      /* cross-origin read blocked (shouldn't happen for a same-origin preview) — keep the last */
    }
  }, [])

  useEffect(() => {
    if (!raised || !ready) return
    const id = setInterval(syncUrl, 750)
    return () => clearInterval(id)
  }, [raised, ready, syncUrl])

  // In dev the preview is a *different origin* (Vite :5173 vs the proxy :3000),
  // so the poll above can't read its location — the frame reports it instead, via
  // the script injected into its HTML (see server.ts). Trust only the shape we
  // injected; a preview page could carry any other postMessage traffic.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const url = (e.data as { __mcePreviewUrl?: unknown } | null)?.__mcePreviewUrl
      if (typeof url === 'string') setCurrentUrl(url)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // While peeked, undo two Vaul "modal" behaviors that make the thread behind the
  // drawer unusable. Both are correct while RAISED (the drawer covers the screen),
  // so this only runs when lowered to the peek strip.
  //  1) Vaul locks `body { pointer-events: none }` — nothing behind it is clickable.
  //  2) Vaul's Radix focus scope is `trapped`, so focus is yanked back to the drawer
  //     the instant you focus a thread input — you can click it (I-beam shows) but
  //     can't type. Headless browsers skip that refocus, which is why it only shows
  //     in a real browser.
  useEffect(() => {
    if (projectId === null || raised) return
    const body = document.body

    // (1) keep the body interactive; re-assert since Vaul rewrites the style on snap/drag.
    const unlock = (): void => {
      if (body.style.pointerEvents === 'none') body.style.pointerEvents = 'auto'
    }
    unlock()
    const styleObserver = new MutationObserver(unlock)
    styleObserver.observe(body, { attributes: true, attributeFilter: ['style'] })

    // (2) stop the focus-scope steal: swallow focus events, before Radix's document
    // handlers, whenever focus moves to something OUTSIDE the drawer. Focus into the
    // drawer's own controls (inside `contentRef`) is left alone.
    const stopSteal = (e: FocusEvent): void => {
      const content = contentRef.current
      if (!content) return
      const to = e.type === 'focusout' ? (e.relatedTarget as Node | null) : (e.target as Node | null)
      if (to && !content.contains(to)) e.stopImmediatePropagation()
    }
    document.addEventListener('focusin', stopSteal, true)
    document.addEventListener('focusout', stopSteal, true)

    return () => {
      styleObserver.disconnect()
      document.removeEventListener('focusin', stopSteal, true)
      document.removeEventListener('focusout', stopSteal, true)
    }
  }, [projectId, raised])

  // Reload the current page in the iframe (same-origin, so this just works).
  // Drop `iframeLoaded` so the spinner covers the reload instead of flashing white.
  const refresh = useCallback(() => {
    const frame = iframeRef.current
    if (!frame) return
    setIframeLoaded(false)
    try {
      frame.contentWindow?.location.reload()
    } catch {
      frame.src = frame.src // cross-origin fallback (shouldn't happen)
    }
  }, [])

  const nameOf = (id: string | null): string => (id && (projects.find((p) => p.id === id)?.name ?? id)) || ''

  return (
    <>
      <Vaul.Root
        open={projectId !== null}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        modal={false}
        snapPoints={[PREVIEW_PEEK, FULL]}
        activeSnapPoint={raised ? FULL : PREVIEW_PEEK}
        setActiveSnapPoint={(snap) => (snap === FULL ? raise() : peek())}
      >
        <Vaul.Portal>
          {/* The content is full-height and translated down to the peek strip, so
              when peeked its off-strip area still overlaps the thread. `modal=false`
              means no backdrop, but the element itself would swallow taps — kill its
              pointer events when peeked and re-enable only the visible strip, so the
              thread underneath stays fully usable. */}
          <Vaul.Content
            ref={contentRef}
            className={`fixed inset-x-0 bottom-0 z-40 flex h-full flex-col rounded-t-2xl border-t border-line bg-panel shadow-2xl outline-none ${
              raised ? '' : 'pointer-events-none'
            }`}
          >
            <div className="pointer-events-auto mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-line" />

            <div className="pointer-events-auto flex shrink-0 items-center justify-between gap-2 px-4 py-2.5">
              <button
                className="flex min-w-0 items-center gap-2 text-left"
                onClick={raised ? peek : raise}
                aria-label={raised ? 'Peek' : 'Raise'}
              >
                {raised ? (
                  <ChevronDown className="size-4 shrink-0 text-muted" />
                ) : (
                  <ChevronUp className="size-4 shrink-0 text-muted" />
                )}
                <span className="truncate text-[14px] font-medium text-fg">Previewing {nameOf(projectId)}</span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <ActionsMenu
                  actions={[
                    { key: 'refresh', label: 'Refresh', icon: RotateCw, onClick: refresh },
                    { key: 'kill', label: 'Stop preview', icon: Power, onClick: close },
                  ]}
                />
                <button
                  className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-line"
                  onClick={close}
                  aria-label="Close preview"
                  title="Close preview (stops the dev server)"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Readonly address of what the iframe is showing. Tap to select-all
                (no open-in-tab button — that pops out of and locks the PWA). Only
                while raised, so the peek strip stays minimal. */}
            {raised && projectId && (
              <div className="pointer-events-auto shrink-0 px-4 pb-2">
                <input
                  readOnly
                  value={currentUrl ?? displayUrl(projectId)}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Preview URL"
                  className="w-full truncate rounded-md border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-muted focus:outline-none"
                />
              </div>
            )}

            {/* Never unmounted by peek/raise — only hidden — so HMR and scroll survive. */}
            <div className={raised ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              {startError ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
                  <TriangleAlert className="size-5 text-del" />
                  <p className="text-[13px] text-del">{startError}</p>
                </div>
              ) : (
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {/* sandbox without allow-popups / allow-top-navigation: the previewed
                      app can't open a new browser tab (which pops out of and locks the
                      PWA) nor navigate the top frame. Its own in-app routing still works
                      — that's the iframe navigating itself, which is always allowed. */}
                  {ready && projectId && (
                    <iframe
                      ref={iframeRef}
                      src={previewUrl(projectId)}
                      title={`Preview: ${nameOf(projectId)}`}
                      onLoad={() => {
                        setIframeLoaded(true)
                        syncUrl()
                      }}
                      className="w-full flex-1 border-0 bg-white"
                    />
                  )}
                  {/* One spinner until the server is up AND the page has painted (iframe
                      onLoad), so the white iframe never flashes between the two. */}
                  {stream.phase !== 'error' && !(ready && iframeLoaded) && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-panel text-muted">
                      <Loader className="size-5 animate-spin text-accent" />
                      <span className="text-[13px]">{ready ? 'Loading preview…' : 'Starting dev server…'}</span>
                    </div>
                  )}
                  {!ready && stream.phase === 'error' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-panel p-4 text-center">
                      <TriangleAlert className="size-5 text-del" />
                      <p className="text-[13px] text-del">{stream.error ?? 'The dev server failed to start.'}</p>
                    </div>
                  )}
                  {ready && stream.phase === 'error' && (
                    <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-del/90 px-3 py-2 text-[13px] text-white">
                      <TriangleAlert className="size-4 shrink-0" />
                      <span className="truncate">{stream.error ?? 'The dev server stopped unexpectedly.'}</span>
                    </div>
                  )}

                  <button
                    className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-lg border border-line bg-panel/90 px-2.5 py-1.5 text-[12px] text-muted backdrop-blur hover:text-fg"
                    onClick={() => setShowTerminal((s) => !s)}
                  >
                    <Terminal className="size-3.5" />
                    {showTerminal ? 'Hide output' : 'Show output'}
                  </button>
                  {showTerminal && (
                    <div className="absolute inset-x-2 bottom-12 max-h-[40%] overflow-y-auto rounded-lg border border-line bg-bg/95 p-2.5 font-mono text-[11px] leading-relaxed text-muted backdrop-blur">
                      {stream.lines.length === 0 ? (
                        <span className="opacity-50">waiting for output…</span>
                      ) : (
                        stream.lines.map((line, i) => (
                          <div key={i} className="whitespace-pre-wrap break-all">
                            {line}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Vaul.Content>
        </Vaul.Portal>
      </Vaul.Root>

      <Dialog open={conflictWith !== null} onOpenChange={(o) => !o && cancelConflict()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop the other preview?</DialogTitle>
            <DialogDescription>
              This will stop the preview running for <strong>{nameOf(conflictWith)}</strong>. Continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              className="min-h-11 flex-1 rounded-xl border border-line bg-panel-2 text-[14px] font-medium text-fg"
              onClick={cancelConflict}
            >
              Cancel
            </button>
            <button
              className="min-h-11 flex-1 rounded-xl border border-accent bg-accent text-[14px] font-semibold text-[#06101f]"
              onClick={confirmEvict}
            >
              Stop &amp; start
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Absolute address of a project's preview, for the readonly URL box. `previewUrl`
 *  is same-origin and usually relative (`/preview/<id>/`); show it with the origin
 *  so the box reads as a real URL. */
function displayUrl(projectId: string): string {
  const u = previewUrl(projectId)
  return u.startsWith('http') ? u : `${window.location.origin}${u}`
}
