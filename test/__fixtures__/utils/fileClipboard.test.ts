import { describe, expect, it, vi } from 'vitest'

/** The clipboard is module-level by design, so every test takes a fresh copy of
 *  the module instead of resetting shared state through a test-only hook. */
async function fresh() {
  vi.resetModules()
  return await import('../../../frontend/utils/fileClipboard')
}

const row = { path: 'notes/active.md', name: 'active.md', type: '0' }

describe('fileClipboard', () => {
  it('is empty until a row is copied or cut', async () => {
    const clip = await fresh()

    expect(clip.hasClipboardItem('/vault')).toBe(false)
    expect(clip.peekClipboardItem('/vault')).toBeNull()
  })

  it('exposes a copied row to its own vault', async () => {
    const clip = await fresh()
    clip.copyItem(row, '/vault')

    expect(clip.hasClipboardItem('/vault')).toBe(true)
    expect(clip.peekClipboardItem('/vault')).toEqual({ ...row, mode: 'copy', vaultPath: '/vault' })
  })

  /** A cut is a move intent: the row is still pastable, but the mode tells the
   *  paste to move rather than duplicate it. */
  it('marks a cut row with the cut mode', async () => {
    const clip = await fresh()
    clip.cutItem(row, '/vault')

    expect(clip.peekClipboardItem('/vault')).toMatchObject({ path: 'notes/active.md', mode: 'cut' })
  })

  it('drops the entry when it is cleared', async () => {
    const clip = await fresh()
    clip.cutItem(row, '/vault')

    clip.clearClipboardItem()

    expect(clip.hasClipboardItem('/vault')).toBe(false)
    expect(clip.peekClipboardItem('/vault')).toBeNull()
  })

  /** A path is relative, so in another vault the same string would resolve to
   *  an unrelated entry — Paste must not be offered there at all. */
  it('hides the entry from a different vault', async () => {
    const clip = await fresh()
    clip.copyItem(row, '/vault')

    expect(clip.hasClipboardItem('/other')).toBe(false)
    expect(clip.peekClipboardItem('/other')).toBeNull()
  })

  it('replaces the entry when another row is taken', async () => {
    const clip = await fresh()
    clip.copyItem(row, '/vault')
    clip.cutItem({ path: 'archive', name: 'archive', type: '1' }, '/vault')

    expect(clip.peekClipboardItem('/vault')).toEqual({ path: 'archive', name: 'archive', type: '1', mode: 'cut', vaultPath: '/vault' })
  })
})
