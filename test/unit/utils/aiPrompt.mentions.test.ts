import { describe, expect, it } from 'vitest'
import { buildAiPrompt } from '../../../frontend/utils/aiPrompt'

const base = { messages: [{ id: 'u1', role: 'user', content: 'use @docs/a.md' }], documentMarkdown: 'doc', selectedMarkdown: '', userText: 'use @docs/a.md', taskRules: '' }

describe('mention prompt context', () => {
  it('leaves no-mention prompt message sequence unchanged', () => {
    const input = { ...base, userText: 'hello', messages: [{ role: 'user', content: 'hello' }] }
    expect(buildAiPrompt({ ...input, mode: 'tool' }).messages.map(({ role, content }) => [role, content])).toEqual([
      ['system', expect.any(String)], ['user', 'hello'],
    ])
  })
  it('injects framed vault data before user in both modes', () => {
    const context = { files: [{ path: 'docs/a.md', content: 'reference', truncated: true }], skipped: [{ path: 'missing.md', reason: 'not_found' }] }
    for (const mode of ['tool', 'text'] as const) {
      const messages = buildAiPrompt({ ...base, mode, mentionContext: context }).messages
      const index = messages.findIndex((message) => message.content.includes('<vault_context>'))
      expect(index).toBeGreaterThan(0)
      expect(messages[index].content).toContain('untrusted reference data')
      expect(messages[index].content).toContain('path="docs/a.md" truncated="true"')
      expect(messages[index].content).toContain('missing.md: not_found')
      expect(messages[index + 1].role).toBe('user')
    }
  })

  it('keeps document state and mention context as separate, non-overlapping layers', () => {
    const documentState = { selection: false, isEmptyDocument: false, blocks: [{ id: 'b1$', block: '<p>Doc</p>' }] }
    const mentionContext = { files: [{ path: 'note.md', content: 'REFERENCE', truncated: false }], skipped: [] }
    const messages = buildAiPrompt({ ...base, mode: 'tool', documentState, mentionContext }).messages
    const vaultIndexes = messages.flatMap((message, index) => (message.content.includes('<vault_context>') ? [index] : []))
    const stateIndexes = messages.flatMap((message, index) => (message.content.includes('latest state of the document') ? [index] : []))
    expect(vaultIndexes).toHaveLength(1)
    expect(stateIndexes).toHaveLength(1)
    const userIndex = messages.findIndex((message) => message.role === 'user')
    expect(stateIndexes[0]).toBeLessThan(vaultIndexes[0])
    expect(vaultIndexes[0]).toBeLessThan(userIndex)
    expect(messages[vaultIndexes[0]].content).toContain('REFERENCE')
    expect(messages[vaultIndexes[0]].content).not.toContain('<p>Doc</p>')
    expect(messages[stateIndexes[0]].content).toContain('<p>Doc</p>')
    expect(messages[stateIndexes[0]].content).not.toContain('REFERENCE')
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(messages[userIndex].content).toBe(base.userText)
  })

  it('injects each context layer exactly once in text mode too', () => {
    const documentState = { selection: false, isEmptyDocument: false, blocks: [{ id: 'b1$', block: '<p>Doc</p>' }] }
    const mentionContext = { files: [{ path: 'note.md', content: 'REFERENCE', truncated: false }], skipped: [] }
    const messages = buildAiPrompt({ ...base, mode: 'text', documentMarkdown: 'doc body', documentState, mentionContext }).messages
    expect(messages.filter((message) => message.content.includes('<vault_context>'))).toHaveLength(1)
    expect(messages.filter((message) => message.content.includes('Latest document context'))).toHaveLength(1)
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })
})
