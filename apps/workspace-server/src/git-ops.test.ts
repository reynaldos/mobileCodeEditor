import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  checkoutBranch,
  commitPaths,
  discardPaths,
  isValidBranchName,
  listBranches,
  listStashes,
  pushCurrent,
  stashAction,
} from './git-changes.ts'

/** A throwaway git repo with one commit and a known identity. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mce-gitops-'))
  const g = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  }
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'test@example.com')
  g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'initial')
  return dir
}

test('isValidBranchName accepts real names, rejects junk', () => {
  for (const ok of ['feature/login', 'fix-123', 'a_b', 'main']) assert.equal(isValidBranchName(ok), true, ok)
  for (const bad of ['', '-x', 'a b', 'a..b', 'a~b', 'a:b', 'end/', '/start', 'a\\b']) {
    assert.equal(isValidBranchName(bad), false, bad)
  }
})

test('listBranches reports the current branch and all local branches', async () => {
  const dir = makeRepo()
  execFileSync('git', ['-C', dir, 'branch', 'feature/x'], { stdio: 'ignore' })
  const { current, branches } = await listBranches(dir)
  assert.equal(current, 'main')
  assert.deepEqual(branches, ['feature/x', 'main'])
})

test('checkoutBranch creates and switches', async () => {
  const dir = makeRepo()
  const created = await checkoutBranch(dir, 'feature/y', true)
  assert.ok(created.ok, created.stderr)
  assert.equal((await listBranches(dir)).current, 'feature/y')

  const back = await checkoutBranch(dir, 'main', false)
  assert.ok(back.ok, back.stderr)
  assert.equal((await listBranches(dir)).current, 'main')

  // A branch that doesn't exist fails, not throws.
  const missing = await checkoutBranch(dir, 'nope', false)
  assert.equal(missing.ok, false)
})

test('commitPaths stages and commits only the selected files', async () => {
  const dir = makeRepo()
  writeFileSync(join(dir, 'a.txt'), 'A\n')
  writeFileSync(join(dir, 'b.txt'), 'B\n')

  const result = await commitPaths(dir, 'add a only', ['a.txt'])
  assert.ok(result.ok, result.stderr)

  // a.txt is committed; b.txt is still untracked/uncommitted.
  const tracked = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).split('\n')
  assert.ok(tracked.includes('a.txt'), 'a.txt committed')
  assert.ok(!tracked.includes('b.txt'), 'b.txt not committed')

  const subject = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()
  assert.equal(subject, 'add a only')
})

test('commitPaths refuses an empty selection', async () => {
  const dir = makeRepo()
  const result = await commitPaths(dir, 'nothing', [])
  assert.equal(result.ok, false)
})

test('discardPaths restores a modified file and removes an untracked one, leaving others alone', async () => {
  const dir = makeRepo()
  const read = (p: string): string => execFileSync('git', ['-C', dir, 'show', `HEAD:${p}`], { encoding: 'utf8' })

  // A tracked modification, a brand-new untracked file, and an unrelated change to keep.
  writeFileSync(join(dir, 'README.md'), 'tampered\n')
  writeFileSync(join(dir, 'new.txt'), 'delete me\n')
  writeFileSync(join(dir, 'keep.txt'), 'stays\n')

  const result = await discardPaths(dir, ['README.md', 'new.txt'])
  assert.ok(result.ok, result.stderr)

  // README is back to its committed content; new.txt is gone.
  const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })
  assert.equal(read('README.md'), 'hello\n')
  assert.ok(!status.includes('README.md'), 'README restored')
  assert.ok(!status.includes('new.txt'), 'untracked new.txt removed')
  // The file we didn't ask to discard is untouched.
  assert.ok(status.includes('keep.txt'), 'keep.txt left alone')
})

test('discardPaths refuses an empty selection', async () => {
  const dir = makeRepo()
  assert.equal((await discardPaths(dir, [])).ok, false)
})

test('pushCurrent reports noUpstream for a branch that tracks no remote', async () => {
  const dir = makeRepo() // a fresh local repo has no upstream
  const r = await pushCurrent(dir)
  assert.equal(r.ok, false)
  assert.equal(r.noUpstream, true)
})

test('stash save/list/pop round-trips', async () => {
  const dir = makeRepo()
  writeFileSync(join(dir, 'README.md'), 'changed\n')

  const saved = await stashAction(dir, 'save', 0, 'wip')
  assert.ok(saved.ok, saved.stderr)

  const stashes = await listStashes(dir)
  assert.equal(stashes.length, 1)
  assert.equal(stashes[0]?.index, 0)
  assert.match(stashes[0]?.message ?? '', /wip/)

  // Working tree is clean again after stashing.
  const dirtyAfterSave = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
  assert.equal(dirtyAfterSave, '')

  const popped = await stashAction(dir, 'pop', 0)
  assert.ok(popped.ok, popped.stderr)
  assert.equal((await listStashes(dir)).length, 0)
  const dirtyAfterPop = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
  assert.match(dirtyAfterPop, /README\.md/)
})
