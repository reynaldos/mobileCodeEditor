import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { openDb } from './db.ts'
import { EventLog } from './log.ts'
import type { Github } from './github.ts'
import { CreateError, detectDevCommand, ProjectStore, sanitizeProjectName } from './projects.ts'
import { makeRedactor } from './redact.ts'

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'mce-devcmd-'))
}

function writePackageJson(dir: string, body: object): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(body))
}

function freshStore(): { store: ProjectStore; log: EventLog; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'mce-store-'))
  const log = new EventLog(openDb(':memory:'), makeRedactor([]))
  return { store: new ProjectStore(root, log), log, root }
}

function gitInit(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(dir)
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
}

test('list scans directories and reads git branch', () => {
  const { store, root } = freshStore()
  gitInit(root, 'alpha')
  gitInit(root, 'beta')

  const ids = store.list().map((p) => p.id).sort()
  assert.deepEqual(ids, ['alpha', 'beta'])
  assert.equal(store.list().find((p) => p.id === 'alpha')?.branch, 'main')
})

test('a plain (non-git) directory is still a project', () => {
  const { store, root } = freshStore()
  mkdirSync(join(root, 'plain'))
  assert.deepEqual(store.list().map((p) => p.id), ['plain'])
  assert.equal(store.list()[0]?.branch, undefined)
})

test('pathOf refuses to escape the root', () => {
  const { store, root } = freshStore()
  assert.equal(store.pathOf('ok'), join(root, 'ok'))
  assert.equal(store.pathOf('../evil'), undefined)
  assert.equal(store.pathOf('a/b'), undefined)
  assert.equal(store.pathOf('..'), undefined)
  assert.equal(store.pathOf('.'), undefined)
})

test('create-from-scratch inits a git repo and emits project_created', async () => {
  const { store, root, log } = freshStore()
  const { projectId } = store.create({ name: 'my-idea' })
  assert.equal(projectId, 'my-idea')

  await waitFor(() => log.projectCreations().some((e) => e.name === 'my-idea'), 'project_created')
  assert.ok(existsSync(join(root, 'my-idea', '.git')), 'a git repo')
  assert.equal(store.list().find((p) => p.id === 'my-idea')?.branch, 'main')
})

test('a name is sanitized to a safe directory id', () => {
  const { store } = freshStore()
  assert.equal(store.create({ name: '../../etc/passwd' }).projectId, 'etc-passwd')
  assert.equal(store.create({ name: 'My Cool Repo!' }).projectId, 'My-Cool-Repo')
})

test('a clone from a bad URL fails and cleans up — no half-directory left behind', async () => {
  const { store, root, log } = freshStore()
  // A URL that will never resolve. git clone fails; the dir must not persist.
  const { projectId } = store.create({ repoUrl: 'https://example.invalid/nope.git' })
  assert.equal(projectId, 'nope')

  await waitFor(
    () => log.replaySince(0).some((e) => e.type === 'project_create_failed' && e.name === 'nope'),
    'project_create_failed',
    30_000,
  )
  assert.equal(existsSync(join(root, 'nope')), false, 'the failed clone dir was removed')
})

test('creating a name that already exists is a CreateError', () => {
  const { store, root } = freshStore()
  gitInit(root, 'taken')
  assert.throws(() => store.create({ name: 'taken' }), CreateError)
})

test('create with neither name nor repoUrl is a CreateError', () => {
  const { store } = freshStore()
  assert.throws(() => store.create({}), CreateError)
})

test('create with visibility but no github configured is a CreateError', () => {
  const { store } = freshStore()
  assert.throws(() => store.create({ name: 'x', visibility: 'private' }), CreateError)
})

test('sanitizeProjectName strips path separators and trims', () => {
  assert.equal(sanitizeProjectName('../../etc/passwd'), 'etc-passwd')
  assert.equal(sanitizeProjectName('My Cool Repo!'), 'My-Cool-Repo')
  assert.equal(sanitizeProjectName('repo.git'), 'repo')
  assert.equal(sanitizeProjectName('  ...  '), '')
})

