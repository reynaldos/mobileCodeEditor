import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTerminalMessage } from './terminal.ts'

test('parseTerminalMessage reads an input frame', () => {
  assert.deepEqual(parseTerminalMessage('{"type":"input","data":"ls -la\\n"}'), { type: 'input', data: 'ls -la\n' })
})

test('parseTerminalMessage reads and clamps a resize frame', () => {
  assert.deepEqual(parseTerminalMessage('{"type":"resize","cols":120,"rows":40}'), { type: 'resize', cols: 120, rows: 40 })
  // Bogus dims are floored to [1, 1000], not trusted.
  assert.deepEqual(parseTerminalMessage('{"type":"resize","cols":0,"rows":99999}'), { type: 'resize', cols: 1, rows: 1000 })
  assert.deepEqual(parseTerminalMessage('{"type":"resize","cols":80.9,"rows":24.9}'), { type: 'resize', cols: 80, rows: 24 })
})

test('parseTerminalMessage rejects malformed or unknown frames', () => {
  for (const bad of ['not json', '{}', '{"type":"input"}', '{"type":"resize","cols":"x","rows":1}', '{"type":"nope"}', '42', 'null']) {
    assert.equal(parseTerminalMessage(bad), null, bad)
  }
})
