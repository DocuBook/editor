import { beforeEach, describe, it, expect, vi } from 'vitest'

const captured = vi.hoisted(() => ({ transports: [] as any[], parsed: [] as string[], replaced: 0, replacedWith: [] as any[] }))

// Constructing a real BlockNote editor headless (jsdom) throws — stub the whole
// dependency surface so the factory's WIRING (not the editor) is under test.
vi.mock('@blocknote/core', () => ({
  BlockNoteEditor: {
    create: vi.fn(() => ({
      __fakeEditor: true,
      document: ['default-empty-document'],
      tryParseMarkdownToBlocks: vi.fn((markdown: string) => {
        captured.parsed.push(markdown)
        return ['parsed-block']
      }),
      transact: vi.fn((run: any) => run({ setMeta: vi.fn() })),
      replaceBlocks: vi.fn((_document: any, blocks: any) => { captured.replaced += 1; captured.replacedWith.push(blocks) }),
    })),
  },
}))
vi.mock('@blocknote/core/locales', () => ({ en: {} }))
vi.mock('@blocknote/math-block', () => ({ locales: { en: {} } }))
vi.mock('@blocknote/diagram-block', () => ({ locales: { en: {} } }))
vi.mock('../../../frontend/lib/ipc', () => ({
  fileUrl: vi.fn(async () => ''),
  isAbsoluteUrl: () => false,
  isSafeImageUrl: () => true,
}))
vi.mock('../../../frontend/components/editor/setup', () => ({ getSchema: () => ({}), wikilinkStyler: {} }))
// Shiki is irrelevant to the wiring under test, and its grammar maps are heavy.
vi.mock('../../../frontend/utils/codeHighlighting', () => ({ syntaxHighlighting: {}, refreshCodeHighlighting: () => {} }))
vi.mock('../../../frontend/utils/aiTransport', () => ({
  createAiTransport: vi.fn((deps: any) => {
    captured.transports.push(deps)
    return {}
  }),
}))

import { KeepAliveCache, createBlockEditor, getCachedEditor } from '../../../frontend/utils/editorFactory'
import { clearEditorCache } from '../../../frontend/utils/editorCache'

/** The keep-alive cache is the pure, testable core of tab switching: one
 *  entry per path, created lazily, reused on every later lookup. The BlockNote
 *  editor factory itself is NOT constructed here — creating an editor headless
 *  (jsdom) touches module-level SideMenu state and throws; the app only ever
 *  creates instances while mounted, and the instance-survival guarantee is
 *  provided by BlockNote's mount/unmount API (unmount detaches DOM only). */

describe('createBlockEditor AI transport wiring', () => {
  beforeEach(() => {
    captured.transports.length = 0
  })

  /** The AI transport closes over the keep-alive editor instance; it must also
   *  know WHICH document it is bound to, so mention retrieval excludes the
   *  current file. The factory is the single place that passes that path. */
  it('passes the vault-relative file path and the live editor to createAiTransport', () => {
    const cached = createBlockEditor('/vault', 'notes/a.md')

    expect(captured.transports).toHaveLength(1)
    expect(captured.transports[0].filePath).toBe('notes/a.md')
    // getEditor resolves the SAME instance returned to the tab cache.
    expect(captured.transports[0].getEditor()).toBe(cached.editor)
  })
})

describe('createBlockEditor seeding', () => {
  beforeEach(() => {
    captured.parsed.length = 0
    captured.replaced = 0
  })

  /** The instance is created WITH its markdown so its first render is the note:
   *  an instance painted in BlockNote's default document shows its placeholder
   *  until the parse lands (see WysiwygEditorHost). */
  it('parses the markdown into a created instance and marks it loaded', () => {
    const cached = createBlockEditor('/vault', 'notes/a.md', '# Title')

    expect(captured.parsed).toEqual(['# Title'])
    expect(captured.replaced).toBe(1)
    expect(cached.loaded).toBe(true)
    expect(cached.loadedMarkdown).toBe('# Title')
  })

  it('leaves an instance unseeded when the caller has no markdown', () => {
    const cached = createBlockEditor('/vault', 'notes/a.md')

    expect(captured.parsed).toEqual([])
    expect(cached.loaded).toBe(false)
    expect(cached.loadedMarkdown).toBe(null)
  })
})

/** Regression: the per-vault cache keeps its `create` closure for the vault's
 *  whole lifetime, so a markdown captured there seeded EVERY later file with
 *  the first-opened note. The new tab painted the previous document and then
 *  re-parsed to its own — and that `replaceBlocks` rebuilds the math / code /
 *  mermaid blocks, flashing their raw source. Seeding now happens per lookup. */
