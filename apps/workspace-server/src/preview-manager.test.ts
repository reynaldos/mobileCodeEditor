import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Config } from './config.ts'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import { Presence } from './presence.ts'
import { PreviewConflictError, PreviewManager, PreviewUnsupportedError, type SpawnFn } from './preview-manager.ts'
import { PreviewTracker } from './preview-tracker.ts'
import { ProjectStore } from './projects.ts'
import { makeRedactor } from './redact.ts'

/**
 * These spawn a REAL child process (like `projects.test.ts` spawns a real
 * `git`) — but never a real Vite/Next/react-scripts binary. Two separate
 * concerns, deliberately kept apart:
 *
 * - Whether the HMR-through-proxy trick actually works was answered by hand
 *   for PHASE-5.md's spike, against a real Vite dev server. Nothing here
 *   needs to re-prove that.
 * - What's under test here is `PreviewManager`'s own orchestration — spawn,
 *   port-poll readiness, conflict/idle/crash lifecycle, and (this matters)
 *   whether stopping it actually kills the real process. A first attempt at
 *   this suite routed through the real detected command (`npm run dev`) and
 *   was outright flaky: npm's own startup overhead varies wildly under
 *   parallel test-suite CPU contention, and a `SIGTERM` to the direct `npm`
 *   child routinely left its grandchild (the actual dev server) running —
 *   which is *why* `PreviewManager` kills the whole process group, not just
 *   `child`. `spawnFn` (mirrors `QueryFn` for the Claude SDK in session.ts)
 *   substitutes a direct, fast `node server.js`, so these tests are exercising
 *   the same detached-process-group spawn/kill path, just without a real
 *   framework binary's startup overhead riding along for no reason.
 */

/** Ignores whatever binary path PreviewManager resolved; runs the fixture's server.js directly with the exact args/env PreviewManager built for it. */
const fakeSpawn: SpawnFn = (_cmd, args, opts) => spawn('node', ['server.js', ...args], opts)

// Spread out across tests (so a slow-to-die child from a prior test in this
// run can't collide) and randomized per process (so a leftover from a prior
// *run* — e.g. a hard-killed test process — doesn't collide either).
let nextPort = 34000 + (process.pid % 20000)

function freshFixture(): { root: string; log: EventLog; projects: ProjectStore; presence: Presence; port: number } {
  const root = mkdtempSync(join(tmpdir(), 'mce-preview-'))
  const log = new EventLog(openDb(':memory:'), makeRedactor([]))
  const projects = new ProjectStore(root, log)
  const presence = new Presence()
  return { root, log, projects, presence, port: nextPort++ }
}

/** A project directory `detectDevCommand` recognizes as Vite, whose "dev server" is a plain HTTP listener. */
function makePreviewableProject(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }))
  writeFileSync(
    join(dir, 'server.js'),
    `const http = require('node:http')
     const argv = process.argv.slice(2)
     let port = 0
     for (let i = 0; i < argv.length; i++) if (argv[i] === '--port') port = Number(argv[i + 1])
     http.createServer((_req, res) => res.end('ok')).listen(port)`,
  )
}

/** A project directory `detectDevCommand` recognizes as Next.js (Phase 6) — same fake HTTP listener, parses `-p` instead of `--port`/`--host`. */
function makeNextPreviewableProject(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'next.config.js'), 'module.exports = {}')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }))
  writeFileSync(
    join(dir, 'server.js'),
    `const http = require('node:http')
     const argv = process.argv.slice(2)
     let port = 0
     for (let i = 0; i < argv.length; i++) if (argv[i] === '-p') port = Number(argv[i + 1])
     http.createServer((_req, res) => res.end('ok')).listen(port)`,
  )
}

