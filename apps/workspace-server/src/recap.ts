/**
 * Builds the priming message that gives a fresh Claude session the gist of an
 * earlier thread — the recap half of PHASE-2.5's option C.
 *
 * No LLM call: it's the thread's own prompts and replies from the log, trimmed
 * per-message and capped to the most recent exchanges so a long thread doesn't
 * blow the context. Folded ahead of the user's next prompt by AgentSession.
 */

const MAX_EXCHANGES = 12
const MAX_CHARS_PER_MESSAGE = 600

export function buildRecap(messages: Array<{ role: 'user' | 'assistant'; text: string }>): string | undefined {
  if (messages.length === 0) return undefined

  const recent = messages.slice(-MAX_EXCHANGES * 2)
  const dropped = messages.length - recent.length

  const lines = recent.map((m) => {
    const who = m.role === 'user' ? 'Me' : 'You'
    return `${who}: ${truncate(m.text, MAX_CHARS_PER_MESSAGE)}`
  })

  const preamble =
    'We were in the middle of a conversation in this project. Here is a recap so ' +
    'you have the context; continue from where we left off.'
  const elision = dropped > 0 ? `\n\n(…${dropped} earlier messages omitted…)` : ''

  return `${preamble}${elision}\n\n${lines.join('\n\n')}`
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}
