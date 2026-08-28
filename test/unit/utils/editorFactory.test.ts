import { describe, it, expect, vi } from 'vitest'
import { KeepAliveCache } from '../../../frontend/utils/keepAliveCache'

/** The keep-alive cache is the pure, testable core of tab switching: one
 *  entry per path, created lazily, reused on every later lookup. The BlockNote
 *  editor factory itself is NOT constructed here — creating an editor headless
 *  (jsdom) touches module-level SideMenu state and throws; the app only ever
 *  creates instances while mounted, and the instance-survival guarantee is
 *  provided by BlockNote's mount/unmount API (unmount detaches DOM only). */
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