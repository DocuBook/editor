import { describe, it, expect } from 'vitest'
import { filterMeaningfulOperations, inheritFormatOnReplace, buildApplyDocumentInput, validateOperationsSemantics, isMeaningfulOps, suffixOperationIds } from '../../../frontend/utils/aiBlocks'

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
    expect(err).toBe('Referenced document block is no longer available')
    expect(err).not.toContain('fake$')
  })

  it('rejects update with hallucinated id', () => {
    const err = validateOperationsSemantics(editor, {
      type: 'applyDocumentOperations',
      operations: [{ type: 'update', id: 'ghost$', block: '<p>x</p>' }],
    })
    expect(err).toBe('Referenced document block is no longer available')
    expect(err).not.toContain('ghost$')
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
    expect(err).toBe('Referenced document block is no longer available')
    expect(err).not.toContain('fake$')
  })
})

describe("filterMeaningfulOperations", () => {
  const escapeHtml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const textContent = (html: string) => {
    let text = "";
    let insideTag = false;
    for (const character of html) {
      if (character === "<") insideTag = true;
      else if (character === ">") insideTag = false;
      else if (!insideTag) text += character;
    }
    return text;
  };

  const editor: any = {
    document: [
      {
        id: "b1",
        type: "paragraph",
        content: [{ type: "text", text: "Existing content" }],
      },
    ],
    blocksToHTMLLossy: (blocks: any[]) =>
      blocks
        .map((b: any) => `<p>${escapeHtml(b.content?.[0]?.text ?? "")}</p>`)
        .join(""),
    tryParseHTMLToBlocks: (html: string) => [
      {
        type: "paragraph",
        content: [{ type: "text", text: textContent(html) }],
      },
    ],
  };

  it("drops update with identical HTML", () => {
    expect(
      filterMeaningfulOperations(editor, {
        input: {
          operations: [
            { type: "update", id: "b1$", block: "<p>Existing content</p>" },
          ],
        },
      }),
    ).toBeNull();
  });

  it("keeps update with changed HTML", () => {
    const result = filterMeaningfulOperations(editor, {
      input: {
        operations: [
          { type: "update", id: "b1$", block: "<p>Changed content</p>" },
        ],
      },
    });
    expect(result?.input.operations).toHaveLength(1);
  });

  it("does not pass script-like HTML through operation output", () => {
    const result = filterMeaningfulOperations(editor, {
      input: {
        operations: [
          {
            type: "update",
            id: "b1$",
            block: '<p><script>alert("xss")</script>Changed</p>',
          },
          {
            type: "add",
            referenceId: "b1$",
            blocks: ['<p><img src="x" onerror="alert(1)">Added</p>'],
          },
        ],
      },
    });
    const operations = result?.input.operations ?? [];
    expect(JSON.stringify(operations)).not.toContain("<script");
    expect(JSON.stringify(operations)).not.toContain("onerror");
  });

  it("drops empty add blocks and missing deletes", () => {
    expect(
      filterMeaningfulOperations(editor, {
        input: {
          operations: [
            { type: "add", referenceId: "b1$", blocks: ["", "  "] },
            { type: "delete", id: "missing$" },
          ],
        },
      }),
    ).toBeNull();
  });

  it("keeps valid add and existing delete", () => {
    const result = filterMeaningfulOperations(editor, {
      input: {
        operations: [
          { type: "add", referenceId: "b1$", blocks: ["<p>New</p>"] },
          { type: "delete", id: "b1$" },
        ],
      },
    });
    expect(result?.input.operations).toHaveLength(2);
  });
});
