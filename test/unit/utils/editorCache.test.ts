import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearEditorCache, getEditorCache } from '../../../frontend/utils/editorCache'

afterEach(() => clearEditorCache())

describe('editorCache', () => {
  it('should_reuse_entry_when_the_same_path_is_requested_twice', () => {
    const create = vi.fn((path: string) => ({ path }))
    const cache = getEditorCache('vault-a', create)

    const first = cache.get('note.md')
    const second = cache.get('note.md')

    expect(second).toBe(first)
    expect(create).toHaveBeenCalledOnce()
  })

  it('should_isolate_relative_paths_when_the_vault_changes', () => {
    const createFirst = vi.fn((path: string) => ({ vault: 'a', path }))
    const first = getEditorCache('vault-a', createFirst).get('note.md')
    const createSecond = vi.fn((path: string) => ({ vault: 'b', path }))
    const second = getEditorCache('vault-b', createSecond).get('note.md')

    expect(second).not.toBe(first)
    expect(createFirst).toHaveBeenCalledOnce()
    expect(createSecond).toHaveBeenCalledOnce()
  })

  it('should_drop_entries_when_the_vault_scope_is_cleared', () => {
    const create = vi.fn((path: string) => ({ path }))
    const first = getEditorCache('vault-a', create).get('note.md')

    clearEditorCache()
    const second = getEditorCache('vault-a', create).get('note.md')

    expect(second).not.toBe(first)
    expect(create).toHaveBeenCalledTimes(2)
  })
})
