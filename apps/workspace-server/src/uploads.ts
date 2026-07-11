import type { ImageMediaType, ImageRef } from '@mce/protocol'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

/** Per-image cap. Phone camera JPEGs routinely run 5-15MB; no client-side
 *  compression is done, so the cap has to be generous enough for those. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024

/** Per prompt / per upload request. */
export const MAX_IMAGES_PER_UPLOAD = 6

const EXTENSION_OF: Record<ImageMediaType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

const MEDIA_TYPE_OF_EXTENSION: Record<string, ImageMediaType> = Object.fromEntries(
  Object.entries(EXTENSION_OF).map(([mediaType, ext]) => [ext, mediaType as ImageMediaType]),
)

export function isAcceptedMediaType(mt: string): mt is ImageMediaType {
  return mt in EXTENSION_OF
}

export class UnknownImageError extends Error {
  readonly id: string
  constructor(id: string) {
    super(`no such image: ${id}`)
    this.name = 'UnknownImageError'
    this.id = id
  }
}

/**
 * Uploaded images, stored on disk under `root`. Same idiom as ProjectStore:
 * the filesystem is the source of truth for what exists. The id IS the
 * filename (`<uuid>.<ext>`) — media type is recovered from the extension, so
 * there is no separate manifest that could drift from disk. See DECISIONS #5.
 *
 * Bytes never enter the event log; only the lightweight `ImageRef` does. See
 * AgentSession.prompt, which reads a file's bytes at send time.
 */
export class UploadStore {
  readonly #root: string

  constructor(root: string) {
    this.#root = resolve(root)
    mkdirSync(this.#root, { recursive: true })
  }

  /** Persist bytes; returns the new ref. Caller has already checked size/type. */
  save(bytes: Buffer, mediaType: ImageMediaType): ImageRef {
    const id = `${randomUUID()}${EXTENSION_OF[mediaType]}`
    const path = this.pathOf(id)
    if (!path) throw new Error(`generated an invalid id: ${id}`) // unreachable — a fresh uuid always passes the guard
    writeFileSync(path, bytes)
    return { id, mediaType, size: bytes.length }
  }

  /**
   * Absolute path for an id, or undefined if it would escape the root or has
   * an unrecognized extension. The guard is load-bearing: `id` comes from a
   * request, and `../` must never resolve outside `root`. Mirrors
   * ProjectStore.pathOf.
   */
  pathOf(id: string): string | undefined {
    const path = resolve(this.#root, id)
    if (path !== this.#root && !path.startsWith(this.#root + '/')) return undefined
    if (basename(path) !== id) return undefined // rejects `.`, `..`, nested paths
    if (!(extname(id) in MEDIA_TYPE_OF_EXTENSION)) return undefined
    return path
  }

  /** Read bytes + validate in one call. Throws UnknownImageError for a bad/missing id. */
  read(id: string): { mediaType: ImageMediaType; bytes: Buffer } {
    const path = this.pathOf(id)
    const mediaType = path ? MEDIA_TYPE_OF_EXTENSION[extname(id)] : undefined
    if (!path || !mediaType || !existsSync(path)) throw new UnknownImageError(id)
    return { mediaType, bytes: readFileSync(path) }
  }

  /**
   * Boot-time cleanup: an upload whose prompt was never sent (or whose
   * session died before `user_prompt` fired) has zero long-term value and
   * would otherwise accumulate forever on a capacity-constrained volume.
   *
   * `graceMs` protects an image still sitting in an in-progress compose box —
   * uploaded but not yet referenced by any event — from being deleted out
   * from under the user. Best-effort: a file that vanishes mid-sweep (e.g. a
   * concurrent request) is not an error.
   */
  sweepOrphans(referencedIds: ReadonlySet<string>, graceMs = 24 * 60 * 60 * 1000): { removed: number } {
    const cutoff = Date.now() - graceMs
    let removed = 0
    for (const name of readdirSync(this.#root)) {
      if (referencedIds.has(name)) continue
      const path = this.pathOf(name)
      if (!path) continue // not a file this store recognizes as an image
      try {
        if (statSync(path).mtimeMs > cutoff) continue // too recent — still might be an in-progress compose
        unlinkSync(path)
        removed++
      } catch {
        /* best effort */
      }
    }
    return { removed }
  }
}
