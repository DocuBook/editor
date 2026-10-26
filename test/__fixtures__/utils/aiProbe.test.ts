import { beforeEach, describe, it, expect, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../../frontend/lib/ipc', async importOriginal => ({
  ...await importOriginal<typeof import('../../../frontend/lib/ipc')>(),
  invoke,
}))

import { resolveProbeModel, resolveRequestModel, isTextOnly, ensureToolProbe, parseProbeResult, resetToolProbeBackoff } from '../../../frontend/utils/aiProbe'
import { CUSTOM_PROVIDER_ID, useAiSettings } from '../../../frontend/stores/aiSettings'

describe('resolveProbeModel', () => {
  it('env model wins for custom provider', () => {
    expect(resolveProbeModel(CUSTOM_PROVIDER_ID, 'ui-model', 'env-model')).toBe('env-model')
  })
  it('UI model used when no env model', () => {
    expect(resolveProbeModel(CUSTOM_PROVIDER_ID, 'ui-model')).toBe('ui-model')
    expect(resolveProbeModel('opencode-go', 'deepseek-v4-flash')).toBe('deepseek-v4-flash')
  })
})

describe('resolveRequestModel', () => {
  it('uses env model only for custom env endpoints', () => {
    expect(resolveRequestModel(CUSTOM_PROVIDER_ID, 'saved-model', 'env-model')).toBe('env-model')
    expect(resolveRequestModel('opencode-go', 'deepseek-v4-flash', 'env-model')).toBe('deepseek-v4-flash')
  })
  it('keeps saved model when env config is absent or empty', () => {
    expect(resolveRequestModel(CUSTOM_PROVIDER_ID, 'saved-model')).toBe('saved-model')
    expect(resolveRequestModel(CUSTOM_PROVIDER_ID, 'saved-model', '')).toBe('saved-model')
  })
})

describe('isTextOnly', () => {
  it('text-only until probed true — same rule for every provider', () => {
    expect(isTextOnly(CUSTOM_PROVIDER_ID, 'm', {})).toBe(true)   // unmeasured → text-only
    expect(isTextOnly('opencode-go', 'm', {})).toBe(true)          // catalog unmeasured → text-only too
    expect(isTextOnly('opencode-go', 'm', { 'opencode-go': { m: true } })).toBe(false)
    expect(isTextOnly('opencode-go', 'm', { 'opencode-go': { m: false } })).toBe(true)
  })
  it('probe keyed by resolved model', () => {
    // transport resolves env model, so probe must live under env-model
    const probeTools = { [CUSTOM_PROVIDER_ID]: { 'env-model': true } }
    expect(isTextOnly(CUSTOM_PROVIDER_ID, 'env-model', probeTools)).toBe(false)
    expect(isTextOnly(CUSTOM_PROVIDER_ID, 'ui-model', probeTools)).toBe(true)
  })
  it('treats a missing model as text-only rather than defaulting to tools', () => {
    // Settings renders before a model is resolved; claiming tool support while the
    // transport withholds tools is the mismatch the shared badge rule guards.
    expect(isTextOnly('opencode-go', '', { 'opencode-go': { m: true } })).toBe(true)
  })
  it('is the single rule the badge and transport must share', () => {
    // probe true is the ONLY state that enables tools — catalog providers and
    // custom endpoints alike, so a badge reading this helper cannot disagree.
    const probeTools = { 'opencode-go': { good: true, bad: false } }
    expect(isTextOnly('opencode-go', 'good', probeTools)).toBe(false)
    expect(isTextOnly('opencode-go', 'bad', probeTools)).toBe(true)
    expect(isTextOnly('opencode-go', 'unmeasured', probeTools)).toBe(true)
  })
})

describe('parseProbeResult', () => {
  it('reads a measured result and treats anything else as inconclusive', () => {
    expect(parseProbeResult('{"status":"ok","tools":true}')).toBe(true)
    expect(parseProbeResult('{"status":"ok","tools":false}')).toBe(false)
    // Rate limit / outage on the tool request: not a measurement.
    expect(parseProbeResult('{"status":"ok","tools":null}')).toBeUndefined()
    expect(parseProbeResult('not json')).toBeUndefined()
  })
})

describe('ensureToolProbe', () => {
  beforeEach(() => {
    invoke.mockReset()
    resetToolProbeBackoff()
    useAiSettings.setState({ savedProviders: ['p'], probeTools: {} })
  })

  it('returns a stored probe without a request', async () => {
    useAiSettings.setState({ probeTools: { p: { m: false } } })
    await expect(ensureToolProbe('p', 'm')).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('probes once with the backend key and endpoint, then stores the result', async () => {
    let finish!: (value: string) => void
    invoke.mockImplementation(async (command: string) => command === 'test_connection'
      ? new Promise<string>(resolve => { finish = resolve })
      : null)
    // Composer pick, Settings form and transport ask at the same time.
    const results = Promise.all([ensureToolProbe('p', 'm'), ensureToolProbe('p', 'm'), ensureToolProbe('p', 'm')])
    await Promise.resolve()
    finish('{"status":"ok","tools":true}')
    expect(await results).toEqual([true, true, true])
    const probes = invoke.mock.calls.filter(call => call[0] === 'test_connection')
    expect(probes).toEqual([['test_connection', { provider: 'p', model: 'm', baseUrl: '', apiKey: '' }]])
    expect(invoke).toHaveBeenCalledWith('set_probe', { provider: 'p', model: 'm', tools: true })
    expect(useAiSettings.getState().probeTools.p.m).toBe(true)
  })

  it('stores nothing when the probe is inconclusive or fails, so it is retried later', async () => {
    invoke.mockResolvedValueOnce('{"status":"ok","tools":null}')
    await expect(ensureToolProbe('p', 'm')).resolves.toBeUndefined()
    invoke.mockRejectedValueOnce(new Error('offline'))
    await expect(ensureToolProbe('p', 'other')).resolves.toBeUndefined()
    expect(useAiSettings.getState().probeTools.p).toBeUndefined()
    expect(invoke.mock.calls.map(call => call[0])).not.toContain('set_probe')
  })

  it('backs off a failing pair instead of probing it on every prompt', async () => {
    vi.useFakeTimers()
    try {
      invoke.mockResolvedValue('{"status":"ok","tools":null}')
      await ensureToolProbe('p', 'm')
      await ensureToolProbe('p', 'm')
      expect(invoke).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(61_000)
      invoke.mockResolvedValue('{"status":"ok","tools":true}')
      await expect(ensureToolProbe('p', 'm')).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not probe a provider without a saved key', async () => {
    await expect(ensureToolProbe('other', 'm')).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('drops a result that lands after the provider was revoked', async () => {
    let finish!: (value: string) => void
    invoke.mockImplementation(async (command: string) => command === 'test_connection'
      ? new Promise<string>(resolve => { finish = resolve })
      : null)
    const pending = ensureToolProbe('p', 'm')
    await Promise.resolve()
    useAiSettings.getState().forgetProvider('p')
    finish('{"status":"ok","tools":true}')
    await pending
    expect(useAiSettings.getState().probeTools.p).toBeUndefined()
    expect(invoke.mock.calls.map(call => call[0])).not.toContain('set_probe')
  })
})
