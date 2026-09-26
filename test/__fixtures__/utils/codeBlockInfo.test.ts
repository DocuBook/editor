import { describe, expect, it } from 'vitest'
import { parseCodeBlockInfo, withCodeBlockLanguage, withCodeBlockTitle } from '../../../frontend/utils/codeBlockInfo'

/** The code block stores the whole fence info string in its `language` prop
 *  (that is what makes markdown round-trip), so these two helpers are the only
 *  place that knows how to split it. `class="language-…"` and Shiki take the
 *  language; the block header takes the title. */
describe('parseCodeBlockInfo', () => {
  it('reads a bare language', () => {
    expect(parseCodeBlockInfo('ts')).toEqual({ language: 'ts', title: '' })
  })

  it('reads the language and a double-quoted title', () => {
    expect(parseCodeBlockInfo('ts title="file.ts"')).toEqual({ language: 'ts', title: 'file.ts' })
  })

  it('reads a single-quoted or bare title', () => {
    expect(parseCodeBlockInfo("python title='a.py'").title).toBe('a.py')
    expect(parseCodeBlockInfo('python title=a.py').title).toBe('a.py')
  })

  it('treats a leading key=value token as metadata, not a language', () => {
    expect(parseCodeBlockInfo('title="file.ts" ts')).toEqual({ language: '', title: 'file.ts' })
  })

  it('leaves other info-string tokens alone', () => {
    expect(parseCodeBlockInfo('js showLineNumbers title="app.js"')).toEqual({ language: 'js', title: 'app.js' })
  })

  it('handles an empty info string', () => {
    expect(parseCodeBlockInfo('')).toEqual({ language: '', title: '' })
  })
})

describe('withCodeBlockTitle', () => {
  it('adds a title to a bare language', () => {
    expect(withCodeBlockTitle('ts', 'file.ts')).toBe('ts title="file.ts"')
  })

  it('replaces an existing title instead of appending a second one', () => {
    expect(withCodeBlockTitle('ts title="old.ts"', 'new.ts')).toBe('ts title="new.ts"')
  })

  it('preserves the other info-string tokens', () => {
    expect(withCodeBlockTitle('js showLineNumbers title="old.js"', 'app.js')).toBe('js showLineNumbers title="app.js"')
  })

  it('drops the title when it is cleared', () => {
    expect(withCodeBlockTitle('ts title="file.ts"', '   ')).toBe('ts')
  })

  it('strips characters that would break the token', () => {
    expect(withCodeBlockTitle('ts', 'a"b\nc')).toBe('ts title="abc"')
  })

  it('round-trips what parseCodeBlockInfo reads', () => {
    const info = withCodeBlockTitle('ts', 'file.ts')

    expect(parseCodeBlockInfo(info)).toEqual({ language: 'ts', title: 'file.ts' })
  })
})

describe('withCodeBlockLanguage', () => {
  it('replaces the language and keeps the title', () => {
    expect(withCodeBlockLanguage('ts title="file.ts"', 'python')).toBe('python title="file.ts"')
  })

  it('puts the language in front of a metadata-only info string', () => {
    expect(withCodeBlockLanguage('title="file.ts"', 'js')).toBe('js title="file.ts"')
  })

  it('keeps the other info-string tokens', () => {
    expect(withCodeBlockLanguage('js showLineNumbers title="app.js"', 'ts')).toBe('ts showLineNumbers title="app.js"')
  })

  it('drops the language when it is cleared', () => {
    expect(withCodeBlockLanguage('ts title="file.ts"', '')).toBe('title="file.ts"')
    expect(withCodeBlockLanguage('ts', '  ')).toBe('')
  })

  it('strips characters that would split or retype the token', () => {
    expect(withCodeBlockLanguage('ts', ' py"thon\n')).toBe('python')
    expect(withCodeBlockLanguage('ts', 'js=1')).toBe('js1')
  })

  it('round-trips what parseCodeBlockInfo reads', () => {
    const info = withCodeBlockLanguage('ts title="file.ts"', 'javascript')

    expect(parseCodeBlockInfo(info)).toEqual({ language: 'javascript', title: 'file.ts' })
  })
})
