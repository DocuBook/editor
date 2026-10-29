/** The text position under a viewport point, across browsers: Chrome and Safari
 *  expose `caretRangeFromPoint`, Firefox only the standard `caretPositionFromPoint`
 *  (and Chrome has both from 128). `null` when the point is outside the document
 *  or the browser has neither. */
export function caretFromPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const standard = (doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint
  if (typeof standard === 'function') {
    const position = standard.call(doc, x, y)
    return position ? { node: position.offsetNode, offset: position.offset } : null
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y)
    return range ? { node: range.startContainer, offset: range.startOffset } : null
  }
  return null
}
