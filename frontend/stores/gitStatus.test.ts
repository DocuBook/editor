import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../lib/ipc', () => ({ invoke }))

import { pollGitStatus, useGitStatus } from './gitStatus'
import { useAuth } from './auth'

describe('pollGitStatus (skip polling while unauthenticated)', () => {
  beforeEach(() => {
    invoke.mockReset()
    useGitStatus.setState({ branch: '', status: '' })
    useAuth.setState({ status: 'login' })
  })

  it('skips the invoke while not authenticated — no 401 spam', async () => {
    await pollGitStatus()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('polls and updates state when authenticated', async () => {
    useAuth.setState({ status: 'ready' })
    invoke.mockResolvedValue(JSON.stringify({ branch: 'main', status: ' M file.md' }))
    await pollGitStatus()
    expect(invoke).toHaveBeenCalledWith('git_status')
    expect(useGitStatus.getState()).toEqual({ branch: 'main', status: ' M file.md' })
  })

  it('resets state when the poll fails', async () => {
    useAuth.setState({ status: 'ready' })
    useGitStatus.setState({ branch: 'main', status: 'X' })
    invoke.mockRejectedValue(new Error('network'))
    await pollGitStatus()
    expect(useGitStatus.getState()).toEqual({ branch: '', status: '' })
  })
})
