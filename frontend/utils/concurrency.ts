/** Run `worker` over `items` with at most `limit` calls in flight.
 *
 *  Result order matches input order. Use this for I/O fan-out that must not be
 *  serial (a long wait per item) and must not be unbounded (flooding IPC or the
 *  filesystem). Workers are expected to handle their own errors; a rejection
 *  stops new items from starting and propagates after the in-flight ones settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const runners = Math.min(Math.max(1, limit), items.length)
  let next = 0
  await Promise.all(Array.from({ length: runners }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }))
  return results
}
