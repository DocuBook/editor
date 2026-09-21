// Polyfill Iterator Helpers (ES2024) for Safari < 18 — Iterator.prototype.filter.
//
// Trigger: mermaid's DefaultLangiumProfiler does
// `this.records.entries().filter(...).flatMap(...)` on a Map (verified in the
// built bundle, chunk containing `getRecords`). Iterator.prototype.filter is
// ES2024 and absent on Safari 15-17, so diagram profiling would throw TypeError.
//
// History: this was originally added for @blocknote/xl-ai's `map.values().filter`,
// which was removed when the AI layer went in-house (commit b366ac0). mermaid is
// the remaining caller — re-verify before deleting. If no caller is left, this
// file, its test, and the main.tsx install call can all go.
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
