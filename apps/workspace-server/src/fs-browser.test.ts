import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listDir, readTextFile, resolveSafe, searchFiles } from './fs-browser.ts'

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'mce-fsbrowser-'))
}

// --- resolveSafe: the path guard everything else depends on -----------------

test('resolveSafe resolves a plain relative path under the root', () => {
  const root = fixture()
  assert.equal(resolveSafe(root, 'src/index.ts'), join(root, 'src/index.ts'))
})

test('resolveSafe resolves the empty path to the root itself', () => {
  const root = fixture()
  assert.equal(resolveSafe(root, ''), root)
})

test('resolveSafe rejects a path that climbs out of the root', () => {
  const root = fixture()
  assert.equal(resolveSafe(root, '../../etc/passwd'), undefined)
  assert.equal(resolveSafe(root, 'a/../../b'), undefined)
})

test('resolveSafe treats a leading slash as root-relative, not filesystem-absolute', () => {
  // A client-supplied "/etc/passwd" is not honored as an absolute path — the
  // leading slash is stripped, so it resolves to `<root>/etc/passwd`, safely
  // inside the project, rather than needing a separate rejection path.
  const root = fixture()
  assert.equal(resolveSafe(root, '/etc/passwd'), join(root, 'etc/passwd'))
})

test('resolveSafe rejects a sibling directory that merely shares the root as a string prefix', () => {
  // e.g. root "/data/projects/app" vs a sibling "/data/projects/app-evil" — the
  // naive `startsWith(root)` check (without the trailing slash) would wrongly
  // let this through.
  const parent = fixture()
  const root = join(parent, 'app')
  mkdirSync(root)
  mkdirSync(join(parent, 'app-evil'))
  assert.equal(resolveSafe(root, '../app-evil/secret.txt'), undefined)
})

// --- listDir ------------------------------------------------------------

test('listDir sorts folders before files, both alphabetical', () => {
  const root = fixture()
  writeFileSync(join(root, 'b.ts'), '')
  writeFileSync(join(root, 'a.ts'), '')
  mkdirSync(join(root, 'zdir'))
  mkdirSync(join(root, 'adir'))

  const listing = listDir(root, '')!
  assert.deepEqual(
    listing.entries.map((e) => e.name),
    ['adir', 'zdir', 'a.ts', 'b.ts'],
  )
  assert.equal(listing.truncated, false)
})

test('listDir includes dotfiles, matching a VS Code-style explorer', () => {
  const root = fixture()
  writeFileSync(join(root, '.gitignore'), '')
  const listing = listDir(root, '')!
  assert.ok(listing.entries.some((e) => e.name === '.gitignore'))
})

test('listDir returns child paths prefixed by the parent, one level only', () => {
  const root = fixture()
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'src', 'nested'))
  writeFileSync(join(root, 'src', 'index.ts'), '')

  const listing = listDir(root, 'src')!
  assert.deepEqual(
    listing.entries.map((e) => e.path).sort(),
    ['src/index.ts', 'src/nested'],
  )
})

test('listDir returns undefined for a directory outside the root', () => {
  const root = fixture()
  assert.equal(listDir(root, '../../etc'), undefined)
})

test('listDir returns undefined for a path that does not exist', () => {
  const root = fixture()
  assert.equal(listDir(root, 'nope'), undefined)
})

// --- readTextFile ---------------------------------------------------------

test('readTextFile returns the file contents', () => {
  const root = fixture()
  writeFileSync(join(root, 'hello.txt'), 'hi there')
  assert.equal(readTextFile(root, 'hello.txt'), 'hi there')
})

test('readTextFile returns undefined for a directory', () => {
  const root = fixture()
  mkdirSync(join(root, 'adir'))
  assert.equal(readTextFile(root, 'adir'), undefined)
})

test('readTextFile returns undefined for a path outside the root', () => {
  const root = fixture()
  assert.equal(readTextFile(root, '../../etc/passwd'), undefined)
})

test('readTextFile returns undefined for a file that looks binary', () => {
  const root = fixture()
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
  assert.equal(readTextFile(root, 'blob.bin'), undefined)
})

test('readTextFile follows a symlink but still resolves inside the root', () => {
  const root = fixture()
  writeFileSync(join(root, 'real.txt'), 'real content')
  symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'))
  assert.equal(readTextFile(root, 'link.txt'), 'real content')
})

// --- searchFiles (ripgrep) ------------------------------------------------

test('searchFiles finds a literal match with line number and text', async () => {
  const root = fixture()
  writeFileSync(join(root, 'app.ts'), 'const x = 1\nconst needle = 2\n')

  const { matches, truncated } = await searchFiles(root, 'needle')
  assert.equal(truncated, false)
  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.path, 'app.ts')
  assert.equal(matches[0]?.line, 2)
  assert.match(matches[0]!.text, /needle/)
})

test('searchFiles returns nothing for an empty query rather than everything', async () => {
  const root = fixture()
  writeFileSync(join(root, 'app.ts'), 'const x = 1\n')
  const { matches } = await searchFiles(root, '   ')
  assert.deepEqual(matches, [])
})

test('searchFiles returns an empty result (not a thrown error) when nothing matches', async () => {
  const root = fixture()
  writeFileSync(join(root, 'app.ts'), 'const x = 1\n')
  const { matches, truncated } = await searchFiles(root, 'no-such-token-anywhere')
  assert.deepEqual(matches, [])
  assert.equal(truncated, false)
})

test('searchFiles never returns a match from outside the project root', async () => {
  const parent = fixture()
  const root = join(parent, 'app')
  mkdirSync(root)
  writeFileSync(join(root, 'inside.ts'), 'shared-token inside\n')
  writeFileSync(join(parent, 'outside.ts'), 'shared-token outside\n')

  const { matches } = await searchFiles(root, 'shared-token')
  assert.deepEqual(matches.map((m) => m.path), ['inside.ts'])
})

test('searchFiles works inside a real git repo (ripgrep respects .gitignore by default)', async () => {
  const root = fixture()
  execFileSync('git', ['-C', root, 'init', '-q'])
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n')
  writeFileSync(join(root, 'ignored.ts'), 'const target = 1\n')
  writeFileSync(join(root, 'tracked.ts'), 'const target = 2\n')

  const { matches } = await searchFiles(root, 'target')
  assert.deepEqual(matches.map((m) => m.path), ['tracked.ts'])
})
