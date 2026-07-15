import type { EnvEntry } from '@mce/protocol'

/**
 * Client-side `.env` parsing for the "paste a block" affordance in EnvDrawer.
 *
 * Deliberately mirrors the server's reader (`workspace-server/env-file.ts`): a
 * pasted block round-trips `KEY=value`, tolerates an `export ` prefix, unwraps
 * single/double quotes, and skips comments, blanks, and malformed lines. Keeping
 * the two in step means what you paste parses the same way it will on save.
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Parse pasted `.env` text into entries. Comments, blanks, and malformed lines are skipped. */
export function parseEnvBlock(text: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim()
    if (!KEY.test(key)) continue
    entries.push({ key, value: unquote(line.slice(eq + 1).trim()) })
  }
  return entries
}

/**
 * Whether pasted text looks like one or more `.env` assignments — used to decide
 * when a paste into a field should be intercepted and expanded into rows rather
 * than dropped in verbatim. True only for a real block (a newline, or text that
 * starts on a `KEY=` line), so pasting an ordinary value that merely contains an
 * `=` into a single value field is left alone.
 */
export function looksLikeEnvBlock(text: string): boolean {
  const multiline = /\r?\n/.test(text.trim())
  const startsAssignment = /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text)
  return (multiline || startsAssignment) && parseEnvBlock(text).length > 0
}

/**
 * Merge parsed entries into the current list: an existing (non-blank) key is
 * updated in place, a new key is appended. Empty placeholder rows left over from
 * "Add variable" are dropped once real entries land, so a paste into the default
 * blank row doesn't strand it. Later duplicates within the paste win.
 */
export function mergeEnvEntries(existing: EnvEntry[], pasted: EnvEntry[]): EnvEntry[] {
  const result = existing.slice()
  for (const entry of pasted) {
    const idx = result.findIndex((e) => e.key !== '' && e.key === entry.key)
    if (idx >= 0) result[idx] = { key: entry.key, value: entry.value }
    else result.push(entry)
  }
  const cleaned = result.filter((e) => e.key.trim() !== '' || e.value !== '')
  return cleaned.length > 0 ? cleaned : result
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}
