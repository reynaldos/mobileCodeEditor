/**
 * Geometry for minimized drawers. Every drawer (preview, terminal, explorer,
 * .env) can be lowered to a strip at the bottom of the screen instead of
 * closed — the same peek logic the preview drawer started with. More than one
 * can be minimized at once, so the strips stack: each one's snap point sits on
 * top of the strips below it, and the app reserves room for all of them.
 */

/** Height of one strip: grabber + title row. Must match the `h-[72px]` in PeekDrawer. */
export const PEEK_PX = 72
/** Raised: nearly the whole viewport. */
export const FULL = 0.95

export type PeekKey = 'preview' | 'terminal' | 'explorer' | 'env'
/** Bottom-to-top order of the strips. Fixed, so strips never reshuffle when one leaves. */
export const PEEK_ORDER: readonly PeekKey[] = ['preview', 'terminal', 'explorer', 'env']

/**
 * Strip position for every drawer (0 = lowest): the number of minimized drawers
 * that come before it in `PEEK_ORDER`. A drawer that is not minimized still gets
 * the slot it would land on, so lowering it needs no second hop.
 */
export function peekSlots(peeked: Record<PeekKey, boolean>): Record<PeekKey, number> {
  const slots = {} as Record<PeekKey, number>
  let below = 0
  for (const key of PEEK_ORDER) {
    slots[key] = below
    if (peeked[key]) below++
  }
  return slots
}

/** Vaul snap point for a strip at `slot`, as the visible height from the bottom. */
export function peekSnap(slot: number): string {
  return `${(slot + 1) * PEEK_PX}px`
}

/** Room the app keeps clear at the bottom so the prompt box clears `count` strips. */
export function peekInset(count: number): string {
  return `${count * PEEK_PX}px`
}
