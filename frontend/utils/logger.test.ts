import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from './logger'

describe('frontend logger', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('redacts sensitive fields, secrets, and absolute paths and truncates strings', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    logger.error('save_failed', {
      apiKey: 'super-secret',
      error: `Bearer token-value at /Users/example/private.md ${'x'.repeat(400)}`,
      fileName: 'note.md',
    })

    const output = JSON.stringify(error.mock.calls)
    expect(output).toContain('[redacted]')
    expect(output).toContain('[path]')
    expect(output).toContain('note.md')
    expect(output).not.toContain('super-secret')
    expect(output).not.toContain('token-value')
    expect(output).not.toContain('/Users/example')
    expect(output.length).toBeLessThan(700)
  })
})
