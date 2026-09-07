import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../../frontend/lib/ipc', () => ({ invoke, isTauri: false, listen: vi.fn() }))

import { useAuth } from '../../../frontend/stores/auth'

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
