import { beforeEach, describe, it, expect, vi } from 'vitest'

const captured = vi.hoisted(() => ({ transports: [] as any[] }))

// Constructing a real BlockNote editor headless (jsdom) throws — stub the whole
// dependency surface so the factory's WIRING (not the editor) is under test.
vi.mock('@blocknote/core', () => ({ BlockNoteEditor: { create: vi.fn(() => ({ __fakeEditor: true })) } }))
vi.mock('@blocknote/core/locales', () => ({ en: {} }))
vi.mock('@blocknote/math-block', () => ({ locales: { en: {} } }))
vi.mock('@blocknote/diagram-block', () => ({ locales: { en: {} } }))
vi.mock('@blocknote/xl-ai/locales', () => ({ en: {} }))
vi.mock('@blocknote/xl-ai', () => ({ AIExtension: vi.fn((options: any) => ({ options })) }))
vi.mock('../../../frontend/lib/ipc', () => ({
  fileUrl: vi.fn(async () => ''),
  isAbsoluteUrl: () => false,
  isSafeImageUrl: () => true,
}))
vi.mock('../../../frontend/components/editor/setup', () => ({ getSchema: () => ({}), wikilinkStyler: {} }))
vi.mock('../../../frontend/utils/aiTransport', () => ({
  createAiTransport: vi.fn((deps: any) => {
    captured.transports.push(deps)
    return {}
  }),
}))

import { KeepAliveCache, createBlockEditor } from '../../../frontend/utils/editorFactory'

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
   *  know WHICH document it is bound to, or thread history lands in the wrong
   *  chat. The factory is the single place that passes that path. */
  it('passes the vault-relative file path and the live editor to createAiTransport', () => {
    const cached = createBlockEditor('/vault', 'notes/a.md')

    expect(captured.transports).toHaveLength(1)
    expect(captured.transports[0].filePath).toBe('notes/a.md')
    // getEditor resolves the SAME instance returned to the tab cache.
    expect(captured.transports[0].getEditor()).toBe(cached.editor)
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
})