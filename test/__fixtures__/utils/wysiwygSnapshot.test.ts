import { beforeEach, describe, it, expect, vi } from 'vitest'

/** The snapshot cache is a pure wrapper over two IPC commands; stub `invoke` so
 *  the guard (parse/shape/error handling) is what's under test, not the backend. */
vi.mock('../../../frontend/lib/ipc', () => ({ invoke: vi.fn().mockResolvedValue('') }))

import { invoke } from '../../../frontend/lib/ipc'
import { readWysiwygSnapshot, writeWysiwygSnapshot } from '../../../frontend/utils/wysiwygSnapshot'

describe('readWysiwygSnapshot', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockResolvedValue('')
  })

  it('parses a stored snapshot', async () => {
    vi.mocked(invoke).mockResolvedValue('{"markdown":"# A","blocks":[{"id":"b1"}]}')

    await expect(readWysiwygSnapshot('notes/a.md')).resolves.toEqual({
      markdown: '# A',
      blocks: [{ id: 'b1' }],
    })
    expect(invoke).toHaveBeenCalledWith('read_wysiwyg_snapshot', { path: 'notes/a.md' })
  })

  /** Absent snapshot = empty string from the backend = a cache miss, not an error. */
  it('returns null for an absent snapshot', async () => {
    await expect(readWysiwygSnapshot('notes/a.md')).resolves.toBeNull()
  })

  it('returns null for corrupt JSON instead of throwing', async () => {
    vi.mocked(invoke).mockResolvedValue('not json')
    await expect(readWysiwygSnapshot('notes/a.md')).resolves.toBeNull()
  })

  it('returns null when the payload has the wrong shape', async () => {
    vi.mocked(invoke).mockResolvedValue('{"markdown":"# A"}') // no blocks
    await expect(readWysiwygSnapshot('notes/a.md')).resolves.toBeNull()
  })

  /** A read failure must never fail opening a document — it degrades to no cache. */
  it('returns null when the read rejects', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('No vault'))
    await expect(readWysiwygSnapshot('notes/a.md')).resolves.toBeNull()
  })
})

describe('writeWysiwygSnapshot', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockResolvedValue('')
  })

  it('writes the markdown guard and the blocks', () => {
    writeWysiwygSnapshot('notes/a.md', '# A', [{ id: 'b1' }])

    expect(invoke).toHaveBeenCalledWith('write_wysiwyg_snapshot', {
      path: 'notes/a.md',
      content: JSON.stringify({ markdown: '# A', blocks: [{ id: 'b1' }] }),
    })
  })

  it('skips a non-serializable document instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => writeWysiwygSnapshot('notes/a.md', '# A', [circular])).not.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})
