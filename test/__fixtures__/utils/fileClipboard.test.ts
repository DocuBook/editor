import { describe, expect, it, vi } from 'vitest'

/** The copy state is module-level by design, so every test takes a fresh copy
 *  of the module instead of resetting shared state through a test-only hook. */
async function fresh() {
  vi.resetModules()
  return await import('../../../frontend/utils/fileClipboard')
}

const row = { path: 'notes/active.md', name: 'active.md', type: '0' }

describe('fileClipboard', () => {
  it('is empty until a row is copied', async () => {
    const clip = await fresh()

    expect(clip.hasCopiedItem('/vault')).toBe(false)
    expect(clip.peekCopiedItem('/vault')).toBeNull()
  })

  it('exposes the copied row to its own vault', async () => {
    const clip = await fresh()
    clip.copyItem(row, '/vault')

    expect(clip.hasCopiedItem('/vault')).toBe(true)
    expect(clip.peekCopiedItem('/vault')).toEqual({ ...row, vaultPath: '/vault' })
  })

  /** A path is relative, so in another vault the same string would resolve to
   *  an unrelated entry — Paste must not be offered there at all. */
  it('hides the copy from a different vault', async () => {
    const clip = await fresh()
    clip.copyItem(row, '/vault')

    expect(clip.hasCopiedItem('/other')).toBe(false)
    expect(clip.peekCopiedItem('/other')).toBeNull()
  })

  it('replaces the copy when another row is copied', async () => {
    const clip = await fresh()
    clip.copyItem(row, '/vault')
    clip.copyItem({ path: 'archive', name: 'archive', type: '1' }, '/vault')

    expect(clip.peekCopiedItem('/vault')).toEqual({ path: 'archive', name: 'archive', type: '1', vaultPath: '/vault' })
  })
})
