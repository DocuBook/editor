import { describe, it, expect } from 'vitest'
import { displayGitPath } from '../../../frontend/utils/gitPath'

describe('displayGitPath', () => {
  it('leaves plain and Unicode paths untouched', () => {
    expect(displayGitPath('notes/a b.md')).toBe('notes/a b.md')
    expect(displayGitPath('catatan/café.md')).toBe('catatan/café.md')
  })

  it('decodes the backend C-quoted form', () => {
    expect(displayGitPath('"line\\nbreak.md"')).toBe('line\nbreak.md')
    expect(displayGitPath('" padded.md"')).toBe(' padded.md')
    expect(displayGitPath('"say \\"hi\\".md"')).toBe('say "hi".md')
    expect(displayGitPath('"dir/caf\\303\\251.md"')).toBe('dir/café.md')
  })

  it('shows invalid UTF-8 bytes as replacement characters', () => {
    expect(displayGitPath('"caf\\351.md"')).toBe('caf�.md')
  })

  it('returns malformed quoting unchanged', () => {
    expect(displayGitPath('"bad\\q"')).toBe('"bad\\q"')
    expect(displayGitPath('"')).toBe('"')
  })
})