describe('getCachedEditor seeding (per file)', () => {
  beforeEach(() => {
    clearEditorCache()
    captured.parsed.length = 0
    captured.replaced = 0
  })

  it('seeds each new file with its OWN markdown, never the first opened', () => {
    const a = getCachedEditor('/vault', 'notes/a.md', '# A')
    const b = getCachedEditor('/vault', 'notes/b.md', '# B')

    expect(a.loadedMarkdown).toBe('# A')
    expect(b.loadedMarkdown).toBe('# B')
    expect(captured.parsed).toEqual(['# A', '# B'])
  })

  it('does not re-seed (re-parse) an already-loaded hit on a tab switch', () => {
    const a = getCachedEditor('/vault', 'notes/a.md', '# A')
    getCachedEditor('/vault', 'notes/b.md', '# B')
    captured.parsed.length = 0

    const again = getCachedEditor('/vault', 'notes/a.md', '# A (ignored)')

    expect(again).toBe(a)
    expect(again.loadedMarkdown).toBe('# A')
    expect(captured.parsed).toEqual([])
  })
})

/** The WYSIWYG-only snapshot restores formatting Markdown cannot represent
 *  (colour/alignment/indent). It is applied ONLY while its stored markdown still
 *  matches the file; anything else falls back to the plain markdown parse. */
describe('createBlockEditor snapshot seeding', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', props: { textColor: 'yellow' }, content: [], children: [] }]

  beforeEach(() => {
    captured.parsed.length = 0
    captured.replaced = 0
    captured.replacedWith.length = 0
  })

  it('restores from a matching snapshot instead of parsing markdown', () => {
    const cached = createBlockEditor('/vault', 'notes/a.md', '# Title', { markdown: '# Title', blocks })

    expect(captured.parsed).toEqual([])
    expect(captured.replacedWith).toEqual([blocks])
    expect(cached.loaded).toBe(true)
    expect(cached.loadedMarkdown).toBe('# Title')
  })

  it('ignores a snapshot whose markdown no longer matches the file', () => {
    const cached = createBlockEditor('/vault', 'notes/a.md', '# Title', { markdown: '# OLD', blocks })

    expect(captured.parsed).toEqual(['# Title'])
    expect(captured.replacedWith).toEqual([['parsed-block']])
    expect(cached.loadedMarkdown).toBe('# Title')
  })

  it('falls back to parsing when the snapshot carries no blocks', () => {
    createBlockEditor('/vault', 'notes/a.md', '# Title', { markdown: '# Title', blocks: [] })

    expect(captured.parsed).toEqual(['# Title'])
  })
})

describe('getCachedEditor snapshot pass-through', () => {
  beforeEach(() => {
    clearEditorCache()
    captured.parsed.length = 0
    captured.replaced = 0
    captured.replacedWith.length = 0
  })

  it('seeds a cache miss from its snapshot', () => {
    const blocks = [{ id: 'b1', type: 'paragraph', props: { textColor: 'yellow' }, content: [], children: [] }]
    const a = getCachedEditor('/vault', 'notes/a.md', '# A', { markdown: '# A', blocks })

    expect(a.loadedMarkdown).toBe('# A')
    expect(captured.parsed).toEqual([])
    expect(captured.replacedWith).toEqual([blocks])
  })
})

describe('KeepAliveCache', () => {
  it('creates lazily and reuses the same entry per key', () => {
    const create = vi.fn((key: string) => ({ key, loaded: false }))
    const cache = new KeepAliveCache(create)

    const a1 = cache.get('notes/a.md')
    const a2 = cache.get('notes/a.md')
    const b = cache.get('notes/b.md')

    // Factory ran once per path, never twice for the same path.
    expect(create).toHaveBeenCalledTimes(2)
    expect(a2).toBe(a1)
    expect(b).not.toBe(a1)
    // load-once flag mutation on the entry is visible to later lookups
    // (the remount sees loaded:true and skips parsing).
    a1.loaded = true
    expect(cache.get('notes/a.md')).toBe(a1)
    expect(cache.get('notes/a.md').loaded).toBe(true)
  })

  it('reuses a falsy cached value instead of recreating it', () => {
    const create = vi.fn(() => 0)
    const cache = new KeepAliveCache(create)

    cache.get('zero')
    cache.get('zero')

    expect(create).toHaveBeenCalledOnce()
  })

  it('clear() drops all entries (vault switch: rel paths are vault-scoped)', () => {
    const create = vi.fn((key: string) => ({ key }))
    const cache = new KeepAliveCache(create)
    cache.get('a')
    cache.clear()
    cache.get('a')
    expect(create).toHaveBeenCalledTimes(2) // re-created after clear
  })

  /** peek() backs the flash-free tab switch: the host asks "is this file already
   *  open?" during render, which must never construct an editor as a side effect. */
  it('peek() reads without creating and returns null for a miss', () => {
    const create = vi.fn((key: string) => ({ key }))
    const cache = new KeepAliveCache(create)

    expect(cache.peek('missing')).toBeNull()
    const entry = cache.get('a')
    expect(cache.peek('a')).toBe(entry)
    expect(create).toHaveBeenCalledOnce()
  })
})