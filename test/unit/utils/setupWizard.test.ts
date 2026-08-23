import { describe, expect, it } from 'vitest'
import { buildSetupPayload, validateSetupInput } from '../../../frontend/utils/setupWizard'

const valid = { email: 'a@b.c', password: 'password1', confirm: 'password1', token: '', tokenRequired: false }

describe('validateSetupInput (setup token gate)', () => {
  it('accepts valid input', () => {
    expect(validateSetupInput(valid)).toBeNull()
  })

  it('rejects invalid email', () => {
    expect(validateSetupInput({ ...valid, email: 'nope' })).toContain('valid email')
  })

  it('rejects short password', () => {
    expect(validateSetupInput({ ...valid, password: 'short' })).toContain('at least 8')
  })

  it('rejects mismatched confirm', () => {
    expect(validateSetupInput({ ...valid, confirm: 'other' })).toContain('do not match')
  })

  it('requires the setup token only when the server demands it', () => {
    expect(validateSetupInput({ ...valid, tokenRequired: true, token: '   ' })).toContain('Setup token is required')
    expect(validateSetupInput({ ...valid, tokenRequired: true, token: 'tok' })).toBeNull()
    // token not required → empty token is fine (backward compat)
    expect(validateSetupInput(valid)).toBeNull()
  })
})

describe('buildSetupPayload', () => {
  it('includes trimmed token only when required', () => {
    expect(buildSetupPayload('a@b.c', 'pw', '  tok  ', true)).toEqual({ email: 'a@b.c', password: 'pw', token: 'tok' })
    expect(buildSetupPayload('a@b.c', 'pw', '', false)).toEqual({ email: 'a@b.c', password: 'pw' })
  })
})
