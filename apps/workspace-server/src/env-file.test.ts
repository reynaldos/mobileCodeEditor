import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keysWithBlankValues, parseEnv, serializeEnv } from './env-file.ts'

test('parseEnv reads KEY=value, skips comments/blanks, unwraps quotes', () => {
  const entries = parseEnv(
    ['# a comment', '', 'API_KEY=abc123', 'export TOKEN = "with spaces"', "NAME='rey'", 'bad line', '=nokey'].join('\n'),
  )
  assert.deepEqual(entries, [
    { key: 'API_KEY', value: 'abc123' },
    { key: 'TOKEN', value: 'with spaces' },
    { key: 'NAME', value: 'rey' },
  ])
})

test('serializeEnv quotes only when needed and drops invalid keys', () => {
  const text = serializeEnv([
    { key: 'PLAIN', value: 'simple' },
    { key: 'SPACED', value: 'has space' },
    { key: 'EMPTY', value: '' },
    { key: '1BAD', value: 'x' },
  ])
  assert.equal(text, ['PLAIN=simple', 'SPACED="has space"', 'EMPTY=""', ''].join('\n'))
})

test('a value survives a parse -> serialize -> parse round trip', () => {
  const original = [
    { key: 'A', value: 'plain' },
    { key: 'B', value: 'two words' },
    { key: 'C', value: 'has#hash' },
  ]
  assert.deepEqual(parseEnv(serializeEnv(original)), original)
})

test('keysWithBlankValues scaffolds from an example', () => {
  assert.deepEqual(keysWithBlankValues('FOO=1\nBAR=secret\n'), [
    { key: 'FOO', value: '' },
    { key: 'BAR', value: '' },
  ])
})
