import type { ImageRef, UploadImagesResponse } from '@mce/protocol'
import type { FastifyInstance } from 'fastify'
import { isAcceptedMediaType, MAX_IMAGE_BYTES, UnknownImageError, type UploadStore } from '../uploads.ts'

/**
 * Images are stored on disk (see UploadStore), never in the durable event log
 * — POST returns ids, which ride PromptRequest.imageIds and get resolved to
 * bytes at send time in AgentSession.prompt. GET is how the client renders a
 * thumbnail, both right after upload and when a thread is reloaded later.
 */
export function registerUploads(app: FastifyInstance, uploads: UploadStore): void {
  app.post('/api/uploads/images', async (request, reply) => {
    if (!request.isMultipart()) return reply.code(400).send({ error: 'expected multipart/form-data' })

    const images: ImageRef[] = []
    try {
      for await (const part of request.files()) {
        if (!isAcceptedMediaType(part.mimetype)) {
          return reply.code(415).send({ error: `unsupported image type: ${part.mimetype}` })
        }
        const bytes = await part.toBuffer()
        images.push(uploads.save(bytes, part.mimetype))
      }
    } catch (err) {
      // Thrown by @fastify/multipart when a file exceeds `limits.fileSize`
      // (registered globally in server.ts). Statically typed as `unknown`
      // rather than importing the SDK's error class — just checking the code.
      if (isFastifyError(err) && err.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: `image exceeds the ${MAX_IMAGE_BYTES}-byte limit` })
      }
      throw err
    }

    if (images.length === 0) return reply.code(400).send({ error: 'at least one image is required' })
    return reply.code(201).send({ images } satisfies UploadImagesResponse)
  })

  app.get('/api/uploads/images/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const { mediaType, bytes } = uploads.read(id)
      // Safe to cache forever: ids are random uuids, write-once, never mutated.
      return reply.header('cache-control', 'private, max-age=31536000, immutable').type(mediaType).send(bytes)
    } catch (err) {
      if (err instanceof UnknownImageError) return reply.code(404).send({ error: 'no such image' })
      throw err
    }
  })
}

function isFastifyError(err: unknown): err is { code: string } {
  return typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string'
}
