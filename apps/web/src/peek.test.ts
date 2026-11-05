import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PEEK_PX, peekInset, peekSlots, peekSnap } from './peek.ts'

test('peekSlots stacks minimized drawers bottom-to-top in a fixed order', () => {
  assert.deepEqual(peekSlots({ preview: true, terminal: true, explorer: false, env: false }), {
    preview: 0,
    terminal: 1,
    explorer: 2,
    env: 2,
  })
})

test('peekSlots skips raised drawers so the strips below close up', () => {
  // The preview is raised (not minimized): the terminal takes the lowest strip.
  assert.deepEqual(peekSlots({ preview: false, terminal: true, explorer: false, env: true }), {
    preview: 0,
    terminal: 0,
    explorer: 1,
    env: 1,
  })
})

test('peekSlots gives a raised drawer the slot it would land on', () => {
  const slots = peekSlots({ preview: true, terminal: false, explorer: false, env: false })
  assert.equal(slots.terminal, 1)
  assert.equal(slots.env, 1)
})

test('peekSnap and peekInset are whole strip multiples', () => {
  assert.equal(peekSnap(0), `${PEEK_PX}px`)
  assert.equal(peekSnap(1), `${2 * PEEK_PX}px`)
  assert.equal(peekInset(0), '0px')
  assert.equal(peekInset(2), `${2 * PEEK_PX}px`)
})
