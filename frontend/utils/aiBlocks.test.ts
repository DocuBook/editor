import { describe, it, expect } from 'vitest'
import { inheritFormatOnReplace, buildApplyDocumentInput, validateOperationsSemantics, buildTaskFormattingRules, normalizeMarkdown, isVaultGenerationIntent, buildVaultGroundingPrompt, buildEditSystemPrompt, buildToolSystemPrompt, buildDocumentContext, buildToolDocContext, buildBaseMessages, isMeaningfulOps, AI_MARKDOWN_INSTRUCTION, suffixOperationIds } from '../utils/aiBlocks'

describe('buildDocumentContext', () => {
  const editor: any = {
    document: [{ id: 'b1', type: 'heading', content: [{ type: 'text', text: 'Title' }] }],
    blocksToMarkdownLossy: () => '# Title\n',
    getSelection: () => null,
  }
  it('returns markdown without ids (non-tool path)', () => {
    expect(buildDocumentContext(editor)).toContain('# Title')
  })
  it('appends selection block types', () => {
    const ed: any = { ...editor, getSelection: () => ({ blocks: [{ id: 'b1', type: 'heading', level: 1 }] }) }
    expect(buildDocumentContext(ed)).toContain('b1: heading level 1')
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

describe('isMeaningfulOps', () => {
  it('true only for tool calls with non-empty operations array', () => {
    expect(isMeaningfulOps({ input: { operations: [{ type: 'add' }] } })).toBe(true)
    expect(isMeaningfulOps({ input: { operations: [] } })).toBe(false)
    expect(isMeaningfulOps({ input: {} })).toBe(false)
    expect(isMeaningfulOps({})).toBe(false)
    expect(isMeaningfulOps(null)).toBe(false)
  })
})

describe('suffixOperationIds', () => {
  it('adds $ to id and referenceId', () => {
    const out = suffixOperationIds({
      type: 'applyDocumentOperations',
      operations: [
        { type: 'update', id: 'abc' },
        { type: 'add', referenceId: 'root', blocks: [{ id: 'new' }] },
      ],
    })
    expect(out.operations[0].id).toBe('abc$')
    expect(out.operations[1].referenceId).toBe('root$')
    expect(out.operations[1].blocks[0].id).toBe('new') // nested block ids NOT touched (only op id/referenceId)
  })
  it('leaves already-suffixed ids unchanged', () => {
    const out = suffixOperationIds({ type: 'applyDocumentOperations', operations: [{ type: 'update', id: 'abc$' }] })
    expect(out.operations[0].id).toBe('abc$')
  })
  it('leaves input without operations array unchanged', () => {
    const input = { type: 'other', foo: 'bar' }
    expect(suffixOperationIds(input)).toBe(input)
    expect(suffixOperationIds(null)).toBeNull()
    expect(suffixOperationIds('str')).toBe('str')
  })
  it('handles tool args without type field (model sends {operations} only)', () => {
    const out = suffixOperationIds({ operations: [{ type: 'update', id: 'ref2' }, { type: 'add', referenceId: 'root' }] })
    expect(out.operations[0].id).toBe('ref2$')
    expect(out.operations[1].referenceId).toBe('root$')
  })
  it('handles missing/empty id', () => {
    const out = suffixOperationIds({ type: 'applyDocumentOperations', operations: [{ type: 'delete', id: '' }, { type: 'add' }] })
    expect(out.operations[0].id).toBe('')
    expect(out.operations[1]).toEqual({ type: 'add' })
  })
})

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
  const mockEditor = (opts: { selection?: any[]; cursorBlockId?: string; parse?: (md: string) => any[] | null | Promise<any[] | null> }) => ({
    tryParseMarkdownToBlocks: async (md: string) => {
      if (opts.parse) return opts.parse(md)
      if (!md.trim()) return null
      return [{ id: 'new-1', type: 'paragraph', content: [{ type: 'text', text: md }] }]
    },
    blocksToHTMLLossy: (blocks: any[]) => blocks.map((b: any) => `<p>${b.content?.[0]?.text ?? ''}</p>`).join(''),
    getSelection: () => (opts.selection ? { blocks: opts.selection } : undefined),
    getTextCursorPosition: () => ({ block: { id: opts.cursorBlockId } }),
  })

  it('converts model math to mathBlock via mathDollarToMathML (parity with load path)', async () => {
    let received = ''
    const editor = mockEditor({
      cursorBlockId: 'b-cursor',
      parse: async (md: string) => {
        received = md
        // simulate BlockNote converting the <math> HTML into a mathBlock
        return md.includes('<math display="block">')
          ? [{ id: 'new-1', type: 'mathBlock', content: [{ type: 'text', text: 'm_e = 9.11' }] }]
          : [{ id: 'new-1', type: 'paragraph', content: [{ type: 'text', text: md }] }]
      },
    })
    const input = await buildApplyDocumentInput(editor, '$$ m_e = 9.11 \\times 10^{-31} $$')
    expect(received).toContain('<math display="block">')
    expect(received).toContain('application/x-tex')
    expect(input.operations[0].blocks[0]).toContain('m_e = 9.11')
  })

  it('restores model-escaped \\$ before math parsing', async () => {
    let received = ''
    const editor = mockEditor({
      cursorBlockId: 'b',
      parse: async (md: string) => {
        received = md
        return [{ id: 'n', type: 'paragraph', content: [{ type: 'text', text: md }] }]
      },
    })
    await buildApplyDocumentInput(editor, '\\$ a = b \\$')
    // escaped dollars restored → single $$ pair reaches the math converter
    expect(received).not.toContain('\\\\$')
  })

  it('anchors add on prevBlock when cursor block is empty (xl-ai deletes it)', async () => {
    const editor = mockEditor({ cursorBlockId: 'b-empty' })
    editor.getTextCursorPosition = () => ({ block: { id: 'b-empty' }, prevBlock: { id: 'b-prev' } })
    const input = await buildApplyDocumentInput(editor, 'Hello world')
    expect(input.operations[0].referenceId).toBe('b-prev$')
    expect(input.operations[0].position).toBe('after')
  })

  it('keeps cursor anchor when cursor block has content', async () => {
    const editor = mockEditor({ cursorBlockId: 'b-full' })
    editor.getTextCursorPosition = () => ({ block: { id: 'b-full', content: [{ type: 'text', text: 'x' }] }, prevBlock: { id: 'b-prev' } })
    const input = await buildApplyDocumentInput(editor, 'Hello world')
    expect(input.operations[0].referenceId).toBe('b-full$')
  })

  it('keeps cursor anchor on single empty block (xl-ai does not delete it)', async () => {
    const editor = mockEditor({ cursorBlockId: 'b-only' })
    editor.getTextCursorPosition = () => ({ block: { id: 'b-only' } })
    const input = await buildApplyDocumentInput(editor, 'Hello world')
    expect(input.operations[0].referenceId).toBe('b-only$')
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

  it('converts extra AI blocks beyond selection into add-ops (no undefined$ id)', async () => {
    const editor = mockEditor({
      selection: [{ id: 'h1', type: 'heading', level: 2 }],
      cursorBlockId: 'b',
      parse: async () => [
        { type: 'paragraph', content: [{ type: 'text', text: 'title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'extra content' }] },
      ],
    })
    const input = await buildApplyDocumentInput(editor, 'Improved text with more content')
    expect(input.operations.length).toBe(2)
    expect(input.operations[0]).toMatchObject({ type: 'update', id: 'h1$' })
    expect(input.operations[1]).toEqual({
      type: 'add',
      referenceId: 'h1$',
      position: 'after',
      blocks: ['<p>extra content</p>'],
    })
  })

  it('returns null for empty text', async () => {
    const editor = mockEditor({ cursorBlockId: 'b' })
    expect(await buildApplyDocumentInput(editor, '   ')).toBeNull()
  })

  it('returns null when parse fails', async () => {
    const editor = mockEditor({ cursorBlockId: 'b', parse: async () => null })
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

  it('validates tool args without type field (model sends {operations} only)', () => {
    expect(validateOperationsSemantics(editor, {
      operations: [{ type: 'add', referenceId: 'b1$', position: 'after', blocks: ['<p>x</p>'] }],
    })).toBeNull()
    const err = validateOperationsSemantics(editor, {
      operations: [{ type: 'add', referenceId: 'fake$', position: 'after', blocks: ['<p>x</p>'] }],
    })
    expect(err).toContain('does not exist')
  })
})

describe('buildToolSystemPrompt', () => {
  const base = buildToolSystemPrompt('[{"id":"a$","block":"<p>x</p>"}]', '', '')
  it('instructs the tool call and id suffixing', () => {
    expect(base).toContain('applyDocumentOperations')
    expect(base).toContain('trailing $')
  })
  it('documents the math block HTML encoding', () => {
    expect(base).toContain('math display="block"')
    expect(base).toContain('application/x-tex')
  })
  it('documents the mermaid diagram HTML encoding', () => {
    expect(base).toContain('language-mermaid')
    expect(base).toContain('data-language="mermaid"')
  })
  it('includes vault context when present', () => {
    expect(buildToolSystemPrompt('doc', 'VAULT', '')).toContain('Vault context')
    expect(buildToolSystemPrompt('doc', '', '')).not.toContain('Vault context')
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

describe('isVaultGenerationIntent', () => {
  it('false without vault context', () => {
    expect(isVaultGenerationIntent('Apa isi vault?', false, '')).toBe(false)
  })
  it('true for wikilink reference', () => {
    expect(isVaultGenerationIntent('Ringkas [[roadmap]]', true, 'doc')).toBe(true)
  })
  it('true for question', () => {
    expect(isVaultGenerationIntent('Apa isi vault?', true, 'doc')).toBe(true)
  })
  it('true for generation command', () => {
    expect(isVaultGenerationIntent('Buat draft rencana kerja', true, 'doc')).toBe(true)
    expect(isVaultGenerationIntent('Generate ringkasan rapat', true, 'doc')).toBe(true)
  })
  it('true on empty document with vault context', () => {
    expect(isVaultGenerationIntent('Lanjutkan catatan', true, '')).toBe(true)
  })
  it('false for edit request on non-empty doc', () => {
    expect(isVaultGenerationIntent('Perbaiki typo di sini', true, 'ada konten')).toBe(false)
  })
})

describe('buildVaultGroundingPrompt', () => {
  it('embeds vault context and forbids fabrication', () => {
    const p = buildVaultGroundingPrompt('## notes\n(File: x.md)\nisi')
    expect(p).toContain('## notes')
    expect(p).toContain('never fabricate')
    expect(p).toContain('authoritative source material')
  })
})

describe('buildEditSystemPrompt', () => {
  it('includes doc state, vault context, and edit rules', () => {
    const p = buildEditSystemPrompt('konten doc', '## vault\nisi', '- summarize rule')
    expect(p).toContain('Document state (JSON):')
    expect(p).toContain('konten doc')
    expect(p).toContain('## vault')
    expect(p).toContain('reference block ids EXACTLY as shown')
    expect(p).toContain('summarize rule')
  })
  it('omits vault section when vault context empty', () => {
    const p = buildEditSystemPrompt('doc', '', '')
    expect(p).not.toContain('Vault context')
  })
})

describe('AI_MARKDOWN_INSTRUCTION', () => {
  it('is a non-empty markdown instruction', () => {
    expect(AI_MARKDOWN_INSTRUCTION).toContain('BlockNote-compatible Markdown')
    expect(AI_MARKDOWN_INSTRUCTION).toContain('No commentary')
  })
})
