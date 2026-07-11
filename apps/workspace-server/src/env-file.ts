import type { EnvEntry } from '@mce/protocol'

/**
 * A deliberately small `.env` reader/writer for the project env editor.
 *
 * It round-trips `KEY=value`, unwraps single/double quotes on read, and re-quotes
 * on write only when a value needs it. It does NOT preserve comments or blank
 * lines — the editor is a key/value view, not a text editor (see PHASE-2.7 #5).
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Parse `.env` text into entries. Comments, blanks, and malformed lines are skipped. */
export function parseEnv(text: string): EnvEntry[] {
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

/** Just the keys (values blanked) — for scaffolding a new .env from .env.example. */
export function keysWithBlankValues(text: string): EnvEntry[] {
  return parseEnv(text).map((e) => ({ key: e.key, value: '' }))
}

/** Serialize entries back to `.env` text. Invalid keys are dropped. */
export function serializeEnv(entries: EnvEntry[]): string {
  const lines = entries
    .filter((e) => KEY.test(e.key))
    .map((e) => `${e.key}=${quote(e.value)}`)
  return lines.length ? `${lines.join('\n')}\n` : ''
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

function quote(value: string): string {
  // Quote when the value would otherwise not round-trip: whitespace, #, or quotes.
  if (value === '' || /[\s#'"]/.test(value)) return `"${value.replace(/(["\\])/g, '\\$1')}"`
  return value
}
