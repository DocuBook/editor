import { describe, expect, it } from 'vitest'
import { installIteratorFilterPolyfill } from './iteratorPolyfill'

// %IteratorPrototype% — shared by MapIterator/ArrayIterator/etc.
const IteratorProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) as {
  filter?: unknown
}

describe('installIteratorFilterPolyfill (Safari < 18 iterator helpers)', () => {
  it('installs filter when missing and makes map values filterable', () => {
    delete IteratorProto.filter
    installIteratorFilterPolyfill()

    const map = new Map([['a', 1], ['b', 2]])
    const values = map.values() as unknown as {
      filter: (pred: (v: number) => boolean) => IterableIterator<number>
    }
    // the exact pattern @blocknote/xl-ai uses
    expect(Array.from(values.filter((v) => v > 1))).toEqual([2])
    // result stays iterable (for...of / spread contract) — fresh iterator
    const filtered = new Map([['a', 1], ['b', 2]]).values() as unknown as {
      filter: (pred: (v: number) => boolean) => IterableIterator<number>
    }
    expect([...filtered.filter(() => true)]).toEqual([1, 2])
  })

  it('is a no-op when the native method exists', () => {
    installIteratorFilterPolyfill()
    expect(typeof IteratorProto.filter).toBe('function')
  })
})
