import { describe, expect, it } from 'vitest'

import { mapWithConcurrency } from '../../../frontend/utils/concurrency'

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const delays = [30, 10, 20, 5]
    const result = await mapWithConcurrency(delays, 2, async (ms, index) => {
      await new Promise(resolve => setTimeout(resolve, ms))
      return `item-${index}`
    })

    expect(result).toEqual(['item-0', 'item-1', 'item-2', 'item-3'])
  })

  it('never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight -= 1
    })

    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('handles an empty list and a limit above the item count', async () => {
    expect(await mapWithConcurrency([], 4, async () => 'never')).toEqual([])
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4])
  })
})
