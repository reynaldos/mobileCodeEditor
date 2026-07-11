import { Camera, Image as ImageIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { sendPrompt, uploadImages } from '../api.ts'

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
  const ready = Boolean(projectId && threadId && !disabledReason)

  const cameraRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)

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
      // The `user_prompt` event comes back over SSE and renders itself.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    // `prompt-bar` is targeted by a :has() rule that drops the safe-area padding
    // once the keyboard has lifted the app. See styles.css.
    <div className="prompt-bar shrink-0 border-t border-line bg-panel px-3 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))]">
      {error && <p className="mb-2 text-[13px] text-del">{error}</p>}

      {images.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto">
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
      )}

      <div className="flex items-end gap-2">
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            handleFiles([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
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
        <button
          type="button"
          aria-label="Take a photo"
          disabled={!ready}
          onClick={() => cameraRef.current?.click()}
          className="grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-muted disabled:opacity-50"
        >
          <Camera size={18} />
        </button>
        <button
          type="button"
          aria-label="Add a photo"
          disabled={!ready}
          onClick={() => libraryRef.current?.click()}
          className="grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-muted disabled:opacity-50"
        >
          <ImageIcon size={18} />
        </button>
        <textarea
          className="prompt-input max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-line bg-panel-2 px-3 py-2.5 text-fg outline-none focus:border-accent"
          value={text}
          rows={1}
          disabled={!ready}
          placeholder={ready ? 'What should Claude do?' : (disabledReason ?? 'Pick a project and thread')}
          // Enter inserts a newline on a phone keyboard. Sending is a button.
          onChange={(e) => setText(e.target.value)}
          onInput={(e) => {
            const el = e.currentTarget
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`
          }}
          onPaste={(e) => {
            // Does NOT preventDefault — a plain text paste must still work.
            const files = [...e.clipboardData.items]
              .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
              .map((it) => it.getAsFile())
              .filter((f): f is File => f !== null)
            if (files.length > 0) handleFiles(files)
          }}
        />
        <button
          className="min-h-11 w-18 shrink-0 rounded-xl border border-accent bg-accent font-semibold text-[#06101f] disabled:opacity-50"
          disabled={sending || (!text.trim() && images.length === 0) || !ready || uploading}
          onClick={() => void submit()}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
