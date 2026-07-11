import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Github, type GhRun } from './github.ts'

/** A fake `gh` that answers by matching on the argv. */
function fakeGh(handlers: Array<[RegExp | ((a: string[]) => boolean), string | (() => never)]>): {
  gh: GhRun
  calls: string[][]
} {
  const calls: string[][] = []
  const gh: GhRun = async (args) => {
    calls.push(args)
    const joined = args.join(' ')
    for (const [match, out] of handlers) {
      const hit = typeof match === 'function' ? match(args) : match.test(joined)
      if (hit) {
        if (typeof out === 'function') return out()
        return out
      }
    }
    throw new Error(`unexpected gh ${joined}`)
  }
  return { gh, calls }
}

const REPOS_JSON = [
  { nameWithOwner: 'reynaldos/fitnessTracker', owner: 'reynaldos', description: 'fit', private: false, url: 'https://github.com/reynaldos/fitnessTracker', cloneUrl: 'https://github.com/reynaldos/fitnessTracker.git' },
  { nameWithOwner: 'someorg/shared-lib', owner: 'someorg', description: 'lib', private: true, url: 'https://github.com/someorg/shared-lib', cloneUrl: 'https://github.com/someorg/shared-lib.git' },
  { nameWithOwner: 'reynaldos/notes', owner: 'reynaldos', description: null, private: true, url: 'https://github.com/reynaldos/notes', cloneUrl: 'https://github.com/reynaldos/notes.git' },
].map((r) => JSON.stringify(r)).join('\n')

test('login is read once and cached', async () => {
  const { gh, calls } = fakeGh([[/api \/user --jq \.login/, 'reynaldos\n']])
  const g = new Github(gh)
  assert.equal(await g.login(), 'reynaldos')
  assert.equal(await g.login(), 'reynaldos')
  assert.equal(calls.filter((c) => c.includes('/user')).length, 1, 'cached')
})

test('listRepos filters by query and puts owned repos first', async () => {
  const { gh } = fakeGh([
    [/api \/user --jq/, 'reynaldos\n'],
    [/user\/repos/, REPOS_JSON],
  ])
  const g = new Github(gh)

  const all = await g.listRepos('')
  assert.equal(all[0]?.owner, 'reynaldos', 'owned first')
  assert.ok(all.every((r) => typeof r.isOwn === 'boolean'))
  assert.equal(all.find((r) => r.nameWithOwner === 'someorg/shared-lib')?.isOwn, false)

  const filtered = await g.listRepos('shared')
  assert.deepEqual(filtered.map((r) => r.nameWithOwner), ['someorg/shared-lib'])
})

test('repoExists is true on success, false on a 404', async () => {
  const existing = fakeGh([
    [/api \/user --jq/, 'reynaldos\n'],
    [(a) => a.join(' ').includes('/repos/reynaldos/taken'), ''],
  ])
  assert.equal(await new Github(existing.gh).repoExists('taken'), true)

  const missing = fakeGh([
    [/api \/user --jq/, 'reynaldos\n'],
    [(a) => a.join(' ').includes('/repos/reynaldos/free'), () => { throw new Error('gh: 404') }],
  ])
  assert.equal(await new Github(missing.gh).repoExists('free'), false)
})

test('createRepo calls gh with the right visibility and returns the clone URL', async () => {
  const { gh, calls } = fakeGh([
    [/api \/user --jq/, 'reynaldos\n'],
    [(a) => a[0] === 'repo' && a[1] === 'create', ''],
  ])
  const url = await new Github(gh).createRepo('my-idea', 'private')

  assert.equal(url, 'https://github.com/reynaldos/my-idea.git')
  const createCall = calls.find((c) => c[0] === 'repo' && c[1] === 'create')
  assert.deepEqual(createCall, ['repo', 'create', 'my-idea', '--private'])
})