/** A pnpm-monorepo root whose Vite app lives in `apps/web` — `detectDevCommand` should find it a level down. */
function makeMonorepoPreviewableProject(root: string, name: string): string {
  const projectDir = join(root, name)
  mkdirSync(projectDir)
  writeFileSync(join(projectDir, 'pnpm-lock.yaml'), '')
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ scripts: { dev: 'pnpm --filter web dev' } }))
  const webDir = join(projectDir, 'apps', 'web')
  mkdirSync(webDir, { recursive: true })
  writeFileSync(join(webDir, 'vite.config.ts'), 'export default {}')
  writeFileSync(join(webDir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }))
  writeFileSync(
    join(webDir, 'server.js'),
    `const http = require('node:http')
     const argv = process.argv.slice(2)
     let port = 0
     for (let i = 0; i < argv.length; i++) if (argv[i] === '--port') port = Number(argv[i + 1])
     http.createServer((_req, res) => res.end('ok')).listen(port)`,
  )
  return webDir
}

/** A project directory `detectDevCommand` recognizes as Create React App — port comes via the `PORT` env var, not a CLI flag, since react-scripts takes no such flag. */
function makeCraPreviewableProject(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { start: 'node server.js' }, dependencies: { 'react-scripts': '5.0.1' } }),
  )
  writeFileSync(
    join(dir, 'server.js'),
    `const http = require('node:http')
     const port = Number(process.env.PORT) || 0
     http.createServer((_req, res) => res.end('ok')).listen(port)`,
  )
}

/** A project directory with no dev command at all — the unsupported case. */
function makeUnsupportedProject(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }))
}

function config(port: number, idleTimeoutMs = 30 * 60 * 1000): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    projectPath: tmpdir(),
    projectId: 'test',
    projectsRoot: tmpdir(),
    uploadsRoot: tmpdir(),
    claudeToken: undefined,
    model: undefined,
    isDev: true,
    webDist: '/nonexistent',
    vapid: undefined,
    previewPort: port,
    previewOriginPort: 0,
    previewIdleTimeoutMs: idleTimeoutMs,
  }
}

async function waitFor(predicate: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await sleep(20)
  }
}

test('start spawns the detected dev command, polls the port, and reaches running', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makePreviewableProject(root, 'demo')
  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port), { readyPollMs: 20, spawnFn: fakeSpawn })

  await manager.start('demo')
  await waitFor(() => tracker.snapshot('demo')?.phase === 'running', 'preview running')

  assert.equal(tracker.activeProjectId(), 'demo')
  assert.ok(log.replaySince(0).some((e) => e.type === 'preview_started' && e.projectId === 'demo'))

  await manager.stop('demo', 'closed')
})

test('start spawns a Next.js dev command with -p/-H instead of Vite\'s --port/--host, and tracks its framework', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makeNextPreviewableProject(root, 'demo-next')
  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port), { readyPollMs: 20, spawnFn: fakeSpawn })

  await manager.start('demo-next')
  await waitFor(() => tracker.snapshot('demo-next')?.phase === 'running', 'preview running')

  assert.equal(tracker.activeProjectId(), 'demo-next')
  assert.equal(tracker.activeFramework(), 'next')

  await manager.stop('demo-next', 'closed')
})

test('start spawns a Create React App dev command via PORT/HOST/BROWSER env vars instead of CLI flags, and tracks its framework', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makeCraPreviewableProject(root, 'demo-cra')
  const tracker = new PreviewTracker()
  let seenEnv: NodeJS.ProcessEnv | undefined
  const spyingSpawn: SpawnFn = (cmd, args, opts) => {
    seenEnv = opts.env
    return fakeSpawn(cmd, args, opts)
  }
  const manager = new PreviewManager(log, tracker, projects, presence, config(port), { readyPollMs: 20, spawnFn: spyingSpawn })

  await manager.start('demo-cra')
  await waitFor(() => tracker.snapshot('demo-cra')?.phase === 'running', 'preview running')

  assert.equal(tracker.activeProjectId(), 'demo-cra')
  assert.equal(tracker.activeFramework(), 'cra')
  assert.equal(seenEnv?.PORT, String(port))
  assert.equal(seenEnv?.HOST, '0.0.0.0')
  assert.equal(seenEnv?.BROWSER, 'none')

  await manager.stop('demo-cra', 'closed')
})

