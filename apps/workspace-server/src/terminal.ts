/**
 * The terminal's client→server wire protocol (Phase 4). Kept here, free of any
 * `node-pty` import, so it's unit-testable without the native module.
 *
 * Server→client is raw terminal bytes (written straight to xterm). Client→server
 * is framed as JSON so keystrokes and resize events are unambiguous — a user can
 * type anything, including something that looks like a control message, without
 * it being mistaken for one.
 */

export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

/** A sane upper bound on terminal dimensions — guards against a bogus resize. */
function clampDim(n: number): number {
  return Math.min(1000, Math.max(1, Math.floor(n)))
}

/** Parse one client frame. Returns null for anything malformed (ignored by the caller). */
export function parseTerminalMessage(raw: string): TerminalClientMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>

  if (m.type === 'input' && typeof m.data === 'string') return { type: 'input', data: m.data }
  if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number' && Number.isFinite(m.cols) && Number.isFinite(m.rows)) {
    return { type: 'resize', cols: clampDim(m.cols), rows: clampDim(m.rows) }
  }
  return null
}

/** The login shell to spawn — the user's `$SHELL`, or bash in the container where it's unset. */
export function resolveShell(): string {
  return process.env.SHELL || 'bash'
}
