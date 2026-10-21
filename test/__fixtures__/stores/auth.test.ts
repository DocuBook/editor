// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../../frontend/lib/ipc', () => ({ invoke, isTauri: false, listen: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { useAuth } from '../../../frontend/stores/auth'
import { useSyncStore, setSyncVaultScope } from '../../../frontend/stores/sync'
import { useEditorStore } from '../../../frontend/stores/editor'
import { useVaultStore } from '../../../frontend/stores/vault'

const persistedKeys = ['docubook:sync', 'docubook:editor-session', 'docubook:vault']

describe('auth initialization', () => {
  beforeEach(() => {
    invoke.mockReset()
    useAuth.setState({ status: 'checking', email: '' })
  })

  it('fails closed when setup status cannot be checked', async () => {
    invoke.mockRejectedValue(new Error('network'))

    await useAuth.getState().init()

    expect(useAuth.getState()).toMatchObject({ status: 'error', email: '' })
  })

  it('retries the full auth check after a server error', async () => {
    invoke
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(JSON.stringify({ setupRequired: false, setupToken: false }))
      .mockResolvedValueOnce(JSON.stringify({ email: 'admin@example.com' }))

    await useAuth.getState().init()
    await useAuth.getState().init()

    expect(invoke).toHaveBeenNthCalledWith(2, 'setup_status')
    expect(invoke).toHaveBeenNthCalledWith(3, 'account_get')
    expect(useAuth.getState()).toMatchObject({ status: 'ready', email: 'admin@example.com' })
  })
})

/** Regression: signing out must not leave the previous account's note bodies
 *  behind. The sync queue/conflicts persist full file contents to localStorage,
 *  so clearing only the in-memory stores would hand them to the next user. */
describe('logout cleanup', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue('')
    localStorage.clear()
    useAuth.setState({ status: 'ready', email: 'admin@example.com' })
    setSyncVaultScope('/vaults/secret')
    useSyncStore.getState().reset()
    useSyncStore.getState().enqueue({ path: 'private.md', content: 'TOP SECRET', baseVersion: null })
    useSyncStore.getState().addConflict({ path: 'private.md', mine: 'TOP SECRET', theirs: 'disk', theirsVersion: 'v1', baseContent: null })
    useVaultStore.setState({ name: 'secret', isOpen: true, vaultPath: '/vaults/secret', recent: [{ path: '/vaults/secret', name: 'secret', parent: '/vaults' }] })
    useEditorStore.setState({
      tabs: [{ path: 'private.md', name: 'private.md', content: 'TOP SECRET', frontmatter: '', editedContent: 'TOP SECRET', dirty: true, deleted: false }],
      activeTab: 'private.md',
    })
    for (const key of persistedKeys) localStorage.setItem(key, JSON.stringify({ state: { secret: true }, version: 0 }))
  })

  it('clears in-memory sync and editor state but keeps the vault selection', async () => {
    await useAuth.getState().logout()

    expect(useAuth.getState()).toMatchObject({ status: 'login', email: '' })
    expect(useSyncStore.getState().queue).toHaveLength(0)
    expect(useSyncStore.getState().conflicts).toHaveLength(0)
    expect(useSyncStore.getState().failures).toHaveLength(0)
    expect(useEditorStore.getState().tabs).toHaveLength(0)
    expect(useEditorStore.getState().activeTab).toBeNull()
    // The vault holds paths only (never note bodies) and is what the login
    // screen resumes, so it survives logout.
    expect(useVaultStore.getState()).toMatchObject({ isOpen: true, vaultPath: '/vaults/secret', name: 'secret' })
  })

  it('clears the persisted note-bearing copies but keeps the vault selection', async () => {
    await useAuth.getState().logout()

    for (const key of persistedKeys) {
      if (key === 'docubook:vault') continue
      expect(localStorage.getItem(key)).toBeNull()
    }
    expect(localStorage.getItem('docubook:vault')).not.toBeNull()
  })
})
