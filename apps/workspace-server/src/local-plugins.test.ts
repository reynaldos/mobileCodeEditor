import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discoverLocalPlugins } from './local-plugins.ts'

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'mce-plugins-'))
}

test('discoverLocalPlugins returns nothing for a missing directory', () => {
  assert.deepEqual(discoverLocalPlugins(join(tmpdir(), 'mce-plugins-does-not-exist')), [])
})

test('discoverLocalPlugins returns nothing for an empty directory', () => {
  assert.deepEqual(discoverLocalPlugins(fixture()), [])
})

test('discoverLocalPlugins finds one entry per plugin subdirectory', () => {
  const dir = fixture()
  mkdirSync(join(dir, 'my-plugin', '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, 'my-plugin', '.claude-plugin', 'plugin.json'), '{"name":"my-plugin"}')
  mkdirSync(join(dir, 'other-plugin'), { recursive: true })

  const found = discoverLocalPlugins(dir)
  assert.deepEqual(
    found.map((p) => p.path).sort(),
    [join(dir, 'my-plugin'), join(dir, 'other-plugin')].sort(),
  )
  assert.ok(found.every((p) => p.type === 'local'))
})

test('discoverLocalPlugins ignores stray files alongside plugin directories', () => {
  const dir = fixture()
  mkdirSync(join(dir, 'a-plugin'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'not a plugin')

  const found = discoverLocalPlugins(dir)
  assert.deepEqual(
    found.map((p) => p.path),
    [join(dir, 'a-plugin')],
  )
})
