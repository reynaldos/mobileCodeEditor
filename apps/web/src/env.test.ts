import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksLikeEnvBlock, mergeEnvEntries, parseEnvBlock } from './env.ts'

test('parseEnvBlock parses a pasted block like the server does', () => {
  const block = [
    '# a comment',
    '',
    'API_KEY=abc123',
    'export DATABASE_URL=postgres://u:p@host/db',
    'QUOTED="a b c"',
    "SINGLE='x y'",
    'not a valid line',
    '=leadingEquals',
    'lower_ok=1',
  ].join('\n')
  assert.deepEqual(parseEnvBlock(block), [
    { key: 'API_KEY', value: 'abc123' },
    { key: 'DATABASE_URL', value: 'postgres://u:p@host/db' },
    { key: 'QUOTED', value: 'a b c' },
    { key: 'SINGLE', value: 'x y' },
    { key: 'lower_ok', value: '1' },
  ])
})

test('looksLikeEnvBlock only fires for real assignment blocks', () => {
  assert.equal(looksLikeEnvBlock('KEY=value'), true)
  assert.equal(looksLikeEnvBlock('A=1\nB=2'), true)
  assert.equal(looksLikeEnvBlock('export FOO=bar'), true)
  // A plain value that happens to contain '=' must NOT be treated as a block.
  assert.equal(looksLikeEnvBlock('postgres://user=pass@host'), false)
  assert.equal(looksLikeEnvBlock('just some text'), false)
  assert.equal(looksLikeEnvBlock(''), false)
})

test('mergeEnvEntries upserts by key and drops the stray blank row', () => {
  // Fresh drawer with one empty "Add variable" row; paste two vars.
  const merged = mergeEnvEntries(
    [{ key: '', value: '' }],
    [
      { key: 'API_KEY', value: 'abc' },
      { key: 'PORT', value: '3000' },
    ],
  )
  assert.deepEqual(merged, [
    { key: 'API_KEY', value: 'abc' },
    { key: 'PORT', value: '3000' },
  ])
})

test('mergeEnvEntries updates an existing key in place instead of duplicating', () => {
  const merged = mergeEnvEntries(
    [
      { key: 'API_KEY', value: 'old' },
      { key: 'KEEP', value: 'me' },
    ],
    [{ key: 'API_KEY', value: 'new' }],
  )
  assert.deepEqual(merged, [
    { key: 'API_KEY', value: 'new' },
    { key: 'KEEP', value: 'me' },
  ])
})
