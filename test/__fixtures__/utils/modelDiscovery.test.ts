import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../../frontend/lib/ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../../frontend/lib/ipc')>(),
  invoke,
}))

import { fetchProviderModels } from '../../../frontend/utils/modelDiscovery'

beforeEach(() => {
  invoke.mockReset()
})

describe('fetchProviderModels', () => {
  it('asks the provider every time instead of serving a cached list', async () => {
    invoke.mockResolvedValueOnce(JSON.stringify([{ id: 'old-model', name: 'Old' }]))
    invoke.mockResolvedValueOnce(JSON.stringify([{ id: 'new-model', name: 'New' }]))
    expect((await fetchProviderModels('deepseek', 'https://api.deepseek.com')).map(m => m.id)).toEqual(['old-model'])
    // The provider dropped a model and added another: the next open shows it.
    expect((await fetchProviderModels('deepseek', 'https://api.deepseek.com')).map(m => m.id)).toEqual(['new-model'])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps each provider\'s answer to itself', async () => {
    invoke.mockImplementation(async (_command: string, args: { provider: string }) =>
      JSON.stringify([{ id: `${args.provider}-model`, name: String(args.provider) }]))
    const [go, ds] = await Promise.all([
      fetchProviderModels('opencode-go', 'https://opencode.ai/zen/go/v1'),
      fetchProviderModels('deepseek', 'https://api.deepseek.com'),
    ])
    expect(go.map(m => m.id)).toEqual(['opencode-go-model'])
    expect(ds.map(m => m.id)).toEqual(['deepseek-model'])
  })

  it('drops duplicate ids the endpoint repeats', async () => {
    invoke.mockResolvedValueOnce(JSON.stringify([{ id: 'M', name: 'a' }, { id: 'm', name: 'b' }, { id: 'n', name: 'c' }]))
    expect((await fetchProviderModels('deepseek', '')).map(m => m.id)).toEqual(['M', 'n'])
  })
})
