import { describe, it, expect } from 'vitest'
import { inheritFormatOnReplace, buildApplyDocumentInput, validateOperationsSemantics, buildTaskFormattingRules, normalizeMarkdown } from '../utils/aiBlocks'

describe('inheritFormatOnReplace', () => {
  it('inherits heading format onto plain paragraph output', () => {
    const orig = [{ id: 'h1', type: 'heading', level: 2 }]
    const parsed = [{ type: 'paragraph', content: [{ type: 'text', text: 'Introduction' }] }]
    const result = inheritFormatOnReplace(orig, parsed)
    expect(result[0].type).toBe('heading')
    expect(result[0].level).toBe(2)
  })

  it('inherits bullet list format', () => {
    const orig = [{ id: 'l1', type: 'bulletListItem' }]
    const parsed = [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }]
    expect(inheritFormatOnReplace(orig, parsed)[0].type).toBe('bulletListItem')
  })

  it('inherits toggleListItem format', () => {
    const orig = [{ id: 't1', type: 'toggleListItem' }]
    const parsed = [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }]
    expect(inheritFormatOnReplace(orig, parsed)[0].type).toBe('toggleListItem')
  })

  it('does not override explicit model formatting', () => {
    const orig = [{ id: 'h1', type: 'heading', level: 2 }]
    const parsed = [{ type: 'heading', level: 3, content: [{ type: 'text', text: 'x' }] }]
    expect(inheritFormatOnReplace(orig, parsed)[0].level).toBe(3)
  })

  it('keeps paragraph when original is paragraph', () => {
    const orig = [{ id: 'p1', type: 'paragraph' }]
    const parsed = [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }]
    expect(inheritFormatOnReplace(orig, parsed)[0].type).toBe('paragraph')
  })

  it('does not inherit codeBlock onto inline-content paragraph (content shape mismatch)', () => {
    const orig = [{ id: 'c1', type: 'codeBlock' }]
    const parsed = [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }]
    expect(inheritFormatOnReplace(orig, parsed)[0].type).toBe('paragraph')
  })

  it('handles extra AI blocks beyond selection length', () => {
    const orig = [{ id: 'h1', type: 'heading', level: 2 }]
    const parsed = [
      { type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'extra' }] },
    ]
    const result = inheritFormatOnReplace(orig, parsed)
    expect(result[0].type).toBe('heading')
    expect(result[1].type).toBe('paragraph')
  })
})

describe('buildApplyDocumentInput', () => {
  const mockEditor = (opts: { selection?: any[]; cursorBlockId?: string }) => ({
    tryParseMarkdownToBlocks: async (md: string) => {
      if (!md.trim()) return null
      return [{ id: 'new-1', type: 'paragraph', content: [{ type: 'text', text: md }] }]
    },
    blocksToHTMLLossy: (blocks: any[]) => blocks.map((b: any) => `<p>${b.content?.[0]?.text ?? ''}</p>`).join(''),
    getSelection: () => (opts.selection ? { blocks: opts.selection } : undefined),
    getTextCursorPosition: () => ({ block: { id: opts.cursorBlockId } }),
  })

  it('builds add operation after cursor with $-suffixed referenceId and HTML blocks', async () => {
    const editor = mockEditor({ cursorBlockId: 'b-cursor' })
    const input = await buildApplyDocumentInput(editor, 'Hello world')
    expect(input.type).toBe('applyDocumentOperations')
    expect(input.operations[0].type).toBe('add')
    expect(input.operations[0].referenceId).toBe('b-cursor$')
    expect(input.operations[0].position).toBe('after')
    expect(input.operations[0].blocks).toEqual(['<p>Hello world</p>'])
  })

  it('builds update operation with $-suffixed id, preserving format, block as HTML', async () => {
    const editor = mockEditor({ selection: [{ id: 'h1', type: 'heading', level: 2 }] })
    const input = await buildApplyDocumentInput(editor, 'Translated title')
    expect(input.operations[0].type).toBe('update')
    expect(input.operations[0].id).toBe('h1$')
    expect(input.operations[0].block).toBe('<p>Translated title</p>')
  })

  it('returns null for empty text', async () => {
    const editor = mockEditor({ cursorBlockId: 'b' })
    expect(await buildApplyDocumentInput(editor, '   ')).toBeNull()
  })

  it('returns null when parse fails', async () => {
    const editor = {
      tryParseMarkdownToBlocks: async () => null,
      blocksToHTMLLossy: () => '',
      getSelection: () => undefined,
      getTextCursorPosition: () => ({ block: { id: 'b' } }),
    }
    expect(await buildApplyDocumentInput(editor, 'x')).toBeNull()
  })
})

describe('validateOperationsSemantics', () => {
  const editor = { document: [{ id: 'b1', type: 'paragraph', children: [{ id: 'b1-1', type: 'paragraph' }] }] }

  it('accepts add with existing referenceId', () => {
    expect(validateOperationsSemantics(editor, {
      type: 'applyDocumentOperations',
      operations: [{ type: 'add', referenceId: 'b1$', position: 'after', blocks: ['<p>x</p>'] }],
    })).toBeNull()
  })

  it('accepts add with nested existing referenceId', () => {
    expect(validateOperationsSemantics(editor, {
      type: 'applyDocumentOperations',
      operations: [{ type: 'add', referenceId: 'b1-1$', position: 'after', blocks: ['<p>x</p>'] }],
    })).toBeNull()
  })

  it('rejects add with hallucinated referenceId', () => {
    const err = validateOperationsSemantics(editor, {
      type: 'applyDocumentOperations',
      operations: [{ type: 'add', referenceId: 'fake$', position: 'after', blocks: ['<p>x</p>'] }],
    })
    expect(err).toContain('does not exist')
  })

  it('rejects update with hallucinated id', () => {
    const err = validateOperationsSemantics(editor, {
      type: 'applyDocumentOperations',
      operations: [{ type: 'update', id: 'ghost$', block: '<p>x</p>' }],
    })
    expect(err).toContain('does not exist')
  })

  it('returns null for non-applyDocumentOperations input', () => {
    expect(validateOperationsSemantics(editor, { type: 'other' })).toBeNull()
  })
})

describe('buildTaskFormattingRules', () => {
  it('adds summarize rule', () => {
    expect(buildTaskFormattingRules('Summarize')).toContain('concise summary')
  })
  it('adds translate rule', () => {
    expect(buildTaskFormattingRules('Translate to Indonesian')).toContain('preserve its tone')
  })
  it('adds fix spelling rule', () => {
    expect(buildTaskFormattingRules('Fix spelling')).toContain('spelling and grammar errors only')
  })
  it('adds improve rule', () => {
    expect(buildTaskFormattingRules('Improve writing')).toContain('preserve the original meaning')
  })
  it('returns empty for unknown prompt', () => {
    expect(buildTaskFormattingRules('do whatever')).toBe('')
  })
})

describe('normalizeMarkdown', () => {
  it('closes unbalanced code fence', () => {
    const out = normalizeMarkdown('text\n```js\nconsole.log(1)')
    expect((out.match(/```/g) || []).length % 2).toBe(0)
    expect(out.trim().endsWith('```')).toBe(true)
  })

  it('leaves balanced fences unchanged', () => {
    const md = '```js\nx\n```\nmore'
    expect(normalizeMarkdown(md)).toBe(md)
  })
})
