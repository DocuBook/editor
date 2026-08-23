import { describe, it, expect } from 'vitest'
import { buildDocumentContext, buildEditSystemPrompt, buildToolDocContext, buildBaseMessages } from '../../../frontend/utils/aiBlocks'

describe('buildDocumentContext', () => {
  const editor: any = {
    document: [{ id: 'b1', type: 'heading', content: [{ type: 'text', text: 'Title' }] }],
    blocksToMarkdownLossy: () => '# Title\n',
    getSelection: () => null,
  }
  it('returns markdown without ids (non-tool path)', () => {
    expect(buildDocumentContext(editor)).toContain('# Title')
  })
  it('appends selection block types without internal ids', () => {
    const leakedId = 'f420cd68-9d89-46dc-9782-d1d973af1471$'
    const ed: any = { ...editor, getSelection: () => ({ blocks: [{ id: leakedId, type: 'heading', level: 1 }] }) }
    const context = buildDocumentContext(ed)
    expect(context).toContain('heading level 1')
    expect(context).not.toContain(leakedId)
    expect(buildEditSystemPrompt(context)).not.toContain(leakedId)
  })
  it('returns empty for missing editor', () => {
    expect(buildDocumentContext(null)).toBe('')
  })
})

describe('buildToolDocContext', () => {
  it('serializes blocks with suffixed ids (xl-ai metadata.documentState)', () => {
    const ds = { blocks: [{ id: 'abc$', block: '<h2>T</h2>' }], isEmptyDocument: false }
    const s = buildToolDocContext(ds)
    expect(s).toContain('"id":"abc$"')
    expect(s).toContain('<h2>T</h2>')
  })
  it('puts selected blocks first when a selection is active', () => {
    const ds = { selectedBlocks: [{ id: 'sel$', block: '<p>x</p>' }], blocks: [{ id: 'a$', block: '<p>a</p>' }] }
    const s = buildToolDocContext(ds)
    expect(s.indexOf('SELECTED')).toBeLessThan(s.indexOf('"id":"a$"'))
    expect(s.indexOf('sel$')).toBeLessThan(s.indexOf('a$'))
  })
  it('returns empty when no blocks', () => {
    expect(buildToolDocContext({})).toBe('')
    expect(buildToolDocContext(null)).toBe('')
  })
})

describe('buildBaseMessages', () => {
  const base = { system: 'SYS', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any[], userText: 'hi', selText: '', useTools: false }
  it('text-only: system + user with markdown instruction', () => {
    const msgs = buildBaseMessages(base)
    expect(msgs.length).toBe(2)
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(msgs[1].content).toContain('hi')
    expect(msgs[1].content).toContain('BlockNote-compatible Markdown')
  })
  it('text-only without system: single user message', () => {
    const msgs = buildBaseMessages({ ...base, system: '' })
    expect(msgs.length).toBe(1)
  })
  it('tools: system + clean history (parts flattened, metadata dropped)', () => {
    const msgs = buildBaseMessages({ ...base, useTools: true, messages: [
      { role: 'user', parts: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }], metadata: { documentState: {} } },
      { role: 'assistant', content: 'prev' },
    ] as any[] })
    expect(msgs.length).toBe(3)
    expect(msgs[1]).toEqual({ role: 'user', content: 'hello world' })
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'prev' })
  })
  it('appends selection text for text-only', () => {
    const msgs = buildBaseMessages({ ...base, selText: 'selected' })
    expect(msgs[1].content).toContain('Selected text:\n"selected"')
  })
})
