/**
 * The log is what you dump to debug at 1am. It should never be what leaks a
 * token. Redaction happens on the way IN, not on the way out. See DECISIONS #5.
 */

/** Shapes that look like credentials even if we never saw the literal value. */
const PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
]

const MASK = '[redacted]'

export type Redactor = <T>(value: T) => T

/**
 * @param secrets literal values to scrub — the tokens we actually hold.
 *   Matched by value, so a secret embedded mid-string is still caught.
 */
export function makeRedactor(secrets: readonly string[]): Redactor {
  const literals = [...new Set(secrets.filter((s) => s.length >= 8))]

  return function redact<T>(value: T): T {
    let json: string
    try {
      json = JSON.stringify(value)
    } catch {
      return value // circular; nothing we can safely scrub
    }
    if (json === undefined) return value

    let scrubbed = json
    for (const literal of literals) scrubbed = scrubbed.split(literal).join(MASK)
    for (const pattern of PATTERNS) scrubbed = scrubbed.replace(pattern, MASK)

    return scrubbed === json ? value : (JSON.parse(scrubbed) as T)
  }
}
