import type { Project } from '@mce/protocol'
import { Loader, Power, RotateCw, Terminal, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { previewUrl } from '../api.ts'
import type { Preview } from '../usePreview.ts'
import { usePreviewStream } from '../usePreviewStream.ts'
import { ActionsMenu } from './ActionsMenu.tsx'
import { PeekDrawer } from './PeekDrawer.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx'

interface Props {
  preview: Preview
  projects: Project[]
  /** Strip position while minimized (see `peekSlots`). */
  slot: number
}

/**
 * A minimizable drawer with a persistent iframe (PHASE-5.md): tapping the nav
 * button starts the project's dev server and this rises to show it. Lowering
 * to the strip keeps the server (and the iframe — never unmounted, only
 * hidden via CSS, so HMR/scroll survive) alive so the thread stays reachable;
 * only a full close — drag-dismiss or the strip's × — stops the server. The
 * drawer mechanics themselves live in `PeekDrawer`, shared with every drawer.
 */
export function PreviewDrawer({ preview, projects, slot }: Props): React.JSX.Element {
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
      <PeekDrawer
        open={projectId !== null}
        raised={raised}
        slot={slot}
        onRaise={raise}
        onPeek={peek}
        onClose={close}
        title={<>Previewing {nameOf(projectId)}</>}
        actions={
          <ActionsMenu
            actions={[
              { key: 'refresh', label: 'Refresh', icon: RotateCw, onClick: refresh },
              { key: 'kill', label: 'Stop preview', icon: Power, onClick: close },
            ]}
          />
        }
        closeLabel="Close preview"
        closeTitle="Close preview (stops the dev server)"
      >
        {/* Readonly address of what the iframe is showing. Tap to select-all
            (no open-in-tab button — that pops out of and locks the PWA). */}
        {projectId && (
          <div className="shrink-0 px-4 pb-2">
            <input
              readOnly
              value={currentUrl ?? displayUrl(projectId)}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Preview URL"
              className="w-full truncate rounded-md border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-muted focus:outline-none"
            />
          </div>
        )}

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
      </PeekDrawer>

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