test('start spawns the framework binary directly out of node_modules/.bin, not a package-manager wrapper (regression: pnpm forwards a literal "--" that next/vite misparse as a positional arg)', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makePreviewableProject(root, 'demo-bin')
  writeFileSync(join(root, 'demo-bin', 'pnpm-lock.yaml'), '') // package manager choice must not affect what gets spawned
  const binDir = join(root, 'demo-bin', 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const tracker = new PreviewTracker()
  const cmds: string[] = []
  const spyingSpawn: SpawnFn = (cmd, args, opts) => {
    cmds.push(cmd)
    return fakeSpawn(cmd, args, opts)
  }
  const manager = new PreviewManager(log, tracker, projects, presence, config(port), { readyPollMs: 20, spawnFn: spyingSpawn })

  await manager.start('demo-bin')
  await waitFor(() => tracker.snapshot('demo-bin')?.phase === 'running', 'preview running')

  assert.deepEqual(cmds, [join(binDir, 'vite')])

  await manager.stop('demo-bin', 'closed')
})

test('start finds and spawns a Vite app nested in a monorepo\'s apps/*, from that subdirectory', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  const webDir = makeMonorepoPreviewableProject(root, 'demo-mono')
  const tracker = new PreviewTracker()
  const cwds: string[] = []
  const spyingSpawn: SpawnFn = (cmd, args, opts) => {
    cwds.push(opts.cwd)
    return fakeSpawn(cmd, args, opts)
  }
  const manager = new PreviewManager(log, tracker, projects, presence, config(port), {
    readyPollMs: 20,
    spawnFn: spyingSpawn,
  })

  await manager.start('demo-mono')
  await waitFor(() => tracker.snapshot('demo-mono')?.phase === 'running', 'preview running')

  assert.deepEqual(cwds, [webDir])

  await manager.stop('demo-mono', 'closed')
})

test('start spawns the dev command with NODE_ENV overridden to development, regardless of the parent process\'s NODE_ENV', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makePreviewableProject(root, 'demo-env')
  const tracker = new PreviewTracker()
  let seenEnv: NodeJS.ProcessEnv | undefined
  const spyingSpawn: SpawnFn = (cmd, args, opts) => {
    seenEnv = opts.env
    return fakeSpawn(cmd, args, opts)
  }
  const manager = new PreviewManager(log, tracker, projects, presence, config(port), {
    readyPollMs: 20,
    spawnFn: spyingSpawn,
  })

  await manager.start('demo-env')
  await waitFor(() => tracker.snapshot('demo-env')?.phase === 'running', 'preview running')

  // Whatever the workspace-server's own NODE_ENV is (production, in the real
  // Dockerfile), the spawned dev server must see 'development' — see the
  // comment at the spawn call in preview-manager.ts for why.
  assert.equal(seenEnv?.NODE_ENV, 'development')

  await manager.stop('demo-env', 'closed')
})

test('starting a second project without force throws PreviewConflictError and leaves the first alone', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makePreviewableProject(root, 'first')
  makePreviewableProject(root, 'second')
  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port), { readyPollMs: 20, spawnFn: fakeSpawn })

  await manager.start('first')
  await waitFor(() => tracker.snapshot('first')?.phase === 'running', 'first running')

  await assert.rejects(manager.start('second'), (err: unknown) => {
    assert.ok(err instanceof PreviewConflictError)
    assert.equal(err.activeProjectId, 'first')
    return true
  })
  assert.equal(tracker.activeProjectId(), 'first')

  await manager.stop('first', 'closed')
})

