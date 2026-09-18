import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearEditorCache, getEditorCache, peekEditorCache } from '../../../frontend/utils/editorCache'
import { readCacheStats, resetCacheStats } from '../../../frontend/utils/cacheStats'

beforeEach(() => resetCacheStats())
afterEach(() => { clearEditorCache(); resetCacheStats() })

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

  /** The shared-cache invariant: opening a document from the sidebar, the search
   *  modal, a wikilink, the backlinks panel or the git panel all end at the same
   *  (vault, path) key, so they must all receive the SAME instance. */
  it('should_serve_one_instance_per_path_to_every_caller', () => {
    const fromSidebar = vi.fn((path: string) => ({ path, via: 'sidebar' }))
    const fromSearch = vi.fn((path: string) => ({ path, via: 'search' }))

    const opened = getEditorCache('vault-a', fromSidebar).get('notes/a.md')
    const searched = getEditorCache('vault-a', fromSearch).get('notes/a.md')

    expect(searched).toBe(opened)
    expect(fromSearch).not.toHaveBeenCalled()
  })

  /** The keep-alive cache is the one holding whole BlockNote instances, so its
   *  hit rate and entry count are what make "how many editors are we holding?"
   *  answerable from `__docubookCacheStats()`. */
  it('should_report_hits_misses_and_entries_for_the_editor_instances', () => {
    const cache = getEditorCache('vault-a', vi.fn((path: string) => ({ path })))

    cache.get('a.md')
    cache.get('a.md')
    cache.get('b.md')

    const stat = readCacheStats()['editor-instances']
    expect(stat.misses).toBe(2)
    expect(stat.hits).toBe(1)
    expect(stat.entries).toBe(2)
  })

  it('should_peek_without_creating_and_return_null_outside_the_cached_vault', () => {
    const create = vi.fn((path: string) => ({ path }))
    const cache = getEditorCache('vault-a', create)

    expect(peekEditorCache<{ path: string }>('vault-a', 'note.md')).toBeNull()

    const created = cache.get('note.md')
    expect(peekEditorCache<{ path: string }>('vault-a', 'note.md')).toBe(created)
    expect(peekEditorCache<{ path: string }>('vault-b', 'note.md')).toBeNull()
    expect(create).toHaveBeenCalledOnce()
  })
})
