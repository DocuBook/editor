import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from '../../../frontend/utils/frontmatter'

describe('splitFrontmatter', () => {
  it.each([
    ['---\ntitle: x\n---\nBody', '---\ntitle: x\n---\n', 'Body'],
    ['---\ntitle: x\n---\n\n# Heading\n', '---\ntitle: x\n---\n\n', '# Heading\n'],
    ['---\ntitle: x\n---\n\n\n\nBody', '---\ntitle: x\n---\n\n\n\n', 'Body'],
    ['---\ntitle: x\n---', '---\ntitle: x\n---', ''],
    ['---\ntitle: x\n---\n', '---\ntitle: x\n---\n', ''],
    ['---\n---\nBody', '---\n---\n', 'Body'],
    ['---  \na: 1\n---\t\nBody', '---  \na: 1\n---\t\n', 'Body'],
    ['---\ntags:\n  - a\n  - b\n# comment\nnested:\n  key: v\n---\nBody', '---\ntags:\n  - a\n  - b\n# comment\nnested:\n  key: v\n---\n', 'Body'],
    ['---\n"quoted key": 1\n- item\n---\nBody', '---\n"quoted key": 1\n- item\n---\n', 'Body'],
    ['---\ntitle: x\n---\n  indented first line', '---\ntitle: x\n---\n', '  indented first line'],
  ])('splits %j', (text, frontmatter, body) => {
    expect(splitFrontmatter(text)).toEqual({ frontmatter, body })
    expect(frontmatter + body).toBe(text)
  })

  it.each([
    ['no fence', '# Title\n\ntext'],
    ['a fence that never closes', '---\ntitle: x\n\nBody'],
    ['a fence that is not on the first line', '\n---\ntitle: x\n---\nBody'],
    ['a lone divider', '---'],
    ['a leading divider, prose, another divider', '---\n\nIntro\n\n---\n\nBody'],
    ['divider-wrapped prose with a colon later in a line', '---\nMeeting at 10:30 today\n---\nBody'],
    ['a divider pair around a heading', '---\n# Title\nsome text\n---\nBody'],
    ['four dashes', '----\na: 1\n----\nBody'],
  ])('finds no frontmatter in %s', (_name, text) => {
    expect(splitFrontmatter(text)).toEqual({ frontmatter: '', body: text })
  })
})
