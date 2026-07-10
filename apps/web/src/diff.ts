/**
 * A line diff, in about sixty lines and with no dependency.
 *
 * Claude's `Edit` tool hands us `old_string` and `new_string` directly, so we
 * already have both sides. Only whole-file `Write` needs real diffing, and even
 * then the inputs are small enough that an O(n·m) LCS is free.
 */

export type RowKind = 'context' | 'added' | 'removed' | 'gap'

export interface Row {
  kind: RowKind
  text: string
}

/** Context lines kept either side of a change. More is unreadable at 390px. */
const CONTEXT = 2

/** The LCS table is O(n·m) cells. Past this, show blocks instead of allocating. */
const LCS_CELL_BUDGET = 4_000_000

export function lineDiff(before: string, after: string): Row[] {
  const a = before.split('\n')
  const b = after.split('\n')

  if ((a.length + 1) * (b.length + 1) > LCS_CELL_BUDGET) {
    return [
      ...a.map((text): Row => ({ kind: 'removed', text })),
      ...b.map((text): Row => ({ kind: 'added', text })),
    ]
  }
  return collapse(backtrack(lcsTable(a, b), a, b))
}

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  return table
}

function backtrack(table: number[][], a: string[], b: string[]): Row[] {
  const rows: Row[] = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', text: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      rows.push({ kind: 'removed', text: a[i]! })
      i++
    } else {
      rows.push({ kind: 'added', text: b[j]! })
      j++
    }
  }
  while (i < a.length) rows.push({ kind: 'removed', text: a[i++]! })
  while (j < b.length) rows.push({ kind: 'added', text: b[j++]! })

  return rows
}

/** Replace long runs of unchanged lines with a single gap marker. */
function collapse(rows: Row[]): Row[] {
  const keep = new Set<number>()

  rows.forEach((row, index) => {
    if (row.kind === 'context') return
    for (let k = index - CONTEXT; k <= index + CONTEXT; k++) {
      if (k >= 0 && k < rows.length) keep.add(k)
    }
  })

  // No changes at all: show the whole thing rather than an empty diff.
  if (keep.size === 0) return rows

  const out: Row[] = []
  let skipped = 0

  rows.forEach((row, index) => {
    if (keep.has(index)) {
      if (skipped > 0) {
        out.push({ kind: 'gap', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
        skipped = 0
      }
      out.push(row)
    } else {
      skipped++
    }
  })
  if (skipped > 0) {
    out.push({ kind: 'gap', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
  }

  return out
}

export interface DiffSubject {
  filePath?: string
  before: string
  after: string
}

/** Pull a diffable pair out of an Edit or Write tool input, if there is one. */
export function diffSubjectOf(tool: string, input: unknown): DiffSubject | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const filePath = typeof record.file_path === 'string' ? record.file_path : undefined

  if (tool === 'Edit' && typeof record.old_string === 'string' && typeof record.new_string === 'string') {
    return { filePath, before: record.old_string, after: record.new_string }
  }
  if (tool === 'Write' && typeof record.content === 'string') {
    return { filePath, before: '', after: record.content }
  }
  return undefined
}