test('start with force stops the previous preview and starts the new one', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makePreviewableProject(root, 'first')
  makePreviewableProject(root, 'second')
  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port), { readyPollMs: 20, spawnFn: fakeSpawn })

  await manager.start('first')
  await waitFor(() => tracker.snapshot('first')?.phase === 'running', 'first running')

  await manager.start('second', { force: true })
  await waitFor(() => tracker.snapshot('second')?.phase === 'running', 'second running')

  assert.equal(tracker.activeProjectId(), 'second')
  const types = log.replaySince(0).map((e) => [e.type, e.projectId])
  assert.deepEqual(
    types.filter(([t]) => t === 'preview_started' || t === 'preview_stopped'),
    [
      ['preview_started', 'first'],
      ['preview_stopped', 'first'],
      ['preview_started', 'second'],
    ],
  )

  await manager.stop('second', 'closed')
})

test('start throws PreviewUnsupportedError for an unknown project', async () => {
  const { log, projects, presence, port } = freshFixture()
  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port))
  await assert.rejects(manager.start('does-not-exist'), PreviewUnsupportedError)
})

test('start throws PreviewUnsupportedError when no dev command is detected', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makeUnsupportedProject(root, 'not-vite')
  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port))
  await assert.rejects(manager.start('not-vite'), PreviewUnsupportedError)
  assert.equal(tracker.activeProjectId(), undefined)
})

test('stop() is a harmless no-op for a project that is not the active one', async () => {
  const { log, projects, presence, port } = freshFixture()
  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port))
  await manager.stop('nobody-started-this', 'closed') // must not throw
  assert.equal(log.replaySince(0).length, 0)
})

test('recoverOnBoot closes out a preview left running by a dead process', async () => {
  const { log, projects, presence, port } = freshFixture()
  // Simulate the previous process dying mid-preview: a started event with no terminal event.
  log.append({ sessionId: 'system', projectId: 'orphan', ts: Date.now(), type: 'preview_started' })
  assert.deepEqual(log.activePreview(), { projectId: 'orphan' })

  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port))
  manager.recoverOnBoot()

  assert.equal(log.activePreview(), undefined)
  const last = log.replaySince(0).at(-1)
  assert.equal(last?.type, 'preview_stopped')
  assert.equal(last && 'reason' in last ? last.reason : undefined, 'restarted')
})

test('idle-timeout auto-stops the preview once every device stays backgrounded past the timeout', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makePreviewableProject(root, 'demo')
  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port, 60), {
    readyPollMs: 20,
    idlePollMs: 20,
    spawnFn: fakeSpawn,
  })

  presence.set('device-1', true) // starts visible — no immediate idle risk
  await manager.start('demo')
  await waitFor(() => tracker.snapshot('demo')?.phase === 'running', 'running')

  presence.clear('device-1') // now nobody is looking
  await waitFor(() => tracker.snapshot('demo')?.phase === 'stopped', 'idle-stopped', 2000)

  const stopped = log.replaySince(0).find((e) => e.type === 'preview_stopped')
  assert.equal(stopped && 'reason' in stopped ? stopped.reason : undefined, 'idle-timeout')
})

test('idle-timeout is cancelled if a device looks again before the timeout fires', async () => {
  const { root, log, projects, presence, port } = freshFixture()
  makePreviewableProject(root, 'demo')
  const tracker = new PreviewTracker()
  const manager = new PreviewManager(log, tracker, projects, presence, config(port, 200), {
    readyPollMs: 20,
    idlePollMs: 20,
    spawnFn: fakeSpawn,
  })

  presence.set('device-1', true)
  await manager.start('demo')
  await waitFor(() => tracker.snapshot('demo')?.phase === 'running', 'running')

  presence.clear('device-1')
  await sleep(60) // idle noticed, but well under the 200ms timeout
  presence.set('device-1', true) // looked again — should cancel the timer

  await sleep(300) // past what the original timeout would have been
  assert.equal(tracker.activeProjectId(), 'demo')
  assert.ok(!log.replaySince(0).some((e) => e.type === 'preview_stopped'))

  await manager.stop('demo', 'closed')
})
