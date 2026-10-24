import { describe, expect, it } from 'vitest'
import { buildSetupPayload, validateSetupInput } from '../../../frontend/utils/setupWizard'
import { evaluatePassword, isPasswordValid, passwordError } from '../../../frontend/utils/passwordPolicy'

const valid = { email: 'a@b.c', password: 'Password1!', confirm: 'Password1!', token: '', tokenRequired: false }

describe('validateSetupInput (setup token gate)', () => {
  it('accepts valid input', () => {
    expect(validateSetupInput(valid)).toBeNull()
  })

  it('rejects invalid email', () => {
    expect(validateSetupInput({ ...valid, email: 'nope' })).toContain('valid email')
  })

  it('rejects short password', () => {
    expect(validateSetupInput({ ...valid, password: 'Ab1!', confirm: 'Ab1!' })).toContain('at least 8')
  })

  it('rejects a password without mixed case', () => {
    expect(validateSetupInput({ ...valid, password: 'password1!', confirm: 'password1!' })).toContain('upper and lower case')
  })

  it('rejects a password without numbers and special characters', () => {
    expect(validateSetupInput({ ...valid, password: 'Passwordd', confirm: 'Passwordd' })).toContain('numbers and special characters')
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

describe('password policy', () => {
  it('accepts a password meeting every rule', () => {
    expect(isPasswordValid('Password1!')).toBe(true)
    expect(passwordError('Password1!')).toBeNull()
  })

  it('reports each rule independently for the live checklist', () => {
    const results = evaluatePassword('abc')
    expect(results.map(r => r.id)).toEqual(['case', 'length', 'number-special'])
    expect(results.every(r => !r.met)).toBe(true)
  })

  it('marks rules as they become satisfied', () => {
    const met = Object.fromEntries(evaluatePassword('Abcdefg1').map(r => [r.id, r.met]))
    expect(met).toEqual({ case: true, length: true, 'number-special': false })
  })
})

describe('buildSetupPayload', () => {
  it('includes trimmed token only when required', () => {
    expect(buildSetupPayload('a@b.c', 'pw', '  tok  ', true)).toEqual({ email: 'a@b.c', password: 'pw', token: 'tok' })
    expect(buildSetupPayload('a@b.c', 'pw', '', false)).toEqual({ email: 'a@b.c', password: 'pw' })
  })
})
