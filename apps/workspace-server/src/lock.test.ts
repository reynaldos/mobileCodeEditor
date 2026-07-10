import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLock, LockBusyError } from './lock.ts'

const lockPath = (): string => join(mkdtempSync(join(tmpdir(), 'mce-lock-')), 'events.db.lock')

test('acquiring writes our pid and releasing removes the file', async () => {
  const path = lockPath()
  const lock = await acquireLock(path)

  assert.equal(readFileSync(path, 'utf8'), String(process.pid))
  lock.release()
  assert.equal(existsSync(path), false)
})

test('release is idempotent', async () => {
  const path = lockPath()
  const lock = await acquireLock(path)
  lock.release()
  lock.release()
  assert.equal(existsSync(path), false)
})

test('a live holder blocks a second writer — this is the node --watch race', async () => {
  const path = lockPath()
  const held = await acquireLock(path)

  // Retry quickly so the test does not take five seconds.
  await assert.rejects(() => acquireLock(path, { retries: 2, delayMs: 5 }), LockBusyError)

  held.release()
})

test('the error names the holder and tells you how to clear it', async () => {
  const path = lockPath()
  const held = await acquireLock(path)

  const err = await acquireLock(path, { retries: 0, delayMs: 1 }).catch((e: unknown) => e)
  assert.ok(err instanceof LockBusyError)
  assert.equal(err.holderPid, process.pid)
  assert.match(err.message, /single writer/)
  assert.match(err.message, new RegExp(`rm ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

  held.release()
})

test('a stale lock from a dead process is reclaimed, not fatal', async () => {
  const path = lockPath()
  // pid 2^22 + 1 is above any Linux/macOS pid_max, so it cannot be running.
  writeFileSync(path, '4194305')

  const lock = await acquireLock(path, { retries: 0, delayMs: 1 })
  assert.equal(readFileSync(path, 'utf8'), String(process.pid))
  lock.release()
})

test('a garbage lock file is reclaimed', async () => {
  const path = lockPath()
  writeFileSync(path, 'not-a-pid')

  const lock = await acquireLock(path, { retries: 0, delayMs: 1 })
  assert.equal(readFileSync(path, 'utf8'), String(process.pid))
  lock.release()
})

test('waits for a predecessor and takes the lock when it exits', async () => {
  const path = lockPath()
  const predecessor = await acquireLock(path)

  // The successor should be waiting, not failing.
  const successor = acquireLock(path, { retries: 40, delayMs: 10 })
  setTimeout(() => predecessor.release(), 40)

  const lock = await successor
  assert.equal(readFileSync(path, 'utf8'), String(process.pid))
  lock.release()
})

test('releasing does not delete a lock that now belongs to someone else', async () => {
  const path = lockPath()
  const first = await acquireLock(path)

  // Simulate a successor that grabbed it after we crashed out of the way.
  writeFileSync(path, '999999')
  first.release()

  assert.equal(existsSync(path), true, 'must not unlink the successor lock')
  assert.equal(readFileSync(path, 'utf8'), '999999')
})
