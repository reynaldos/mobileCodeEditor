import { ArrowUp, Maximize2, Minimize2, Plus, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { sendPrompt, uploadImages } from '../api.ts'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from './ui/drawer.tsx'

/** Mirrors workspace-server's UploadStore — kept in sync by hand since the
 *  protocol package is types-only (no runtime exports). Fast local rejection
 *  before spending a round trip on something the server will refuse anyway. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

interface PendingImage {
  /** Client-only id, for React keys and removal — not the server's ImageRef.id. */
  key: string
  previewUrl: string
  status: 'uploading' | 'done' | 'error'
  /** Set once the upload resolves — what actually rides the prompt. */
  id?: string
  error?: string
}

export function PromptBox({
  projectId,
  threadId,
  disabledReason,
}: {
  projectId: string | null
  threadId: string | null
  disabledReason?: string
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [isMultiline, setIsMultiline] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const ready = Boolean(projectId && threadId && !disabledReason)

  const libraryRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Cleanup reads the LATEST images, not whatever was captured when the effect
  // was set up — a plain empty-deps effect would otherwise revoke only the
  // (usually empty) set from first render.
  const imagesRef = useRef<PendingImage[]>(images)
  imagesRef.current = images
  useEffect(
    () => () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl)
    },
    [],
  )

  // Driven off `text` rather than the DOM `input` event so it also fires when
  // `text` is cleared programmatically (e.g. after send) — an `onInput`
  // handler only sees real user keystrokes and would leave the box stuck at
  // its last-grown height after a submit.
  //
  // Skipped while expanded: the drawer's textarea fills its container via
  // flex-1 (CSS), and setting an inline px height here would fight that.
  //
  // `useLayoutEffect`, not `useEffect`: this measures the DOM (scrollHeight)
  // and then mutates it (inline height, which flips `isMultiline` and thus
  // the grid layout around it) in response to that measurement. A plain
  // `useEffect` runs after the browser has already painted the pre-resize
  // frame, so every keystroke that crossed the wrap threshold painted one
  // visible frame at the wrong height/layout before snapping to the right
  // one — the "flighty"/glitchy jump while typing. Doing it synchronously
  // before paint collapses that to a single frame.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el || expanded) return
    el.style.height = 'auto'
    const scrollHeight = el.scrollHeight
    el.style.height = `${Math.min(scrollHeight, 160)}px`
    // A single resting line lands right at the min-height (~36px); anything
    // past that means the box has actually grown, whether from an explicit
    // newline or the line simply wrapping.
    setIsMultiline(scrollHeight > 44)
  }, [text, expanded])

  // Re-focus after switching modes — the compact and expanded views render
  // distinct <textarea> elements (mounted one at a time), so toggling
  // `expanded` unmounts one and mounts the other, which would otherwise drop
  // focus and dismiss the on-screen keyboard.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [expanded])

  const uploading = images.some((i) => i.status === 'uploading')

  /**
   * Uploads eagerly, on selection/paste — not deferred to Send. That gives
   * instant feedback (the preview shows before the network call even starts,
   * via a local object URL) and lets Send just gate on `!uploading` instead of
   * doing the whole upload-then-send round trip synchronously.
   */
  function handleFiles(files: File[]): void {
    if (files.length === 0) return

    const entries: PendingImage[] = files.map((file) => {
      const key = crypto.randomUUID()
      const previewUrl = URL.createObjectURL(file)
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        return { key, previewUrl, status: 'error', error: 'unsupported image format' }
      }
      if (file.size > MAX_IMAGE_BYTES) {
        return { key, previewUrl, status: 'error', error: 'image is too large' }
      }
      return { key, previewUrl, status: 'uploading' }
    })
    setImages((prev) => [...prev, ...entries])

    const toUpload = entries
      .map((entry, i) => [entry, files[i]!] as const)
      .filter(([entry]) => entry.status === 'uploading')
    if (toUpload.length === 0) return

    void uploadImages(toUpload.map(([, file]) => file))
      .then((refs) => {
        setImages((prev) =>
          prev.map((img) => {
            const i = toUpload.findIndex(([entry]) => entry.key === img.key)
            if (i === -1) return img
            const ref = refs[i]
            return ref ? { ...img, status: 'done', id: ref.id } : { ...img, status: 'error', error: 'upload failed' }
          }),
        )
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        const keys = new Set(toUpload.map(([entry]) => entry.key))
        setImages((prev) => prev.map((img) => (keys.has(img.key) ? { ...img, status: 'error', error: message } : img)))
      })
  }

  function removeImage(key: string): void {
    setImages((prev) => {
      const target = prev.find((i) => i.key === key)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((i) => i.key !== key)
    })
  }

  async function submit(): Promise<void> {
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0) || sending || !projectId || !threadId || !ready || uploading) return

    setSending(true)
    setError(undefined)
    try {
      const imageIds = images.filter((i): i is PendingImage & { id: string } => i.status === 'done' && Boolean(i.id)).map((i) => i.id)
      await sendPrompt(trimmed, projectId, threadId, imageIds)
      setText('')
      for (const img of images) URL.revokeObjectURL(img.previewUrl)
      setImages([])
      setExpanded(false)
      // The `user_prompt` event comes back over SSE and renders itself.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  // Shared across the compact bar and the expanded drawer below — kept as
  // plain values (not components) since only one of the two branches ever
  // mounts at a time, so reusing the same element/props twice is safe.
  const imagesStrip = images.length > 0 && (
    <div className="mb-2 flex shrink-0 gap-2 overflow-x-auto">
      {images.map((img) => (
        <div key={img.key} className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-line">
          <img src={img.previewUrl} alt="" className="size-full object-cover" />
          {img.status === 'uploading' && (
            <div className="absolute inset-0 grid place-items-center bg-black/40 text-[11px] text-white">…</div>
          )}
          {img.status === 'error' && (
            <div
              className="absolute inset-0 grid place-items-center bg-del/70 text-[11px] text-white"
              title={img.error}
            >
              !
            </div>
          )}
          <button
            type="button"
            onClick={() => removeImage(img.key)}
            aria-label="Remove image"
            className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-black/60 text-white"
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  )

  const addPhotoButton = (
    <button
      key="add"
      type="button"
      aria-label="Add a photo"
      disabled={!ready}
      onClick={() => libraryRef.current?.click()}
      className="grid size-9 shrink-0 place-items-center rounded-full text-muted disabled:opacity-50"
    >
      <Plus size={18} />
    </button>
  )

  const sendButton = (
    <button
      key="send"
      aria-label="Send"
      className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-[#06101f] disabled:opacity-50"
      disabled={sending || (!text.trim() && images.length === 0) || !ready || uploading}
      onClick={() => void submit()}
    >
      {sending ? '…' : <ArrowUp size={18} />}
    </button>
  )

  const expandButton = (
    <button
      key="expand"
      type="button"
      aria-label="Expand"
      onClick={() => setExpanded(true)}
      className="grid size-9 shrink-0 place-items-center rounded-full text-muted"
    >
      <Maximize2 size={16} />
    </button>
  )

  const textareaCommonProps = {
    ref: textareaRef,
    value: text,
    disabled: !ready,
    placeholder: ready ? 'Plan, ask, build…' : (disabledReason ?? 'Pick a project and thread'),
    // Enter inserts a newline on a phone keyboard. Sending is a button.
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value),
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // Does NOT preventDefault — a plain text paste must still work.
      const files = [...e.clipboardData.items]
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null)
      if (files.length > 0) handleFiles(files)
    },
  }

  return (
    <>
      {/* Shared by both branches below, so it has to live outside either one
       *  — otherwise the ref goes stale for whichever branch isn't mounted. */}
      <input
        ref={libraryRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />

      {/* Hidden (not unmounted-by-ternary into the drawer) while expanded, so
       *  there's only ever one mounted <textarea ref={textareaRef}> at a time —
       *  the drawer below mounts its own only once `expanded` flips true. */}
      {!expanded && (
        // `prompt-bar` is targeted by a :has() rule that drops the safe-area padding
        // once the keyboard has lifted the app. See styles.css.
        <div className="prompt-bar shrink-0 border-t border-line bg-panel px-3 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))]">
          {error && <p className="mb-2 text-[13px] text-del">{error}</p>}
          {imagesStrip}

          {/* One persistent grid: the textarea and both buttons stay mounted
           *  at the same DOM position at all times — only which grid cell
           *  they occupy changes between single-line and multiline. The
           *  previous version swapped between two entirely different JSX
           *  trees when `isMultiline` flipped, which forced React to
           *  unmount/remount the buttons (and shuffle the textarea's parent)
           *  on every keystroke that crossed the line-wrap threshold. On iOS
           *  that mid-keystroke DOM churn was tearing down the native text
           *  input session, which is what produced the duplicated/garbled
           *  characters. Moving grid cells via CSS instead of moving nodes
           *  via React reconciliation avoids that entirely. */}
          <div
            className="grid items-center gap-x-1 gap-y-1 rounded-3xl border border-line bg-panel-2 py-1.5 pr-3 pl-1.5 focus-within:border-accent"
            style={
              isMultiline
                ? { gridTemplateColumns: 'auto 1fr auto', gridTemplateAreas: '"text text expand" "add . send"' }
                : { gridTemplateColumns: 'auto 1fr auto', gridTemplateAreas: '"add text send"' }
            }
          >
            <div style={{ gridArea: 'add' }} className="self-end">
              {addPhotoButton}
            </div>
            <textarea
              {...textareaCommonProps}
              rows={1}
              style={{ gridArea: 'text' }}
              className="prompt-input max-h-40 min-h-9 resize-none self-center bg-transparent px-2 py-1.5 text-fg outline-none"
            />
            {/* Stays mounted even on a single line — just hidden — so
             *  toggling `isMultiline` never adds/removes this node either. */}
            <div
              style={{ gridArea: 'expand', display: isMultiline ? undefined : 'none' }}
              className="justify-self-end self-start"
            >
              {expandButton}
            </div>
            <div style={{ gridArea: 'send' }} className="self-end justify-self-end">
              {sendButton}
            </div>
          </div>
        </div>
      )}

      {/* The drawer handles its own overlay, drag-to-dismiss, and (via vaul's
       *  built-in VisualViewport tracking) keyboard avoidance — no need to
       *  hand-roll any of that here the way the old fixed-position take did. */}
      <Drawer open={expanded} onOpenChange={setExpanded}>
        <DrawerContent className="mt-0 h-[80vh] max-h-[80vh]">
          <DrawerHeader className="sr-only">
            <DrawerTitle>Prompt</DrawerTitle>
            <DrawerDescription>Write a longer prompt for Claude.</DrawerDescription>
          </DrawerHeader>

          {/* Mirrors the compact pill's expand button: a bare icon tucked
           *  into the corner, not a bordered toolbar button. */}
          <button
            type="button"
            aria-label="Collapse"
            onClick={() => setExpanded(false)}
            className="absolute top-3 right-3 z-10 grid size-9 place-items-center rounded-full text-muted"
          >
            <Minimize2 size={16} />
          </button>

          <div className="flex min-h-0 flex-1 flex-col px-4 pt-2">
            {error && <p className="mb-2 shrink-0 text-[13px] text-del">{error}</p>}
            {imagesStrip}
            <textarea
              {...textareaCommonProps}
              className="prompt-input min-h-0 flex-1 resize-none bg-transparent pr-10 pb-2 text-fg outline-none"
            />
          </div>

          {/* No border/background toolbar — the buttons float directly on
           *  the drawer body, same as the reference design. */}
          <div className="flex shrink-0 items-center justify-between px-4 pt-1 pb-[calc(12px+env(safe-area-inset-bottom,0px))]">
            {addPhotoButton}
            {sendButton}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}
