/**
 * An async iterable you push into. Backs the streaming-input mode of `query()`.
 *
 * Without streaming input, every prompt starts a fresh conversation and Claude
 * forgets the previous turn. It is the single easiest thing to get subtly wrong
 * in this project — the code still runs, it just quietly has amnesia.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = []
  #wake: (() => void) | undefined
  #closed = false

  push(item: T): void {
    if (this.#closed) throw new Error('push after close')
    this.#items.push(item)
    this.#wake?.()
  }

  /** Ends the iteration, which is what makes `query()`'s generator return. */
  close(): void {
    this.#closed = true
    this.#wake?.()
  }

  get closed(): boolean {
    return this.#closed
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.#items.length > 0) {
        yield this.#items.shift() as T
      }
      if (this.#closed) return
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
      this.#wake = undefined
    }
  }
}