test('create-on-github creates the repo then clones it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mce-store-'))
  const log = new EventLog(openDb(':memory:'), makeRedactor([]))

  // A local bare repo stands in for the GitHub remote; a real `git clone` runs.
  const origin = join(mkdtempSync(join(tmpdir(), 'mce-origin-')), 'origin.git')
  execFileSync('git', ['init', '--bare', '-q', origin])

  let created: { name: string; vis: string } | undefined
  const fakeGithub = {
    createRepo: async (name: string, vis: string) => {
      created = { name, vis }
      return `file://${origin}`
    },
  } as unknown as Github

  const store = new ProjectStore(root, log, fakeGithub)
  const { projectId } = store.create({ name: 'made-remote', visibility: 'private' })
  assert.equal(projectId, 'made-remote')

  await waitFor(() => log.projectCreations().some((e) => e.name === 'made-remote'), 'project_created')
  assert.deepEqual(created, { name: 'made-remote', vis: 'private' })
  assert.ok(existsSync(join(root, 'made-remote', '.git')), 'cloned the created repo')
})

async function waitFor(predicate: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await sleep(20)
  }
}

// --- detectDevCommand (Phase 5) ---------------------------------------------

test('detectDevCommand picks the package manager from the lockfile, for a Vite project', () => {
  const dir = fixtureDir()
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
  writePackageJson(dir, { scripts: { dev: 'vite' } })
  assert.deepEqual(detectDevCommand(dir), { cmd: 'pnpm', args: ['run', 'dev'], framework: 'vite' })
})

test('detectDevCommand recognizes yarn and bun lockfiles too', () => {
  const yarnDir = fixtureDir()
  writeFileSync(join(yarnDir, 'vite.config.js'), 'export default {}')
  writeFileSync(join(yarnDir, 'yarn.lock'), '')
  writePackageJson(yarnDir, { scripts: { dev: 'vite' } })
  assert.deepEqual(detectDevCommand(yarnDir), { cmd: 'yarn', args: ['dev'], framework: 'vite' })

  const bunDir = fixtureDir()
  writeFileSync(join(bunDir, 'vite.config.mjs'), 'export default {}')
  writeFileSync(join(bunDir, 'bun.lock'), '')
  writePackageJson(bunDir, { scripts: { dev: 'vite' } })
  assert.deepEqual(detectDevCommand(bunDir), { cmd: 'bun', args: ['run', 'dev'], framework: 'vite' })
})

test('detectDevCommand falls back to npm with no lockfile at all', () => {
  const dir = fixtureDir()
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}')
  writePackageJson(dir, { scripts: { dev: 'vite' } })
  assert.deepEqual(detectDevCommand(dir), { cmd: 'npm', args: ['run', 'dev'], framework: 'vite' })
})

test('detectDevCommand recognizes Vite via a devDependency, with no vite.config file present', () => {
  const dir = fixtureDir()
  writePackageJson(dir, { scripts: { dev: 'vite' }, devDependencies: { vite: '^6.0.0' } })
  assert.deepEqual(detectDevCommand(dir), { cmd: 'npm', args: ['run', 'dev'], framework: 'vite' })
})

test('detectDevCommand is undefined with no "dev" script, even for a real Vite project', () => {
  const dir = fixtureDir()
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}')
  writePackageJson(dir, { scripts: { build: 'vite build' } })
  assert.equal(detectDevCommand(dir), undefined)
})

test('detectDevCommand is undefined for a non-Vite project — v1 scope, per PHASE-5.md', () => {
  const dir = fixtureDir()
  writePackageJson(dir, { scripts: { dev: 'webpack serve' }, devDependencies: { webpack: '^5.0.0' } })
  assert.equal(detectDevCommand(dir), undefined)
})

test('detectDevCommand is undefined with no package.json at all', () => {
  const dir = fixtureDir()
  assert.equal(detectDevCommand(dir), undefined)
})
