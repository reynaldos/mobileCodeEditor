import type { Project } from '@mce/protocol'
import { ChevronDown, ChevronUp, ExternalLink, Loader, Terminal, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Drawer as Vaul } from 'vaul'
import { previewUrl } from '../api.ts'
import type { Preview } from '../usePreview.ts'
import { usePreviewStream } from '../usePreviewStream.ts'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx'

/** Peek: just enough to read the project name and reach the raise/close controls. Full: nearly the whole viewport. */
const PEEK = 0.12
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
  const [showTerminal, setShowTerminal] = useState(false)

  // A fresh projectId is a fresh preview instance — nothing carries over.
  useEffect(() => {
    setReady(false)
    setShowTerminal(false)
  }, [projectId])

  useEffect(() => {
    if (stream.phase === 'running') setReady(true)
  }, [stream.phase])

  const nameOf = (id: string | null): string => (id && (projects.find((p) => p.id === id)?.name ?? id)) || ''

  return (
    <>
      <Vaul.Root
        open={projectId !== null}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        modal={false}
        snapPoints={[PEEK, FULL]}
        activeSnapPoint={raised ? FULL : PEEK}
        setActiveSnapPoint={(snap) => (snap === FULL ? raise() : peek())}
      >
        <Vaul.Portal>
          <Vaul.Content className="fixed inset-x-0 bottom-0 z-40 flex h-full flex-col rounded-t-2xl border-t border-line bg-panel shadow-2xl outline-none">
            <div className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-line" />

            <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2.5">
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
                {projectId && (
                  <a
                    href={previewUrl(projectId)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-line"
                    title="Open in new tab"
                    aria-label="Open in new tab"
                  >
                    <ExternalLink className="size-4" />
                  </a>
                )}
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

            {/* Never unmounted by peek/raise — only hidden — so HMR and scroll survive. */}
            <div className={raised ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              {startError ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
                  <TriangleAlert className="size-5 text-del" />
                  <p className="text-[13px] text-del">{startError}</p>
                </div>
              ) : (
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {ready && projectId && (
                    <iframe
                      src={previewUrl(projectId)}
                      title={`Preview: ${nameOf(projectId)}`}
                      className="w-full flex-1 border-0 bg-white"
                    />
                  )}
                  {!ready && stream.phase !== 'error' && (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
                      <Loader className="size-5 animate-spin text-accent" />
                      <span className="text-[13px]">Starting dev server…</span>
                    </div>
                  )}
                  {!ready && stream.phase === 'error' && (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
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
