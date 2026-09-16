// Polyfill Iterator Helpers (ES2024) for Safari < 18 — Iterator.prototype.filter.
// Keep for other editor dependencies that may use iterator helpers in Safari 15-17.
export function installIteratorFilterPolyfill() {
  // %IteratorPrototype% — the shared prototype of MapIterator/ArrayIterator/etc.
  // (also exposed as `Iterator.prototype` on Safari 18+/Chrome 122+, but Safari
  // 15-17 has no global `Iterator` object, so we reach it via the proto chain)
  const IteratorProto = Object.getPrototypeOf(
    Object.getPrototypeOf([][Symbol.iterator]()),
  ) as { filter?: (pred: (value: unknown) => boolean) => IterableIterator<unknown> }
  if (IteratorProto.filter) return
  IteratorProto.filter = function (
    this: IterableIterator<unknown>,
    pred: (value: unknown) => boolean,
  ) {
    const it = this[Symbol.iterator]()
    return (function* () {
      for (;;) {
        const r = it.next()
        if (r.done) return
        if (pred(r.value)) yield r.value
      }
    })()
  }
}
