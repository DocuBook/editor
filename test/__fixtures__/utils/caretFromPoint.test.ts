// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { caretFromPoint } from '../../../frontend/utils/caretFromPoint'

const text = document.createTextNode('hello')
const fakeDocument = (methods: object) => methods as unknown as Document

describe('caretFromPoint', () => {
  it('uses caretPositionFromPoint where it exists (Firefox)', () => {
    const caretPositionFromPoint = vi.fn(() => ({ offsetNode: text, offset: 3 }))
    expect(caretFromPoint(fakeDocument({ caretPositionFromPoint }), 10, 20)).toEqual({ node: text, offset: 3 })
    expect(caretPositionFromPoint).toHaveBeenCalledWith(10, 20)
  })

  it('falls back to caretRangeFromPoint (Safari 15)', () => {
    const range = { startContainer: text, startOffset: 2 }
    const caretRangeFromPoint = vi.fn(() => range)
    expect(caretFromPoint(fakeDocument({ caretRangeFromPoint }), 1, 2)).toEqual({ node: text, offset: 2 })
  })

  it('prefers the standard API when both exist (Chrome 128+)', () => {
    const caretRangeFromPoint = vi.fn()
    const caretPositionFromPoint = () => ({ offsetNode: text, offset: 1 })
    expect(caretFromPoint(fakeDocument({ caretPositionFromPoint, caretRangeFromPoint }), 0, 0)).toEqual({ node: text, offset: 1 })
    expect(caretRangeFromPoint).not.toHaveBeenCalled()
  })

  it('returns null outside the document or without either API', () => {
    expect(caretFromPoint(fakeDocument({ caretPositionFromPoint: () => null }), 0, 0)).toBeNull()
    expect(caretFromPoint(fakeDocument({ caretRangeFromPoint: () => null }), 0, 0)).toBeNull()
    expect(caretFromPoint(fakeDocument({}), 0, 0)).toBeNull()
  })
})
