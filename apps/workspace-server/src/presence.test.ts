import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Presence } from './presence.ts'

test('anyVisible is false with no reports', () => {
  assert.equal(new Presence().anyVisible, false)
})

test('one visible client is enough', () => {
  const presence = new Presence()
  presence.set('a', true)
  assert.equal(presence.anyVisible, true)
})

test('setting a client hidden again removes it', () => {
  const presence = new Presence()
  presence.set('a', true)
  presence.set('a', false)
  assert.equal(presence.anyVisible, false)
})

test('a second client keeps anyVisible true after the first goes hidden', () => {
  const presence = new Presence()
  presence.set('a', true)
  presence.set('b', true)
  presence.set('a', false)
  assert.equal(presence.anyVisible, true)
})

test('clear() removes a client regardless of its last reported state', () => {
  const presence = new Presence()
  presence.set('a', true)
  presence.clear('a')
  assert.equal(presence.anyVisible, false)
})

test('clear() on an unknown id is a no-op, not a throw', () => {
  const presence = new Presence()
  assert.doesNotThrow(() => presence.clear('ghost'))
})
