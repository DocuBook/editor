import { describe, it, expect } from 'vitest'
import { resolveProbeModel, resolveRequestModel, isTextOnly, autoProbe } from '../../../frontend/utils/aiProbe'
import { CUSTOM_PROVIDER_ID } from '../../../frontend/stores/aiSettings'

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

describe('autoProbe', () => {
  it('skips when a probe already exists', async () => {
    let calls = 0
    const run = async () => { calls++; return { tools: true } }
    await autoProbe('p', 'm', { p: { m: true } }, () => {}, run)
    expect(calls).toBe(0)
  })
  it('probes and stores when missing', async () => {
    let stored: [string, string, boolean] | null = null
    await autoProbe('p', 'm', {}, (p, m, t) => { stored = [p, m, t] }, async () => ({ tools: false }))
    expect(stored).toEqual(['p', 'm', false])
  })
  it('silently ignores probe errors', async () => {
    await autoProbe('p', 'm', {}, () => {}, async () => { throw new Error('boom') })
    // no throw = pass
    expect(true).toBe(true)
  })
  it('ignores undefined result', async () => {
    let stored = false
    await autoProbe('p', 'm', {}, () => { stored = true }, async () => undefined)
    expect(stored).toBe(false)
  })
})
