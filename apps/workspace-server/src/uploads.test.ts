import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isAcceptedMediaType, UnknownImageError, UploadStore } from './uploads.ts'

function freshStore(): { store: UploadStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'mce-uploads-'))
  return { store: new UploadStore(root), root }
}

test('save writes a file named after the id and returns a matching ref', () => {
  const { store } = freshStore()
  const bytes = Buffer.from('not really a png')
  const ref = store.save(bytes, 'image/png')

  assert.match(ref.id, /\.png$/)
  assert.equal(ref.mediaType, 'image/png')
  assert.equal(ref.size, bytes.length)

  const read = store.read(ref.id)
  assert.equal(read.mediaType, 'image/png')
  assert.deepEqual(read.bytes, bytes)
})

test('save round-trips every accepted media type through its extension', () => {
  const { store } = freshStore()
  for (const mediaType of ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const) {
    const ref = store.save(Buffer.from('x'), mediaType)
    assert.equal(store.read(ref.id).mediaType, mediaType)
  }
})

test('pathOf refuses to escape the root', () => {
  const { store, root } = freshStore()
  assert.equal(store.pathOf('ok.png'), join(root, 'ok.png'))
  assert.equal(store.pathOf('../evil.png'), undefined)
  assert.equal(store.pathOf('a/b.png'), undefined)
  assert.equal(store.pathOf('..'), undefined)
  assert.equal(store.pathOf('.'), undefined)
})

test('pathOf refuses an unrecognized extension', () => {
  const { store } = freshStore()
  assert.equal(store.pathOf('evil.exe'), undefined)
  assert.equal(store.pathOf('no-extension'), undefined)
})

test('read throws UnknownImageError for a missing or bogus id', () => {
  const { store } = freshStore()
  assert.throws(() => store.read('ghost.png'), UnknownImageError)
  assert.throws(() => store.read('../evil.png'), UnknownImageError)
  assert.throws(() => store.read('evil.exe'), UnknownImageError)
})

test('isAcceptedMediaType accepts the four Claude-supported formats and rejects others', () => {
  assert.equal(isAcceptedMediaType('image/jpeg'), true)
  assert.equal(isAcceptedMediaType('image/png'), true)
  assert.equal(isAcceptedMediaType('image/webp'), true)
  assert.equal(isAcceptedMediaType('image/gif'), true)
  assert.equal(isAcceptedMediaType('application/pdf'), false)
  assert.equal(isAcceptedMediaType('image/svg+xml'), false)
})

test('sweepOrphans keeps referenced files and recent unreferenced ones, removes old unreferenced ones', () => {
  const { store, root } = freshStore()
  const referenced = store.save(Buffer.from('kept, referenced'), 'image/png')
  const recentOrphan = store.save(Buffer.from('kept, too new to sweep'), 'image/png')
  const oldOrphan = store.save(Buffer.from('removed, old and unreferenced'), 'image/png')

  // Backdate the "old" orphan past the grace window; leave the recent one alone.
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(join(root, oldOrphan.id), old, old)

  const { removed } = store.sweepOrphans(new Set([referenced.id]), 60 * 60 * 1000)

  assert.equal(removed, 1)
  assert.doesNotThrow(() => store.read(referenced.id), 'referenced file survives')
  assert.doesNotThrow(() => store.read(recentOrphan.id), 'recent orphan survives the grace window')
  assert.throws(() => store.read(oldOrphan.id), UnknownImageError, 'old orphan is swept')
})

test('sweepOrphans ignores non-image files that happen to live in the same directory', () => {
  const { store, root } = freshStore()
  writeFileSync(join(root, 'README.txt'), 'not an image')
  const { removed } = store.sweepOrphans(new Set())
  assert.equal(removed, 0)
})
