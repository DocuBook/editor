import { describe, expect, it } from 'vitest'

import { lineDiff } from '../../../frontend/utils/lineDiff'

describe('lineDiff', () => {
  it('reports no rows for identical text', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('marks an added line after its context', () => {
    expect(lineDiff('a\n', 'a\nb\n')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'add', text: 'b' },
    ])
  })

  it('marks a deleted line after its context', () => {
    expect(lineDiff('a\nb\n', 'a\n')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'del', text: 'b' },
    ])
  })

  it('pairs a changed line as a deletion then an addition', () => {
    expect(lineDiff('one\n', 'two\n')).toEqual([
      { type: 'del', text: 'one' },
      { type: 'add', text: 'two' },
    ])
  })

  it('collapses a long unchanged run into a single gap row', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'old', 'g', 'h', 'i', 'j', 'k'].join('\n') + '\n'
    const after = ['a', 'b', 'c', 'd', 'e', 'new', 'g', 'h', 'i', 'j', 'k'].join('\n') + '\n'
    const rows = lineDiff(before, after)

    expect(rows.filter(row => row.type === 'del')).toEqual([{ type: 'del', text: 'old' }])
    expect(rows.filter(row => row.type === 'add')).toEqual([{ type: 'add', text: 'new' }])
    expect(rows.filter(row => row.type === 'gap')).toHaveLength(2)
  })
})
