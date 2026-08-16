import { describe, it, expect } from 'vitest'
import { resolveProbeModel, isTextOnly, autoProbe } from './aiProbe'
import { CUSTOM_PROVIDER_ID } from '../stores/aiSettings'

describe('resolveProbeModel', () => {
  it('env model wins for custom provider', () => {
    expect(resolveProbeModel(CUSTOM_PROVIDER_ID, 'ui-model', 'env-model')).toBe('env-model')
  })
  it('UI model used when no env model', () => {
    expect(resolveProbeModel(CUSTOM_PROVIDER_ID, 'ui-model')).toBe('ui-model')
    expect(resolveProbeModel('anthropic', 'claude-x')).toBe('claude-x')
  })
})

describe('isTextOnly', () => {
  it('custom provider: text-only until probed true', () => {
    expect(isTextOnly(CUSTOM_PROVIDER_ID, 'm', {}, true)).toBe(true)   // unmeasured → text-only
    expect(isTextOnly(CUSTOM_PROVIDER_ID, 'm', { [CUSTOM_PROVIDER_ID]: { m: true } }, true)).toBe(false)
    expect(isTextOnly(CUSTOM_PROVIDER_ID, 'm', { [CUSTOM_PROVIDER_ID]: { m: false } }, true)).toBe(true)
  })
  it('catalog provider: permissive unless measured false', () => {
    expect(isTextOnly('anthropic', 'm', {}, true)).toBe(false)          // unmeasured → tools
    expect(isTextOnly('anthropic', 'm', { anthropic: { m: false } }, true)).toBe(true) // measured no
    expect(isTextOnly('anthropic', 'm', { anthropic: { m: false } }, false)).toBe(false) // catalog no-tools + probe false → text-only (probe irrelevant)
  })
  it('probe keyed by resolved model', () => {
    // transport resolves env model, so probe must live under env-model
    const probeTools = { [CUSTOM_PROVIDER_ID]: { 'env-model': true } }
    expect(isTextOnly(CUSTOM_PROVIDER_ID, 'env-model', probeTools, true)).toBe(false)
    expect(isTextOnly(CUSTOM_PROVIDER_ID, 'ui-model', probeTools, true)).toBe(true)
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
