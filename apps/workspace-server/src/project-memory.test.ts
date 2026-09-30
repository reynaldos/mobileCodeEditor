import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readProjectClaudeMd } from './project-memory.ts'

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'mce-claudemd-'))
}

test('readProjectClaudeMd returns undefined when there is no CLAUDE.md', () => {
  assert.equal(readProjectClaudeMd(fixture()), undefined)
})

test('readProjectClaudeMd returns the trimmed file contents', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'CLAUDE.md'), '\n  # Project notes\n\nUse pnpm, not npm.\n\n')
  assert.equal(readProjectClaudeMd(dir), '# Project notes\n\nUse pnpm, not npm.')
})

test('readProjectClaudeMd returns undefined for a whitespace-only file', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'CLAUDE.md'), '   \n\n  ')
  assert.equal(readProjectClaudeMd(dir), undefined)
})
