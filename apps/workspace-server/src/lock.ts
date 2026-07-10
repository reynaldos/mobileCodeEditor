import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * One writer. The whole log design assumes it — a global monotonic `seq`, boot
 * recovery that closes "interrupted" sessions, `pendingApprovals()` meaning
 * "promises this process lost". Two processes on one log breaks all three.
 *
 * It is not hypothetical. `node --watch` spawns the replacement before the old
 * process has finished dying, and the newcomer's boot recovery cheerfully
 * expires approvals that are still live in the old one. We saw exactly that:
 * an approval_expired and a contradictory approval_decision for the same id,
 * and one session ended twice.
 *
 * SQLite's WAL keeps the file intact through this. It does not keep the
 * meaning intact.
 */

export interface Lock {
  release(): void
}

export interface LockOptions {
  /** How long to wait for a dying predecessor to let go. */
  retries?: number
  delayMs?: number
}

export class LockBusyError extends Error {
  // Assigned in the body, not as constructor parameter properties — Node's
  // type-stripping is strip-only and cannot synthesize those.
  readonly path: string
  readonly holderPid: number

  constructor(path: string, holderPid: number) {
    super(
      `Another workspace server (pid ${holderPid}) already holds ${path}.\n` +
        'The event log takes a single writer. Stop the other process, or if it is gone,\n' +
        `remove the stale lock: rm ${path}`,
    )
    this.name = 'LockBusyError'
    this.path = path
    this.holderPid = holderPid
  }
}

export async function acquireLock(path: string, options: LockOptions = {}): Promise<Lock> {
  const retries = options.retries ?? 40
  const delayMs = options.delayMs ?? 125

  mkdirSync(dirname(path), { recursive: true })

  for (let attempt = 0; ; attempt++) {
    const lock = tryAcquire(path)
    if (lock) return lock

    const holder = readHolder(path)

    // The holder is gone but its lock file survived — a SIGKILL, or a crash.
    // Reclaim it immediately rather than making the user delete a file.
    if (holder === undefined || !isAlive(holder)) {
      try {
        unlinkSync(path)
      } catch {
        /* someone else reclaimed it first; loop and retry */
      }
      continue
    }

    if (attempt >= retries) throw new LockBusyError(path, holder)
    await sleep(delayMs)
  }
}

function tryAcquire(path: string): Lock | undefined {
  let fd: number
  try {
    // 'wx' fails with EEXIST rather than truncating. That is the whole trick.
    fd = openSync(path, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw err
  }

  writeSync(fd, String(process.pid))
  closeSync(fd)

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    // Only remove it if it is still ours — never delete a successor's lock.
    if (readHolder(path) !== process.pid) return
    try {
      unlinkSync(path)
    } catch {
      /* already gone */
    }
  }

  process.once('exit', release)
  return { release }
}

function readHolder(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists and belongs to someone else. Still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
