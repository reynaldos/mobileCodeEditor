import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRecap } from './recap.ts'

test('an empty thread has no recap', () => {
  assert.equal(buildRecap([]), undefined)
})

test('a short thread recaps verbatim, labelled Me/You', () => {
  const recap = buildRecap([
    { role: 'user', text: 'add a logout button' },
    { role: 'assistant', text: 'done, in the header' },
  ])
  assert.match(recap ?? '', /recap/i)
  assert.match(recap ?? '', /Me: add a logout button/)
  assert.match(recap ?? '', /You: done, in the header/)
})

test('a long thread keeps only the most recent exchanges and notes the omission', () => {
  const messages = Array.from({ length: 60 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `message ${i}`,
  }))
  const recap = buildRecap(messages) ?? ''

  assert.match(recap, /earlier messages omitted/)
  assert.ok(recap.includes('message 59'), 'keeps the latest')
  assert.ok(!recap.includes('message 0'), 'drops the oldest')
})

test('an over-long single message is truncated', () => {
  const recap = buildRecap([{ role: 'user', text: 'x'.repeat(5000) }]) ?? ''
  assert.ok(recap.includes('…'))
  assert.ok(recap.length < 2000, 'per-message cap kept it small')
})
